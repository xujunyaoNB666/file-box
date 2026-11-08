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
    LOGIN_LOCK_SECONDS: '2',
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
  let cookieHeader = (setCookie[0] || '').split(';')[0];
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

  console.log('\n[7] 多账号与管理员后台');
  const regClosed = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guest01', password: 'guestpass' }),
  });
  check('注册开关默认关闭，注册被拒 403', regClosed.status === 403, `实际 ${regClosed.status}`);

  const openReg = await fetch(`${BASE}/api/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ allowRegister: true }),
  });
  check('管理员可以打开注册开关', openReg.status === 200, `实际 ${openReg.status}`);

  const guestLoginGuard = await fetch(`${BASE}/api/admin/settings`, { headers: { cookie: cookieHeader } });
  check('管理员可读取后台设置', guestLoginGuard.status === 200, `实际 ${guestLoginGuard.status}`);

  const reg = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guest01', password: 'guestpass' }),
  });
  const regJson = await reg.json();
  check('开关打开后可以注册', reg.status === 200, JSON.stringify(regJson));
  check('注册返回普通账号角色', regJson.role === 'user', JSON.stringify(regJson));
  const guestCookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || '';

  const guestList = await fetch(`${BASE}/api/files`, { headers: { cookie: guestCookie } }).then((r) => r.json());
  check('新账号看不到管理员文件', guestList.count === 0, JSON.stringify(guestList.count));

  const remaining = (list2.files || [])[0];
  const guestDl = await fetch(`${BASE}/api/files/${remaining.id}/download`, { headers: { cookie: guestCookie } });
  check('新账号下载别人的文件返回 404', guestDl.status === 404, `实际 ${guestDl.status}`);

  const guestForm = new FormData();
  guestForm.append('files', new Blob(['guest data'], { type: 'text/plain' }), 'guest.txt');
  const guestUpload = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { cookie: guestCookie }, body: guestForm });
  check('新账号可以上传自己的文件', guestUpload.status === 200, `实际 ${guestUpload.status}`);

  const adminList = await fetch(`${BASE}/api/files`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('管理员能看到所有人的文件', adminList.count === 2, JSON.stringify(adminList.count));
  const guestFile = (adminList.files || []).find((f) => f.name === 'guest.txt');
  check('管理员列表带归属账号', Boolean(guestFile) && guestFile.owner === 'guest01', JSON.stringify(guestFile));
  const adminDlGuest = await fetch(`${BASE}/api/files/${guestFile.id}/download`, { headers: { cookie: cookieHeader } });
  check('管理员可以下载他人文件', adminDlGuest.status === 200, `实际 ${adminDlGuest.status}`);

  const guestAdmin = await fetch(`${BASE}/api/admin/settings`, { headers: { cookie: guestCookie } });
  check('普通账号访问后台返回 403', guestAdmin.status === 403, `实际 ${guestAdmin.status}`);

  console.log('\n[8] 自助改密码与重置码找回');
  const regReset = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reset01', password: 'reset01pass' }),
  });
  check('准备测试账号 reset01', regReset.status === 200, `实际 ${regReset.status}`);
  let resetCookie = (regReset.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || '';

  const selfChange = await fetch(`${BASE}/api/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: resetCookie },
    body: JSON.stringify({ password: 'selfchanged1' }),
  });
  check('普通账号可以自己改密码', selfChange.status === 200, `实际 ${selfChange.status}`);
  const resetOldSession = await fetch(`${BASE}/api/session`, { headers: { cookie: resetCookie } }).then((r) => r.json());
  check('普通账号改密码后旧会话失效', resetOldSession.authenticated === false, JSON.stringify(resetOldSession));

  const resetRelogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reset01', password: 'selfchanged1' }),
  });
  check('普通账号新密码立即可以登录', resetRelogin.status === 200, `实际 ${resetRelogin.status}`);
  resetCookie = (resetRelogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || '';

  const adminSelf = await fetch(`${BASE}/api/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ password: 'newpass123' }),
  });
  check('管理员也能用自助改密码接口', adminSelf.status === 200, `实际 ${adminSelf.status}`);
  cookieHeader =
    (adminSelf.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || cookieHeader;

  const codeRes = await fetch(`${BASE}/api/admin/users/reset-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'reset01' }),
  });
  const codeJson = await codeRes.json();
  check('管理员可以为普通账号生成重置码', codeRes.status === 200, JSON.stringify(codeJson));
  check('重置码是 8 位', typeof codeJson.code === 'string' && codeJson.code.length === 8, String(codeJson.code));
  const resetCode = codeJson.code;

  const adminCode = await fetch(`${BASE}/api/admin/users/reset-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: USER }),
  });
  check('管理员账号不能生成重置码', adminCode.status === 403, `实际 ${adminCode.status}`);

  const badCode = await fetch(`${BASE}/api/forgot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reset01', code: 'ZZZZZZZZ', password: 'forgotnew1' }),
  });
  check('错误重置码被拒绝', badCode.status === 400, `实际 ${badCode.status}`);

  const goodCode = await fetch(`${BASE}/api/forgot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reset01', code: resetCode, password: 'forgotnew1' }),
  });
  check('用重置码可以自助重置密码', goodCode.status === 200, `实际 ${goodCode.status}`);

  const forgetLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reset01', password: 'forgotnew1' }),
  });
  check('重置后的密码可以登录', forgetLogin.status === 200, `实际 ${forgetLogin.status}`);

  const reuseCode = await fetch(`${BASE}/api/forgot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reset01', code: resetCode, password: 'forgotnew2' }),
  });
  check('重置码用过就失效', reuseCode.status === 400, `实际 ${reuseCode.status}`);

  const adminForgot = await fetch(`${BASE}/api/forgot/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, code: 'AAAABBBB', password: 'whatever1' }),
  });
  check('管理员账号不能用忘记密码', adminForgot.status === 403, `实际 ${adminForgot.status}`);

  const cleanupReset = await fetch(`${BASE}/api/admin/users/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'reset01' }),
  });
  check('清理测试账号 reset01', cleanupReset.status === 200, `实际 ${cleanupReset.status}`);

  console.log('\n[9] 实时改密码');
  const changePwd = await fetch(`${BASE}/api/admin/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ password: 'newpass123' }),
  });
  check('管理员改密码成功', changePwd.status === 200, `实际 ${changePwd.status}`);
  const newCookie = (changePwd.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || '';

  const oldCookieSession = await fetch(`${BASE}/api/session`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('改密码后旧会话失效', oldCookieSession.authenticated === false, JSON.stringify(oldCookieSession));
  const newCookieSession = await fetch(`${BASE}/api/session`, { headers: { cookie: newCookie } }).then((r) => r.json());
  check('改密码后新会话有效', newCookieSession.authenticated === true, JSON.stringify(newCookieSession));

  const oldPwdLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  check('旧密码登录失败', oldPwdLogin.status === 401, `实际 ${oldPwdLogin.status}`);
  const newPwdLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'newpass123' }),
  });
  check('新密码立即可以登录', newPwdLogin.status === 200, `实际 ${newPwdLogin.status}`);
  cookieHeader = (newPwdLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || newCookie;

  console.log('\n[10] 后台管理账号（重置密码 / 删除）');
  const resetGuest = await fetch(`${BASE}/api/admin/users/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'guest01', password: 'guestnew1' }),
  });
  check('管理员可以重置他人密码', resetGuest.status === 200, `实际 ${resetGuest.status}`);

  const guestAfterReset = await fetch(`${BASE}/api/session`, { headers: { cookie: guestCookie } }).then((r) => r.json());
  check('被重置密码的账号会话立即失效', guestAfterReset.authenticated === false, JSON.stringify(guestAfterReset));

  const guestRelogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guest01', password: 'guestnew1' }),
  });
  check('重置后的新密码可以登录', guestRelogin.status === 200, `实际 ${guestRelogin.status}`);
  const guestOldPwd = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guest01', password: 'guestpass' }),
  });
  check('被重置账号的旧密码失效', guestOldPwd.status === 401, `实际 ${guestOldPwd.status}`);

  const resetShort = await fetch(`${BASE}/api/admin/users/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'guest01', password: '123' }),
  });
  check('重置密码过短返回 400', resetShort.status === 400, `实际 ${resetShort.status}`);

  const deleteAdmin = await fetch(`${BASE}/api/admin/users/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: USER }),
  });
  check('管理员账号不允许删除', deleteAdmin.status === 403, `实际 ${deleteAdmin.status}`);

  const deleteGuest = await fetch(`${BASE}/api/admin/users/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'guest01' }),
  });
  const deleteJson = await deleteGuest.json();
  check('可以删除普通账号', deleteGuest.status === 200, JSON.stringify(deleteJson));
  check('删除时一并清掉对方文件', deleteJson.removed === 1, JSON.stringify(deleteJson));

  const guestGone = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guest01', password: 'guestnew1' }),
  });
  check('删除后的账号无法登录', guestGone.status === 401, `实际 ${guestGone.status}`);

  const listAfterDelete = await fetch(`${BASE}/api/files`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check(
    '被删账号的文件从列表消失',
    listAfterDelete.count === 1 && !(listAfterDelete.files || []).some((f) => f.owner === 'guest01'),
    JSON.stringify(listAfterDelete.count),
  );

  const settingsAfter = await fetch(`${BASE}/api/admin/settings`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('账号列表已只剩管理员', (settingsAfter.users || []).length === 1, JSON.stringify(settingsAfter.users));

  console.log('\n[11] 管理员二级密码与授予管理员');
  const regMgr = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mgr01', password: 'mgr01pass' }),
  });
  check('准备测试账号 mgr01', regMgr.status === 200, `实际 ${regMgr.status}`);

  const badGrant = await fetch(`${BASE}/api/admin/users/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr01', adminCode: 'wrong-code' }),
  });
  check('二级密码错误时无法授予管理员', badGrant.status === 403, `实际 ${badGrant.status}`);

  const grantOk = await fetch(`${BASE}/api/admin/users/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr01', adminCode: 'xujunyaoNB666' }),
  });
  check('二级密码正确时可以授予管理员', grantOk.status === 200, `实际 ${grantOk.status}`);

  const mgrLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mgr01', password: 'mgr01pass' }),
  });
  const mgrLoginJson = await mgrLogin.json();
  check('被授予的账号立即是管理员', mgrLoginJson.role === 'admin', JSON.stringify(mgrLoginJson));
  let mgrCookie = (mgrLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || '';

  const mgrSettings = await fetch(`${BASE}/api/admin/settings`, { headers: { cookie: mgrCookie } });
  check('新管理员能打开后台', mgrSettings.status === 200, `实际 ${mgrSettings.status}`);

  await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mgr02', password: 'mgr02pass' }),
  });

  const mgrNoCode = await fetch(`${BASE}/api/admin/users/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: mgrCookie },
    body: JSON.stringify({ username: 'mgr02', adminCode: 'whatever' }),
  });
  const mgrNoCodeJson = await mgrNoCode.json();
  check('新管理员还没设二级密码时不能授予', mgrNoCode.status === 403, `实际 ${mgrNoCode.status}`);
  check('提示让对方先设置二级密码', String(mgrNoCodeJson.error || '').includes('二级密码'), JSON.stringify(mgrNoCodeJson));

  const setOwn = await fetch(`${BASE}/api/admin/second-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: mgrCookie },
    body: JSON.stringify({ oldCode: '', newCode: 'mgrsecond1' }),
  });
  const setOwnJson = await setOwn.json();
  check('新管理员可以首次设置自己的二级密码', setOwn.status === 200 && setOwnJson.initial === true, JSON.stringify(setOwnJson));

  const mgrGrantOk = await fetch(`${BASE}/api/admin/users/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: mgrCookie },
    body: JSON.stringify({ username: 'mgr02', adminCode: 'mgrsecond1' }),
  });
  check('新管理员设好二级密码后可以授予他人', mgrGrantOk.status === 200, `实际 ${mgrGrantOk.status}`);

  const otherAdminPw = await fetch(`${BASE}/api/admin/users/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: mgrCookie },
    body: JSON.stringify({ username: 'mgr02', password: 'hacked1' }),
  });
  check('普通管理员不能改另一个管理员的密码', otherAdminPw.status === 403, `实际 ${otherAdminPw.status}`);

  const primaryAdminPw = await fetch(`${BASE}/api/admin/users/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr01', password: 'mgr01pass2' }),
  });
  check('xujunyao 可以改其他管理员的密码', primaryAdminPw.status === 200, `实际 ${primaryAdminPw.status}`);

  const mgrLoginNewPw = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mgr01', password: 'mgr01pass2' }),
  });
  check('被主管理员改过密码的管理员能用新密码登录', mgrLoginNewPw.status === 200, `实际 ${mgrLoginNewPw.status}`);
  mgrCookie = (mgrLoginNewPw.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])[0] || mgrCookie;

  const otherReset = await fetch(`${BASE}/api/admin/users/reset-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr01' }),
  });
  check('不能给管理员发重置码', otherReset.status === 403, `实际 ${otherReset.status}`);

  const otherDelete = await fetch(`${BASE}/api/admin/users/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr01' }),
  });
  check('不能删除管理员', otherDelete.status === 403, `实际 ${otherDelete.status}`);

  const wrongOld = await fetch(`${BASE}/api/admin/second-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ oldCode: 'not-my-code', newCode: 'xujunyaoNB6661' }),
  });
  check('改二级密码必须提供正确的旧二级密码', wrongOld.status === 403, `实际 ${wrongOld.status}`);

  const changeOk = await fetch(`${BASE}/api/admin/second-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ oldCode: 'xujunyaoNB666', newCode: 'xujunyaoNB6669' }),
  });
  check('旧二级密码正确时可以更换二级密码', changeOk.status === 200, `实际 ${changeOk.status}`);

  const reuseOld = await fetch(`${BASE}/api/admin/second-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ oldCode: 'xujunyaoNB666', newCode: 'another123' }),
  });
  check('旧二级密码换掉之后立即失效', reuseOld.status === 403, `实际 ${reuseOld.status}`);

  await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mgr03', password: 'mgr03pass' }),
  });
  const grantWithNew = await fetch(`${BASE}/api/admin/users/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr03', adminCode: 'xujunyaoNB6669' }),
  });
  check('用新的二级密码可以继续授予管理员', grantWithNew.status === 200, `实际 ${grantWithNew.status}`);

  const mgrDemote = await fetch(`${BASE}/api/admin/users/demote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: mgrCookie },
    body: JSON.stringify({ username: 'mgr02', adminCode: 'mgrsecond1' }),
  });
  check('普通管理员不能撤销其他管理员', mgrDemote.status === 403, `实际 ${mgrDemote.status}`);

  const demoteWrongCode = await fetch(`${BASE}/api/admin/users/demote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr02', adminCode: 'wrong-code' }),
  });
  check('撤销管理员也要二级密码', demoteWrongCode.status === 403, `实际 ${demoteWrongCode.status}`);

  const demoteOk = await fetch(`${BASE}/api/admin/users/demote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({ username: 'mgr02', adminCode: 'xujunyaoNB6669' }),
  });
  check('主管理员可以撤销其他管理员', demoteOk.status === 200, `实际 ${demoteOk.status}`);

  const afterDemote = await fetch(`${BASE}/api/admin/settings`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  const mgr02Row = (afterDemote.users || []).find((x) => x.username === 'mgr02');
  check('被撤销的账号回到普通账号', mgr02Row && mgr02Row.role === 'user', JSON.stringify(mgr02Row));

  console.log('\n[12] 退出');
  await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { cookie: cookieHeader } });
  const session2 = await fetch(`${BASE}/api/session`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  check('退出后会话失效', session2.authenticated === false);

  console.log('\n[13] 页面');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('首页返回 200', page.status === 200, `实际 ${page.status}`);
  check('首页包含登录框', html.includes('loginForm'));

  console.log('\n[14] 登录失败 5 次锁定（测试里配成 2 秒）');
  const clearFails = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'newpass123' }),
  });
  check('先成功登录一次，清空失败计数', clearFails.status === 200, `实际 ${clearFails.status}`);

  const firstFive = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: `wrong-${i}` }),
    });
    firstFive.push(r.status);
  }
  check('前 5 次输错返回 401', firstFive.every((s) => s === 401), JSON.stringify(firstFive));

  const sixth = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'wrong-6' }),
  });
  const sixthBody = await sixth.text();
  check('第 6 次被锁定返回 429', sixth.status === 429, `实际 ${sixth.status}`);
  check('锁定提示里带剩余秒数', sixthBody.includes('秒后再试'), sixthBody);

  const duringLock = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'newpass123' }),
  });
  check('锁定期间正确密码也进不去', duringLock.status === 429, `实际 ${duringLock.status}`);

  await new Promise((r) => setTimeout(r, 2400));
  const afterLock = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'newpass123' }),
  });
  check('锁定到期后正确密码可以登录', afterLock.status === 200, `实际 ${afterLock.status}`);

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
