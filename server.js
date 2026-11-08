'use strict';

/**
 * FileBox - 多账号私有文件站（管理员 + 注册用户，各自独立空间）
 *
 * 环境变量:
 *   PORT              监听端口，默认 3000
 *   HOST              监听地址，默认 0.0.0.0
 *   DATA_DIR          文件存储根目录，默认 ./storage（每个账号一个子目录）
 *   USERS_FILE        账号与设置存储文件，默认 DATA_DIR/.users.json
 *   ADMIN_USER        初始管理员用户名（仅首次启动创建时使用）
 *   ADMIN_PASSWORD    初始管理员密码（仅首次启动创建时使用）
 *   SESSION_SECRET    会话签名密钥（不设置则每次启动随机生成，重启后需重新登录）
 *   SESSION_TTL_HOURS 会话有效期小时数，默认 12
 *   MAX_UPLOAD_MB     单文件上限 MB，默认 512
 *   COOKIE_SECURE     true 时给 Cookie 加 Secure（https 部署建议开启）
 *   DATA_DIR 说明：账号数据以明文文件名存放在 DATA_DIR/<用户名>/ 下
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
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIR, '.users.json');
const ADMIN_USER = (process.env.ADMIN_USER || 'xujunyao').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shenye128';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12)) * 3600 * 1000;
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 512)) * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;
const COOKIE_NAME = 'fb_session';
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true';
const MIN_PASSWORD_LEN = 6;
/* 管理员二级密码：只有管理员账号有，用于「授予管理员」这类高危操作 */
const ADMIN_SECOND_PASSWORD = process.env.ADMIN_SECOND_PASSWORD || 'xujunyaoNB666';
const MIN_SECOND_LEN = 6;
/* 登录失败 5 次锁定 30 秒（按来源 IP 计） */
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = Math.max(1, Number(process.env.LOGIN_LOCK_SECONDS || 30)) * 1000;
const RESERVED_NAMES = new Set(['admin', 'root', 'system', 'filebox']);

if (!process.env.SESSION_SECRET) {
  console.warn('[warn] 未设置 SESSION_SECRET，已使用随机密钥，重启后所有会话失效。');
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[warn] 正在使用内置默认密码，请通过 ADMIN_PASSWORD 环境变量覆盖。');
}

/* ---------------------------------------------------------------- 账号存储 */

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

let store = { settings: { allowRegister: false }, users: [] };
let storeReady = false;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function checkPassword(user, password) {
  if (!user || typeof password !== 'string') return false;
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeUser(username, password, role) {
  const { salt, hash } = hashPassword(password);
  return { username, salt, hash, role, pv: 0, createdAt: Date.now() };
}

/* ---------------------------------------------------------- 管理员二级密码 */

function setSecondPassword(user, code) {
  const fresh = hashPassword(code);
  user.codeSalt = fresh.salt;
  user.codeHash = fresh.hash;
}

function checkSecondPassword(user, code) {
  if (!user || !user.codeSalt || !user.codeHash || typeof code !== 'string') return false;
  const { hash } = hashPassword(code, user.codeSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.codeHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ 登录失败锁定 */

const loginFails = new Map();

function lockSecondsLeft(ip) {
  const entry = loginFails.get(ip);
  if (!entry) return 0;
  const left = Math.ceil((entry.until - Date.now()) / 1000);
  if (left > 0) return left;
  if (entry.until) loginFails.delete(ip);
  return 0;
}

function noteLoginFail(ip) {
  const entry = loginFails.get(ip) || { fails: 0, until: 0 };
  entry.fails += 1;
  if (entry.fails >= LOGIN_MAX_FAILS) {
    entry.fails = 0;
    entry.until = Date.now() + LOGIN_LOCK_MS;
  }
  loginFails.set(ip, entry);
}

function clearLoginFails(ip) {
  loginFails.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginFails) {
    if (entry.until && entry.until <= now) loginFails.delete(ip);
  }
}, 60 * 1000).unref();

async function saveStore() {
  const payload = JSON.stringify(store, null, 2);
  const tmp = `${USERS_FILE}.tmp`;
  await fsp.writeFile(tmp, payload, { mode: 0o600 });
  await fsp.rename(tmp, USERS_FILE);
}

async function loadStore() {
  await fsp.mkdir(path.dirname(USERS_FILE), { recursive: true });
  let raw = null;
  try {
    raw = await fsp.readFile(USERS_FILE, 'utf8');
  } catch {
    raw = null;
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      store = {
        settings: { allowRegister: Boolean(parsed.settings && parsed.settings.allowRegister) },
        users: Array.isArray(parsed.users) ? parsed.users : [],
      };
    } catch {
      console.warn('[warn] 账号文件解析失败，已按初始配置重建。');
      store = { settings: { allowRegister: false }, users: [] };
    }
  }

  if (!store.users.length) {
    store.users.push(makeUser(ADMIN_USER, ADMIN_PASSWORD, 'admin'));
    console.log(`[init] 已创建初始管理员账号: ${ADMIN_USER}`);
  }
  if (!store.users.some((u) => u.role === 'admin')) {
    store.users[0].role = 'admin';
  }
  /* 主管理员首次启动时给一个二级密码；之后只能在后台用旧二级密码换掉 */
  for (const u of store.users) {
    if (u.role === 'admin' && u.username === ADMIN_USER && !u.codeSalt) {
      setSecondPassword(u, ADMIN_SECOND_PASSWORD);
      console.log(`[init] 已为主管理员 ${ADMIN_USER} 设置初始二级密码。`);
    }
  }
  await saveStore();
  storeReady = true;
}

