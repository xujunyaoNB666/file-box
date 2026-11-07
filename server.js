'use strict';

/**
 * FileBox - 单用户/单管理员的私有文件下载站
 *
 * 环境变量:
 *   PORT              监听端口，默认 3000
 *   DATA_DIR          文件存储目录，默认 ./storage
 *   ADMIN_USER        登录用户名（默认 xujunyao）
 *   ADMIN_PASSWORD    登录密码（默认 shenye128，务必用环境变量覆盖）
 *   SESSION_SECRET    会话签名密钥（不设置则每次启动随机生成，重启后需重新登录）
 *   SESSION_TTL_HOURS 会话有效期小时数，默认 12
 *   MAX_UPLOAD_MB     单文件上限 MB，默认 512
 *   COOKIE_SECURE     true 时给 Cookie 加 Secure（https 部署建议开启）
 */

const express = require('express');
const busboy = require('busboy');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'storage'));
const TMP_DIR = path.join(DATA_DIR, '.tmp');
const ADMIN_USER = process.env.ADMIN_USER || 'xujunyao';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shenye128';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12)) * 3600 * 1000;
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 512)) * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;
const COOKIE_NAME = 'fb_session';
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true';

if (!process.env.SESSION_SECRET) {
  console.warn('[warn] 未设置 SESSION_SECRET，已使用随机密钥，重启后所有会话失效。');
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[warn] 正在使用内置默认密码，请通过 ADMIN_PASSWORD 环境变量覆盖。');
}

/* ---------------------------------------------------------------- 工具函数 */

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/* 已吊销的会话 ID，退出登录后旧令牌立即失效 */
const revokedSids = new Map();

function revokeSession(sid, exp) {
  if (!sid) return;
  revokedSids.set(sid, exp);
}

function isRevoked(sid) {
  const exp = revokedSids.get(sid);
  if (!exp) return false;
  if (exp < Date.now()) {
    revokedSids.delete(sid);
    return false;
  }
  return true;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (payload.u !== ADMIN_USER) return null;
  if (isRevoked(payload.sid)) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function setSessionCookie(res, token, maxAgeMs) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (SECURE_COOKIE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (SECURE_COOKIE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/** 只允许 DATA_DIR 下的一级文件名，拒绝任何路径穿越 */
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const base = path.basename(raw.replace(/\\/g, '/')).normalize('NFC');
  let name = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/["<>|:*?]/g, '_').trim();
  while (name.startsWith('.') || name.startsWith(' ')) name = name.slice(1);
  while (name.endsWith(' ') || name.endsWith('.')) name = name.slice(0, -1);
  if (!name || name === '.' || name === '..') return null;
  if (Buffer.byteLength(name, 'utf8') > 200) {
    const ext = path.extname(name).slice(0, 20);
    const stem = name.slice(0, name.length - ext.length);
    let cut = stem;
    while (Buffer.byteLength(cut + ext, 'utf8') > 200) cut = cut.slice(0, -1);
    name = cut + ext;
  }
  return name || null;
}

function toId(name) {
  return Buffer.from(name, 'utf8').toString('base64url');
}

function fromId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(id)) return null;
  try {
    const name = Buffer.from(id, 'base64url').toString('utf8');
    return normalizeName(name) === name ? name : null;
  } catch {
    return null;
  }
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function uniqueName(name) {
  if (!(await pathExists(path.join(DATA_DIR, name)))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await pathExists(path.join(DATA_DIR, candidate)))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/* ---------------------------------------------------------------- 登录限流 */

const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 5;

function rateState(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) return { fails: 0, resetAt: now + RATE_WINDOW_MS, blockedUntil: 0 };
  return entry;
}

function recordFailure(ip) {
  const state = rateState(ip);
  state.fails += 1;
  if (state.fails >= RATE_MAX_FAILS) state.blockedUntil = Date.now() + RATE_WINDOW_MS;
  loginAttempts.set(ip, state);
  return state;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt < now && entry.blockedUntil < now) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* ---------------------------------------------------------------- 应用初始化 */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

function authUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  next();
}

/** 修改类请求校验来源，配合 SameSite=Lax 抵御 CSRF */
function sameOrigin(req, res, next) {
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch {
    /* 非法 Origin，走向拒绝 */
  }
  return res.status(403).json({ error: '请求来源校验失败' });
}

app.use('/api', express.json({ limit: '8kb' }));

/* ---------------------------------------------------------------- 接口 */

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/api/session', (req, res) => {
  const user = authUser(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    authenticated: Boolean(user),
    user: user ? user.u : null,
    maxUploadMb: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)),
  });
});

