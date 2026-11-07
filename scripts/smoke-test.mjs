/**
 * 冒烟测试：真起一个服务进程，走完整链路
 *   登录失败 → 登录成功 → 未授权访问 → 上传 → 列表 → 下载 → 删除 → 退出
 *
 * 运行：npm test
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'xujunyao';
const PASSWORD = 'shenye128';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'filebox-test-'));
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    ADMIN_USER: USER,
    ADMIN_PASSWORD: PASSWORD,
    SESSION_SECRET: 'test-secret-for-smoke-test',
    MAX_UPLOAD_MB: '10',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
child.stdout.on('data', (d) => logs.push(String(d)));
child.stderr.on('data', (d) => logs.push(String(d)));

let exitCode = 1;

try {
  if (!(await waitForServer())) {
    console.log(logs.join(''));
    throw new Error('服务未能在 15s 内启动');
  }

  console.log('\n[1] 未登录状态');
  const session0 = await fetch(`${BASE}/api/session`).then((r) => r.json());
  check('session 显示未登录', session0.authenticated === false);
  const guard = await fetch(`${BASE}/api/files`);
  check('未登录访问文件列表返回 401', guard.status === 401, `实际 ${guard.status}`);

  console.log('\n[2] 登录');
  const badLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'wrong-password' }),
  });
  check('错误密码返回 401', badLogin.status === 401, `实际 ${badLogin.status}`);

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  check('正确密码登录成功', login.status === 200, `实际 ${login.status}`);
  const setCookie = login.headers.getSetCookie?.() ?? [];
  const cookieHeader = (setCookie[0] || '').split(';')[0];
  check('下发了会话 Cookie', cookieHeader.startsWith('fb_session='), cookieHeader);
  const session1 = await fetch(`${BASE}/api/session`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('session 显示已登录', session1.authenticated === true && session1.user === USER, JSON.stringify(session1));

  console.log('\n[3] 上传');
  const content = Buffer.from('FileBox 冒烟测试内容\n第二行 with ASCII\n', 'utf8');
  const form = new FormData();
  form.append('files', new Blob([content], { type: 'text/plain' }), '测试 文档.txt');
  form.append('files', new Blob(['second file'], { type: 'text/plain' }), 'notes.md');

  const upload = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { cookie: cookieHeader },
    body: form,
  });
  const uploadJson = await upload.json();
  check('上传返回 200', upload.status === 200, `实际 ${upload.status}`);
  check('两个文件都保存成功', (uploadJson.saved || []).length === 2, JSON.stringify(uploadJson));
  check('中文文件名被保留', (uploadJson.saved || []).some((f) => f.name === '测试 文档.txt'));

  const uploadAnon = await fetch(`${BASE}/api/upload`, { method: 'POST', body: new FormData() });
  check('未登录上传被拒绝', uploadAnon.status === 401, `实际 ${uploadAnon.status}`);

  console.log('\n[4] 列表');
  const list = await fetch(`${BASE}/api/files`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('列表返回 2 个文件', list.count === 2, JSON.stringify(list));
  const target = (list.files || []).find((f) => f.name === '测试 文档.txt');
  check('列表包含上传的文件', Boolean(target));
  check('总大小统计正确', list.totalSize >= content.length, `${list.totalSize}`);

  console.log('\n[5] 下载');
  const dl = await fetch(`${BASE}/api/files/${target.id}/download`, { headers: { cookie: cookieHeader } });
  check('下载返回 200', dl.status === 200, `实际 ${dl.status}`);
  const disposition = dl.headers.get('content-disposition') || '';
  check('带 attachment 头', disposition.startsWith('attachment;'));
  check('中文文件名做了 RFC5987 编码', disposition.includes("filename*=UTF-8''"), disposition);
  const downloaded = Buffer.from(await dl.arrayBuffer());
  check('下载内容与上传一致', downloaded.equals(content), `长度 ${downloaded.length} vs ${content.length}`);

  const dlAnon = await fetch(`${BASE}/api/files/${target.id}/download`);
  check('未登录下载返回 401', dlAnon.status === 401, `实际 ${dlAnon.status}`);

  const dlTraversal = await fetch(`${BASE}/api/files/Li4vLi4vc2VydmVyLmpz/download`, {
    headers: { cookie: cookieHeader },
  });
  check('路径穿越请求被拒绝', dlTraversal.status === 404, `实际 ${dlTraversal.status}`);

  console.log('\n[6] 删除');
  const del = await fetch(`${BASE}/api/files/${target.id}`, { method: 'DELETE', headers: { cookie: cookieHeader } });
  check('删除返回 200', del.status === 200, `实际 ${del.status}`);
  const list2 = await fetch(`${BASE}/api/files`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('删除后剩 1 个文件', list2.count === 1, JSON.stringify(list2.count));

  console.log('\n[7] 退出');
  await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { cookie: cookieHeader } });
  const session2 = await fetch(`${BASE}/api/session`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('退出后会话失效', session2.authenticated === false);

  console.log('\n[8] 页面');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('首页返回 200', page.status === 200, `实际 ${page.status}`);
  check('首页包含登录框', html.includes('loginForm'));

  console.log('\n[9] 登录限流');
  let blockedStatus = 0;
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: `wrong-${i}` }),
    });
    blockedStatus = res.status;
    if (res.status === 429) break;
  }
  check('连续失败后触发 429 限流', blockedStatus === 429, `实际 ${blockedStatus}`);

  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n测试异常：', err.message);
  console.log(logs.join(''));
  exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(exitCode);
}