function findUser(username) {
  if (typeof username !== 'string') return null;
  const key = username.trim().toLowerCase();
  return store.users.find((u) => u.username === key) || null;
}

/* ---------------------------------------------------------------- 工具函数 */

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/* 已吊销的会话 ID，退出登录 / 改密码后旧令牌立即失效 */
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
  if (isRevoked(payload.sid)) return null;
  const account = findUser(payload.u);
  if (!account) return null;
  // 改密码会把 pv 加一，旧令牌全部失效
  if (Number(payload.pv) !== Number(account.pv || 0)) return null;
  payload.role = account.role;
  payload.account = account;
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

/** 只允许单级文件名，拒绝任何路径穿越 */
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

/** 文件 id = base64url("<用户名>/<文件名>")，天然带上归属信息 */
function toId(owner, name) {
  return Buffer.from(`${owner}/${name}`, 'utf8').toString('base64url');
}

function fromId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(id)) return null;
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const idx = raw.indexOf('/');
    if (idx <= 0) return null;
    const owner = raw.slice(0, idx);
    const name = raw.slice(idx + 1);
    if (!USERNAME_RE.test(owner)) return null;
    if (normalizeName(name) !== name) return null;
    return { owner, name };
  } catch {
    return null;
  }
}

function userDir(username) {
  return path.join(DATA_DIR, username);
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

async function uniqueName(username, name) {
  const dir = userDir(username);
  if (!(await pathExists(path.join(dir, name)))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await pathExists(path.join(dir, candidate)))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/* ---------------------------------------------------------------- 登录限流 */

/* 忘记密码用的重置码 */
const RESET_CODE_TTL = 30 * 60 * 1000;
const RESET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeResetCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += RESET_CODE_ALPHABET[bytes[i] % RESET_CODE_ALPHABET.length];
  return code;
}

function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.replace(/[\s-]/g, '').toUpperCase() : '';
}

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
  if (!storeReady) return null;
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  req.account = user.account;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.account || req.account.role !== 'admin') {
    return res.status(403).json({ error: '只有管理员可以执行这个操作' });
  }
  next();
}

/** 主管理员（ADMIN_USER）：允许它改动其他管理员账号 */
function isPrimaryAdmin(account) {
  return Boolean(account && account.role === 'admin' && account.username === ADMIN_USER);
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

function issueSession(res, account) {
  const sid = crypto.randomBytes(16).toString('hex');
  const token = signToken({
    u: account.username,
    sid,
    pv: Number(account.pv || 0),
    exp: Date.now() + SESSION_TTL,
  });
  setSessionCookie(res, token, SESSION_TTL);
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
    user: user ? user.account.username : null,
    role: user ? user.account.role : null,
    allowRegister: Boolean(store.settings.allowRegister),
    maxUploadMb: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)),
    minPasswordLen: MIN_PASSWORD_LEN,
    minSecondLen: MIN_SECOND_LEN,
    hasSecondPassword: Boolean(user && user.account.codeSalt),
    primaryAdmin: ADMIN_USER,
  });
});