app.post('/api/login', sameOrigin, (req, res) => {
  const ip = req.ip || 'unknown';
  const state = rateState(ip);
  if (state.blockedUntil > Date.now()) {
    const seconds = Math.ceil((state.blockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `尝试次数过多，请 ${seconds} 秒后再试` });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const ok = safeEqual(username.trim(), ADMIN_USER) & safeEqual(password, ADMIN_PASSWORD);

  if (!ok) {
    recordFailure(ip);
    const left = Math.max(0, RATE_MAX_FAILS - rateState(ip).fails);
    return res.status(401).json({ error: '用户名或密码错误', remaining: left });
  }

  loginAttempts.delete(ip);
  const sid = crypto.randomBytes(16).toString('hex');
  const token = signToken({ u: ADMIN_USER, sid, exp: Date.now() + SESSION_TTL });
  setSessionCookie(res, token, SESSION_TTL);
  return res.json({ ok: true, user: ADMIN_USER });
});

app.post('/api/logout', sameOrigin, (req, res) => {
  const user = authUser(req);
  if (user) revokeSession(user.sid, user.exp);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/files', requireAuth, async (req, res, next) => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
    const files = [];
    let totalSize = 0;

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const full = path.join(DATA_DIR, entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      totalSize += stat.size;
      files.push({
        id: toId(entry.name),
        name: entry.name,
        size: stat.size,
        uploadedAt: stat.mtimeMs,
      });
    }

    files.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ files, count: files.length, totalSize, maxUploadMb: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', requireAuth, sameOrigin, (req, res) => {
  let bus;
  try {
    bus = busboy({
      headers: req.headers,
      // 浏览器上传时文件名按 UTF-8 原始字节传输，busboy 默认按 latin1 解码会变成乱码
      defParamCharset: 'utf8',
      preservePath: false,
      limits: { files: MAX_FILES_PER_REQUEST, fileSize: MAX_UPLOAD_BYTES },
    });
  } catch {
    return res.status(400).json({ error: '上传请求格式不正确' });
  }

  const saved = [];
  const failed = [];
  const pending = [];
  let finished = false;

  const cleanup = () => {
    for (const p of pending) fsp.unlink(p).catch(() => {});
  };

  bus.on('file', (field, stream, info) => {
    const rawName = info && info.filename;
    const name = normalizeName(rawName);
    if (!name) {
      stream.resume();
      failed.push({ name: rawName || '(未命名)', reason: '文件名不合法' });
      return;
    }

    const tmpPath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    pending.push(tmpPath);
    const job = new Promise((resolve) => {
      const out = fs.createWriteStream(tmpPath);
      let exceeded = false;

      stream.on('limit', () => {
        exceeded = true;
      });
      stream.on('error', () => {
        out.destroy();
        fsp.unlink(tmpPath).catch(() => {});
        failed.push({ name, reason: '读取上传内容失败' });
        resolve();
      });
      out.on('error', () => {
        fsp.unlink(tmpPath).catch(() => {});
        failed.push({ name, reason: '写入磁盘失败' });
        resolve();
      });
      out.on('close', async () => {
        const idx = pending.indexOf(tmpPath);
        if (idx >= 0) pending.splice(idx, 1);
        if (exceeded) {
          await fsp.unlink(tmpPath).catch(() => {});
          failed.push({ name, reason: `超过单文件 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB 限制` });
          return resolve();
        }
        try {
          const finalName = await uniqueName(name);
          const finalPath = path.join(DATA_DIR, finalName);
          await fsp.rename(tmpPath, finalPath);
          const stat = await fsp.stat(finalPath);
          saved.push({ id: toId(finalName), name: finalName, size: stat.size, uploadedAt: stat.mtimeMs });
          resolve();
        } catch {
          await fsp.unlink(tmpPath).catch(() => {});
          failed.push({ name, reason: '保存文件失败' });
          resolve();
        }
      });

      stream.pipe(out);
    });

    pendingJobs.add(job);
    job.finally(() => pendingJobs.delete(job));
  });

  const pendingJobs = new Set();

  bus.on('error', () => {
    if (!finished) {
      finished = true;
      cleanup();
      res.status(400).json({ error: '上传过程出错' });
    }
  });

  bus.on('finish', async () => {
    await Promise.all([...pendingJobs]);
    if (finished) return;
    finished = true;
    res.status(200).json({ saved, failed });
  });

  req.on('aborted', () => {
    cleanup();
    finished = true;
  });

  req.pipe(bus);
});

app.delete('/api/files/:id', requireAuth, sameOrigin, async (req, res) => {
  const name = fromId(req.params.id);
  if (!name) return res.status(400).json({ error: '文件不存在' });
  const full = path.join(DATA_DIR, name);
  try {
    await fsp.unlink(full);
    res.json({ ok: true, name });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: '文件不存在' });
    res.status(500).json({ error: '删除失败' });
  }
});

app.get('/api/files/:id/download', requireAuth, async (req, res) => {
  const name = fromId(req.params.id);
  if (!name) return res.status(404).json({ error: '文件不存在' });
  const full = path.join(DATA_DIR, name);
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat || !stat.isFile()) return res.status(404).json({ error: '文件不存在' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: '文件读取失败' });
    }
  });
});

/* ---------------------------------------------------------------- 静态页面 */

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    etag: true,
    maxAge: process.env.STATIC_MAX_AGE || 0,
  })
);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

/* ---------------------------------------------------------------- 启动 */

(async () => {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  // 清掉上次进程残留的临时文件
  for (const f of await fsp.readdir(TMP_DIR).catch(() => [])) {
    fsp.unlink(path.join(TMP_DIR, f)).catch(() => {});
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`FileBox 已启动: http://${HOST}:${PORT}`);
    console.log(`存储目录: ${DATA_DIR}`);
    console.log(`管理员: ${ADMIN_USER}`);
  });

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

module.exports = app;