app.post('/api/login', sameOrigin, (req, res) => {
  const ip = req.ip || 'unknown';
  const waitSeconds = lockSecondsLeft(ip);
  if (waitSeconds > 0) {
    return res.status(429).json({ error: `密码输错次数过多，请 ${waitSeconds} 秒后再试` });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const account = findUser(username);

  if (!account || !checkPassword(account, password)) {
    noteLoginFail(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  clearLoginFails(ip);
  issueSession(res, account);
  return res.json({ ok: true, user: account.username, role: account.role });
});

app.post('/api/register', sameOrigin, async (req, res, next) => {
  try {
    if (!store.settings.allowRegister) {
      return res.status(403).json({ error: '管理员还没有开放注册' });
    }

    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!USERNAME_RE.test(username) || RESERVED_NAMES.has(username)) {
      return res.status(400).json({ error: '账号只能是 2-24 位字母、数字、下划线或短横线' });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    if (findUser(username)) {
      return res.status(409).json({ error: '这个账号已经被注册了' });
    }

    const account = makeUser(username, password, 'user');
    store.users.push(account);
    await saveStore();
    await fsp.mkdir(userDir(username), { recursive: true });
    issueSession(res, account);
    return res.json({ ok: true, user: account.username, role: account.role });
  } catch (err) {
    next(err);
  }
});

app.post('/api/logout', sameOrigin, (req, res) => {
  const user = authUser(req);
  if (user) revokeSession(user.sid, user.exp);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ------------------------------------------------------- 账号自助（改密码） */

/** 任意已登录账号自己改密码：立即生效，旧会话全部失效，当前这次重新签发 */
app.post('/api/password', requireAuth, sameOrigin, async (req, res, next) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }

    const account = req.account;
    const fresh = hashPassword(password);
    account.salt = fresh.salt;
    account.hash = fresh.hash;
    account.pv = Number(account.pv || 0) + 1;
    account.resetCode = null;
    account.resetExpires = 0;
    await saveStore();

    issueSession(res, account);
    return res.json({ ok: true, user: account.username });
  } catch (err) {
    next(err);
  }
});

/**
 * 忘记密码：管理员在后台为某个普通账号生成一次性重置码，
 * 用户在登录页输入「账号 + 重置码 + 新密码」自助重置。
 * 管理员账号不支持这条路径（它自己登录后在后台改即可）。
 */
app.post('/api/forgot/reset', sameOrigin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const code = normalizeCode(req.body?.code);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `新密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    if (!USERNAME_RE.test(username) || !code) {
      return res.status(400).json({ error: '重置码无效或已过期，请找管理员重新生成' });
    }

    const account = findUser(username);
    if (!account) {
      return res.status(400).json({ error: '重置码无效或已过期，请找管理员重新生成' });
    }
    if (account.role === 'admin') {
      return res.status(403).json({ error: '管理员账号不支持自助重置，请登录后在「管理」里改密码' });
    }
    if (
      !account.resetCode ||
      !account.resetExpires ||
      Number(account.resetExpires) < Date.now() ||
      normalizeCode(account.resetCode) !== code
    ) {
      return res.status(400).json({ error: '重置码无效或已过期，请找管理员重新生成' });
    }

    const fresh = hashPassword(password);
    account.salt = fresh.salt;
    account.hash = fresh.hash;
    account.pv = Number(account.pv || 0) + 1;
    account.resetCode = null;
    account.resetExpires = 0;
    await saveStore();

    return res.json({ ok: true, user: account.username });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------- 管理员（后台开关） */

app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = [];
    for (const u of store.users) {
      const entries = await fsp.readdir(userDir(u.username), { withFileTypes: true }).catch(() => []);
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).length;
      users.push({
        username: u.username,
        role: u.role,
        createdAt: u.createdAt || 0,
        files,
        hasSecondPassword: Boolean(u.codeSalt),
        resetCode: u.resetCode && Number(u.resetExpires) > Date.now() ? u.resetCode : null,
        resetExpires: u.resetCode && Number(u.resetExpires) > Date.now() ? Number(u.resetExpires) : 0,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      allowRegister: Boolean(store.settings.allowRegister),
      minPasswordLen: MIN_PASSWORD_LEN,
      minSecondLen: MIN_SECOND_LEN,
      hasSecondPassword: Boolean(req.account.codeSalt),
      users,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/settings', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    if (typeof req.body?.allowRegister === 'boolean') {
      store.settings.allowRegister = req.body.allowRegister;
      await saveStore();
    }
    return res.json({ ok: true, allowRegister: Boolean(store.settings.allowRegister) });
  } catch (err) {
    next(err);
  }
});

/** 实时改密码：立即生效，旧的登录状态全部失效，当前这次会话重新签发 */
app.post('/api/admin/password', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }

    const account = req.account;
    const fresh = hashPassword(password);
    account.salt = fresh.salt;
    account.hash = fresh.hash;
    account.pv = Number(account.pv || 0) + 1;
    await saveStore();

    issueSession(res, account);
    return res.json({ ok: true, user: account.username });
  } catch (err) {
    next(err);
  }
});

/** 管理员重置指定账号的密码：该账号的旧密码与旧会话立即失效 */
app.post('/api/admin/users/password', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '账号不存在' });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }

    const target = findUser(username);
    if (!target) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (target.role === 'admin' && target.username !== req.account.username && !isPrimaryAdmin(req.account)) {
      return res.status(403).json({ error: '管理员账号之间不能互相修改密码' });
    }

    const fresh = hashPassword(password);
    target.salt = fresh.salt;
    target.hash = fresh.hash;
    target.pv = Number(target.pv || 0) + 1;
    await saveStore();

    const self = target.username === req.account.username;
    if (self) issueSession(res, target);
    return res.json({ ok: true, username: target.username, self });
  } catch (err) {
    next(err);
  }
});

/** 设置 / 修改自己的二级密码：已有二级密码时必须提供旧的才允许改 */
app.post('/api/admin/second-password', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const oldCode = typeof req.body?.oldCode === 'string' ? req.body.oldCode.trim() : '';
    const newCode = typeof req.body?.newCode === 'string' ? req.body.newCode.trim() : '';

    if (newCode.length < MIN_SECOND_LEN) {
      return res.status(400).json({ error: `二级密码至少 ${MIN_SECOND_LEN} 位` });
    }

    const account = req.account;
    const isInitial = !account.codeSalt;
    if (!isInitial && !checkSecondPassword(account, oldCode)) {
      return res.status(403).json({ error: '旧二级密码不正确' });
    }

    setSecondPassword(account, newCode);
    await saveStore();
    return res.json({ ok: true, initial: isInitial });
  } catch (err) {
    next(err);
  }
});

/** 把普通账号提升为管理员（需要操作者本人的二级密码）；被提升的人自己再设自己的二级密码 */
app.post('/api/admin/users/grant', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const adminCode = typeof req.body?.adminCode === 'string' ? req.body.adminCode.trim() : '';

    if (!req.account.codeSalt) {
      return res.status(403).json({ error: '你还没有二级密码，请先在「管理员设置」里设置二级密码' });
    }
    if (!checkSecondPassword(req.account, adminCode)) {
      return res.status(403).json({ error: '二级密码不正确' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '账号格式不对' });
    }

    const target = findUser(username);
    if (!target) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (target.role === 'admin') {
      return res.status(403).json({ error: '这个账号已经是管理员了' });
    }
    if (target.username === req.account.username) {
      return res.status(400).json({ error: '不用给自己授予' });
    }

    target.role = 'admin';
    target.codeSalt = null;
    target.codeHash = null;
    target.resetCode = null;
    target.resetExpires = 0;
    await saveStore();

    return res.json({ ok: true, username: target.username, needSetSecondPassword: true });
  } catch (err) {
    next(err);
  }
});

/** 撤销管理员：只有主管理员能做，同样要二级密码；撤销后就变成普通账号 */
app.post('/api/admin/users/demote', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const adminCode = typeof req.body?.adminCode === 'string' ? req.body.adminCode.trim() : '';

    if (!isPrimaryAdmin(req.account)) {
      return res.status(403).json({ error: '只有主管理员可以撤销其他管理员' });
    }
    if (!req.account.codeSalt) {
      return res.status(403).json({ error: '你还没有二级密码，请先设置二级密码' });
    }
    if (!checkSecondPassword(req.account, adminCode)) {
      return res.status(403).json({ error: '二级密码不正确' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '账号格式不对' });
    }

    const target = findUser(username);
    if (!target) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (target.username === req.account.username) {
      return res.status(400).json({ error: '不能撤销自己' });
    }
    if (target.role !== 'admin') {
      return res.status(400).json({ error: '这个账号本来就不是管理员' });
    }

    target.role = 'user';
    target.codeSalt = null;
    target.codeHash = null;
    await saveStore();

    return res.json({ ok: true, username: target.username, role: target.role });
  } catch (err) {
    next(err);
  }
});

/** 给某个普通账号发一次性重置码（管理员账号不支持） */
app.post('/api/admin/users/reset-code', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '账号不存在' });
    }

    const target = findUser(username);
    if (!target) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (target.role === 'admin') {
      return res.status(403).json({ error: '管理员账号不支持重置码，请直接改密码' });
    }

    const code = makeResetCode();
    target.resetCode = code;
    target.resetExpires = Date.now() + RESET_CODE_TTL;
    await saveStore();

    return res.json({
      ok: true,
      username: target.username,
      code,
      expiresAt: target.resetExpires,
      ttlMinutes: Math.round(RESET_CODE_TTL / 60000),
    });
  } catch (err) {
    next(err);
  }
});

/** 删除账号并清空它的文件目录；管理员账号与当前登录账号不允许删除 */
app.post('/api/admin/users/delete', requireAuth, requireAdmin, sameOrigin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '账号不存在' });
    }

    const target = findUser(username);
    if (!target) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (target.role === 'admin' || target.username === req.account.username) {
      return res.status(403).json({ error: '管理员账号不能删除' });
    }

    const dir = userDir(target.username);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const removed = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).length;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

    store.users = store.users.filter((u) => u.username !== target.username);
    await saveStore();

    return res.json({ ok: true, username: target.username, removed });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- 文件接口 */

async function listForAccount(account) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const targets = [];

  if (account.role === 'admin') {
    const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && USERNAME_RE.test(entry.name)) {
        targets.push({ owner: entry.name, dir: path.join(DATA_DIR, entry.name) });
      }
    }
    // 兼容旧版本：DATA_DIR 根目录下的散落文件归管理员所有
    const legacy = entries.filter((e) => e.isFile() && !e.name.startsWith('.'));
    if (legacy.length) {
      const adminDir = userDir(account.username);
      await fsp.mkdir(adminDir, { recursive: true });
      for (const entry of legacy) {
        await fsp
          .rename(path.join(DATA_DIR, entry.name), path.join(adminDir, entry.name))
          .catch(() => {});
      }
      targets.push({ owner: account.username, dir: adminDir });
    }
  } else {
    targets.push({ owner: account.username, dir: userDir(account.username) });
  }

  const files = [];
  let totalSize = 0;
  for (const target of targets) {
    const entries = await fsp.readdir(target.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const full = path.join(target.dir, entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      totalSize += stat.size;
      files.push({
        id: toId(target.owner, entry.name),
        name: entry.name,
        owner: target.owner,
        size: stat.size,
        uploadedAt: stat.mtimeMs,
      });
    }
  }
  files.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return { files, totalSize };
}

app.get('/api/files', requireAuth, async (req, res, next) => {
  try {
    const { files, totalSize } = await listForAccount(req.account);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      files,
      count: files.length,
      totalSize,
      maxUploadMb: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', requireAuth, sameOrigin, (req, res) => {
  const account = req.account;
  const dir = userDir(account.username);
  fsp.mkdir(dir, { recursive: true }).catch(() => {});
  fsp.mkdir(TMP_DIR, { recursive: true }).catch(() => {});

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
  const pendingJobs = new Set();
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
          const finalName = await uniqueName(account.username, name);
          const finalPath = path.join(dir, finalName);
          await fsp.rename(tmpPath, finalPath);
          const stat = await fsp.stat(finalPath);
          saved.push({
            id: toId(account.username, finalName),
            name: finalName,
            owner: account.username,
            size: stat.size,
            uploadedAt: stat.mtimeMs,
          });
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

function resolveOwnedFile(req, res) {
  const ref = fromId(req.params.id);
  if (!ref) {
    res.status(404).json({ error: '文件不存在' });
    return null;
  }
  if (req.account.role !== 'admin' && ref.owner !== req.account.username) {
    res.status(404).json({ error: '文件不存在' });
    return null;
  }
  return { ...ref, full: path.join(userDir(ref.owner), ref.name) };
}

app.delete('/api/files/:id', requireAuth, sameOrigin, async (req, res) => {
  const target = resolveOwnedFile(req, res);
  if (!target) return;
  try {
    await fsp.unlink(target.full);
    res.json({ ok: true, name: target.name, owner: target.owner });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: '文件不存在' });
    res.status(500).json({ error: '删除失败' });
  }
});

app.get('/api/files/:id/download', requireAuth, async (req, res) => {
  const target = resolveOwnedFile(req, res);
  if (!target) return;
  const stat = await fsp.stat(target.full).catch(() => null);
  if (!stat || !stat.isFile()) return res.status(404).json({ error: '文件不存在' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(target.name));
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(target.full, (err) => {
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
  await loadStore();
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
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
