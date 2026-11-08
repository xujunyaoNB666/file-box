'use strict';

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    files: [],
    query: '',
    maxUploadMb: 512,
    minPasswordLen: 6,
    allowRegister: false,
    role: null,
    user: null,
  };

  /* ------------------------------------------------------------- 通用工具 */

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return `${i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    if (i < 0 || i === name.length - 1) return 'FILE';
    return name.slice(i + 1, i + 5);
  }

  let toastTimer = null;
  function toast(message, bad) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('bad', Boolean(bad));
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function request(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  /* ------------------------------------------------------------- 视图切换 */

  function syncRegisterEntry() {
    $('#registerEntry').hidden = !state.allowRegister;
    $('#registerClosed').hidden = state.allowRegister;
  }

  function showLogin(message) {
    $('#loginView').hidden = false;
    $('#appView').hidden = true;
    $('#topbarActions').hidden = true;
    $('#adminPanel').hidden = true;
    $('#accountPanel').hidden = true;
    $('#loginForm').hidden = false;
    $('#registerForm').hidden = true;
    $('#forgotForm').hidden = true;
    $('#loginMsg').textContent = message || '';
    syncRegisterEntry();
    setTimeout(() => $('#username').focus(), 60);
  }

  function showForgot(message) {
    $('#loginForm').hidden = true;
    $('#registerForm').hidden = true;
    $('#forgotForm').hidden = false;
    $('#forgotMsg').textContent = message || '';
    setTimeout(() => $('#forgotUsername').focus(), 60);
  }

  function showRegister() {
    $('#loginForm').hidden = true;
    $('#forgotForm').hidden = true;
    $('#registerForm').hidden = false;
    $('#registerMsg').textContent = '';
    setTimeout(() => $('#regUsername').focus(), 60);
  }

  function showApp(user, role) {
    state.user = user;
    state.role = role || 'user';
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    $('#topbarActions').hidden = false;
    $('#userChip').textContent = state.role === 'admin' ? `${user}（管理员）` : user;
    $('#adminBtn').hidden = state.role !== 'admin';
    $('#pwdBtn').hidden = state.role === 'admin';
    $('#adminPanel').hidden = true;
    $('#accountPanel').hidden = true;
    $('#listTitle').textContent = state.role === 'admin' ? '全部文件' : '我的文件';
    $('#dzHint').textContent = `单个文件不超过 ${state.maxUploadMb} MB，支持一次选择多个文件`;
    loadFiles();
  }

  /* ------------------------------------------------------------- 登录 / 注册 */

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const btn = $('#loginBtn');
    const msg = $('#loginMsg');

    if (!username || !password) {
      msg.textContent = '请输入账号和密码';
      return;
    }

    btn.disabled = true;
    btn.textContent = '登录中…';
    msg.textContent = '';
    try {
      const data = await request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      $('#loginForm').reset();
      showApp(data.user || username, data.role);
    } catch (err) {
      msg.textContent = err.message || '登录失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('#toRegister').addEventListener('click', showRegister);
  $('#toLogin').addEventListener('click', () => showLogin());
  $('#toForgot').addEventListener('click', () => showForgot());
  $('#forgotBack').addEventListener('click', () => {
    $('#forgotForm').reset();
    showLogin('');
  });

  $('#forgotForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#forgotUsername').value.trim();
    const code = $('#forgotCode').value.trim();
    const password = $('#forgotPassword').value;
    const btn = $('#forgotBtn');
    const msg = $('#forgotMsg');

    if (!username || !code) {
      msg.textContent = '请填写账号和重置码';
      return;
    }
    if (password.length < state.minPasswordLen) {
      msg.textContent = `新密码至少 ${state.minPasswordLen} 位`;
      return;
    }

    btn.disabled = true;
    btn.textContent = '重置中…';
    msg.textContent = '';
    try {
      const data = await request('/api/forgot/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, code, password }),
      });
      $('#forgotForm').reset();
      showLogin(`账号 ${data.user} 的密码已重置，用新密码登录即可`);
      toast('密码已重置');
    } catch (err) {
      msg.textContent = err.message || '重置失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '重置密码';
    }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#regUsername').value.trim();
    const password = $('#regPassword').value;
    const btn = $('#registerBtn');
    const msg = $('#registerMsg');

    if (!username || !password) {
      msg.textContent = '请输入账号和密码';
      return;
    }
    if (password.length < state.minPasswordLen) {
      msg.textContent = `密码至少 ${state.minPasswordLen} 位`;
      return;
    }

    btn.disabled = true;
    btn.textContent = '注册中…';
    msg.textContent = '';
    try {
      const data = await request('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      $('#registerForm').reset();
      showApp(data.user || username, data.role);
      toast('注册成功，已自动登录');
    } catch (err) {
      msg.textContent = err.message || '注册失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '注册并登录';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await request('/api/logout', { method: 'POST' });
    } catch {
      /* 忽略退出失败 */
    }
    state.files = [];
    state.role = null;
    $('#fileBody').innerHTML = '';
    showLogin('已退出登录');
  });

  /* ------------------------------------------------------------- 文件列表 */

  async function loadFiles() {
    const meta = $('#listMeta');
    try {
      const data = await request('/api/files');
      state.files = data.files || [];
      state.maxUploadMb = data.maxUploadMb || state.maxUploadMb;
      $('#dzHint').textContent = `单个文件不超过 ${state.maxUploadMb} MB，支持一次选择多个文件`;
      if (data.count) {
        meta.textContent = `${data.count} 个文件 · 共 ${formatSize(data.totalSize)}`;
      } else {
        meta.textContent = '暂无文件';
      }
      renderFiles();
    } catch (err) {
      if (err.status === 401) return showLogin('登录已过期，请重新登录');
      meta.textContent = '加载失败';
      toast(err.message || '加载失败', true);
    }
  }

  function renderFiles() {
    const body = $('#fileBody');
    const empty = $('#emptyState');
    const query = state.query.trim().toLowerCase();
    const list = query
      ? state.files.filter((f) => f.name.toLowerCase().includes(query))
      : state.files;

    body.innerHTML = '';

    if (!list.length) {
      empty.hidden = false;
      empty.textContent = query
        ? `没有匹配「${state.query.trim()}」的文件`
        : '还没有文件，拖拽或点击上方选择文件即可上传。';
      return;
    }
    empty.hidden = true;

    const frag = document.createDocumentFragment();
    for (const file of list) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      const nameWrap = document.createElement('div');
      nameWrap.className = 'name-cell';
      const badge = document.createElement('span');
      badge.className = 'ext-badge';
      badge.textContent = extOf(file.name);
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      name.title = file.name;
      nameWrap.append(badge, name);
      tdName.append(nameWrap);

      const tdOwner = document.createElement('td');
      tdOwner.className = 'dim col-owner';
      tdOwner.textContent = file.owner || '';

      const tdSize = document.createElement('td');
      tdSize.className = 'dim col-size';
      tdSize.textContent = formatSize(file.size);

      const tdDate = document.createElement('td');
      tdDate.className = 'dim col-date';
      tdDate.textContent = formatDate(file.uploadedAt);

      const tdAct = document.createElement('td');
      const actWrap = document.createElement('div');
      actWrap.className = 'act-cell';

      const dl = document.createElement('button');
      dl.className = 'btn btn-download';
      dl.type = 'button';
      dl.textContent = '下载';
      dl.addEventListener('click', () => download(file));

      const del = document.createElement('button');
      del.className = 'btn btn-danger-ghost';
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', () => removeFile(file));

      actWrap.append(dl, del);
      tdAct.append(actWrap);

      tr.append(tdName, tdOwner, tdSize, tdDate, tdAct);
      frag.append(tr);
    }
    body.append(frag);
  }

  function download(file) {
    const a = document.createElement('a');
    a.href = `/api/files/${encodeURIComponent(file.id)}/download`;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    toast(`开始下载 ${file.name}`);
  }

  async function removeFile(file) {
    const sure = window.confirm(`确定删除「${file.name}」？此操作不可恢复。`);
    if (!sure) return;
    try {
      await request(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      toast('已删除');
      await loadFiles();
    } catch (err) {
      if (err.status === 401) return showLogin('登录已过期，请重新登录');
      toast(err.message || '删除失败', true);
    }
  }

  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderFiles();
  });

  $('#refreshBtn').addEventListener('click', () => {
    loadFiles();
    toast('已刷新');
  });

  /* ------------------------------------------------------------- 上传 */

  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');

  $('#pickBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      if (name === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
      dropzone.classList.remove('dragging');
    });
  });

  dropzone.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) {
      uploadFiles(event.dataTransfer.files);
    }
  });

  function queueItem(names) {
    const li = document.createElement('li');
    li.className = 'queue-item';
    const span = document.createElement('span');
    span.className = 'queue-name';
    span.textContent = names;
    const bar = document.createElement('span');
    bar.className = 'progress';
    const fill = document.createElement('i');
    fill.style.right = '100%';
    bar.append(fill);
    const status = document.createElement('span');
    status.className = 'queue-state';
    status.textContent = '0%';
    li.append(span, bar, status);
    $('#uploadQueue').append(li);
    return { li, fill, status };
  }

  function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;

    const tooBig = files.filter((f) => f.size > state.maxUploadMb * 1024 * 1024);
    const usable = files.filter((f) => f.size <= state.maxUploadMb * 1024 * 1024);

    for (const f of tooBig) {
      toast(`「${f.name}」超过 ${state.maxUploadMb} MB 上限`, true);
    }
    if (!usable.length) return;

    const label = usable.length === 1 ? usable[0].name : `${usable.length} 个文件`;
    const ui = queueItem(label);

    const form = new FormData();
    for (const file of usable) form.append('files', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round((event.loaded / event.total) * 100);
      ui.fill.style.right = `${100 - pct}%`;
      ui.status.textContent = `${pct}%`;
    });

    const finish = (ok, text) => {
      ui.status.textContent = text;
      ui.status.classList.add(ok ? 'ok' : 'bad');
      ui.fill.style.right = ok ? '0%' : '100%';
      ui.fill.style.background = ok ? '#12b76a' : 'var(--danger)';
      setTimeout(() => ui.li.remove(), 4000);
    };

    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* 忽略解析失败 */
      }
      if (xhr.status === 401) {
        finish(false, '登录已过期');
        showLogin('登录已过期，请重新登录');
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(false, '失败');
        toast(data.error || '上传失败', true);
        return;
      }
      const saved = data.saved || [];
      const failed = data.failed || [];
      if (saved.length) {
        finish(true, `已上传 ${saved.length} 个`);
        toast(saved.length === 1 ? `已上传 ${saved[0].name}` : `已上传 ${saved.length} 个文件`);
      } else {
        finish(false, '失败');
      }
      if (failed.length) {
        toast(failed.map((f) => `${f.name}：${f.reason}`).join('；'), true);
      }
      loadFiles();
    });

    xhr.addEventListener('error', () => {
      finish(false, '网络错误');
      toast('上传失败，请检查网络后重试', true);
    });

    xhr.addEventListener('abort', () => finish(false, '已取消'));

    xhr.send(form);
  }

  /* ------------------------------------------------------------- 管理员后台 */

  $('#adminBtn').addEventListener('click', async () => {
    const panel = $('#adminPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadAdminSettings();
  });

  $('#adminClose').addEventListener('click', () => {
    $('#adminPanel').hidden = true;
  });

  $('#pwdBtn').addEventListener('click', () => {
    const panel = $('#accountPanel');
    const opening = panel.hidden;
    panel.hidden = !opening;
    if (opening) {
      $('#selfPwdMsg').textContent = '';
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => $('#selfPassword').focus(), 200);
    }
  });

  $('#accountClose').addEventListener('click', () => {
    $('#accountPanel').hidden = true;
  });

  $('#saveSelfPassword').addEventListener('click', async () => {
    const input = $('#selfPassword');
    const msg = $('#selfPwdMsg');
    const password = input.value;

    if (password.length < state.minPasswordLen) {
      msg.textContent = `密码至少 ${state.minPasswordLen} 位`;
      return;
    }

    const btn = $('#saveSelfPassword');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await request('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      input.value = '';
      msg.textContent = '密码已更新，立即生效（其它设备需重新登录）';
      toast('密码已更新');
    } catch (err) {
      if (err.status === 401) return showLogin('登录已过期，请重新登录');
      msg.textContent = err.message || '修改失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '保存新密码';
    }
  });

  async function loadAdminSettings() {
    try {
      const data = await request('/api/admin/settings');
      state.allowRegister = Boolean(data.allowRegister);
      $('#allowRegister').checked = state.allowRegister;
      $('#settingMsg').textContent = state.allowRegister ? '当前：允许任何人注册' : '当前：注册入口已关闭';
      const list = $('#userList');
      list.innerHTML = '';
      for (const u of data.users || []) {
        const li = document.createElement('li');
        li.className = 'user-row';
        const isAdmin = u.role === 'admin';

        const main = document.createElement('div');
        main.className = 'user-main';
        const name = document.createElement('span');
        name.className = 'user-name';
        name.textContent = u.username;
        const role = document.createElement('span');
        role.className = 'user-role';
        role.textContent = (isAdmin ? '管理员' : '普通账号') + (u.files ? ` · ${u.files} 个文件` : '');
        main.append(name, role);

        if (!isAdmin && u.resetCode) {
          const chip = document.createElement('span');
          chip.className = 'user-code';
          chip.dataset.role = 'reset-code';
          chip.textContent = `重置码 ${u.resetCode} · 有效至 ${formatDate(u.resetExpires)}`;
          main.append(chip);
        }

        const acts = document.createElement('div');
        acts.className = 'user-acts';

        const isSelf = u.username === state.user;
        const isPrimaryActor = state.role === 'admin' && state.user === state.primaryAdmin;

        /* 别的管理员之间不能互改，但主管理员可以改其他管理员 */
        if (!isAdmin || isSelf || isPrimaryActor) {
          const pwBtn = document.createElement('button');
          pwBtn.type = 'button';
          pwBtn.className = 'btn btn-ghost btn-sm';
          pwBtn.textContent = '改密码';
          pwBtn.addEventListener('click', () => openUserPwEditor(li, u));
          acts.append(pwBtn);
        }

        if (isAdmin && !isSelf && isPrimaryActor) {
          const demoteBtn = document.createElement('button');
          demoteBtn.type = 'button';
          demoteBtn.className = 'btn btn-danger btn-sm';
          demoteBtn.textContent = '撤销管理员';
          demoteBtn.addEventListener('click', () => openDemoteEditor(li, u));
          acts.append(demoteBtn);
        }

        if (!isAdmin) {
          const grantBtn = document.createElement('button');
          grantBtn.type = 'button';
          grantBtn.className = 'btn btn-ghost btn-sm';
          grantBtn.textContent = '授予管理员';
          grantBtn.addEventListener('click', () => openGrantEditor(li, u));
          acts.append(grantBtn);

          const codeBtn = document.createElement('button');
          codeBtn.type = 'button';
          codeBtn.className = 'btn btn-ghost btn-sm';
          codeBtn.textContent = u.resetCode ? '换重置码' : '发重置码';
          codeBtn.addEventListener('click', () => issueResetCode(u, main, codeBtn));
          acts.append(codeBtn);

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'btn btn-danger btn-sm';
          delBtn.textContent = '删除';
          delBtn.addEventListener('click', () => deleteUser(u, li));
          acts.append(delBtn);
        }

        li.append(main, acts);
        list.append(li);
      }

      function openUserPwEditor(li, u) {
        if (li.querySelector('.user-editor')) return;
        const box = document.createElement('div');
        box.className = 'user-editor';

        const input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'new-password';
        input.minLength = state.minPasswordLen;
        input.placeholder = `新密码（至少 ${state.minPasswordLen} 位）`;

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-primary btn-sm';
        save.textContent = '保存';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn btn-ghost btn-sm';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => box.remove());

        save.addEventListener('click', async () => {
          const password = input.value;
          if (password.length < state.minPasswordLen) {
            toast(`密码至少 ${state.minPasswordLen} 位`, true);
            return;
          }
          save.disabled = true;
          try {
            const res = await request('/api/admin/users/password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u.username, password }),
            });
            box.remove();
            if (res && res.self) {
              toast('密码已更新，其他设备需重新登录');
            } else {
              toast(`${u.username} 的密码已更新`);
            }
            loadAdminSettings();
          } catch (err) {
            toast(err.message || '修改失败', true);
          } finally {
            save.disabled = false;
          }
        });

        box.append(input, save, cancel);
        li.append(box);
        input.focus();
      }

      function openDemoteEditor(li, u) {
        if (li.querySelector('.user-editor')) return;
        const box = document.createElement('div');
        box.className = 'user-editor';

        const input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = '你的二级密码（撤销需要验证）';

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-danger btn-sm';
        save.textContent = '确认撤销';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn btn-ghost btn-sm';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => box.remove());

        save.addEventListener('click', async () => {
          const adminCode = input.value.trim();
          if (!adminCode) {
            toast('请输入你的二级密码', true);
            return;
          }
          save.disabled = true;
          try {
            await request('/api/admin/users/demote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u.username, adminCode }),
            });
            box.remove();
            toast(`${u.username} 已改回普通账号`);
            loadAdminSettings();
          } catch (err) {
            toast(err.message || '撤销失败', true);
          } finally {
            save.disabled = false;
          }
        });

        box.append(input, save, cancel);
        li.append(box);
        input.focus();
      }

      function openGrantEditor(li, u) {
        if (li.querySelector('.user-editor')) return;
        const box = document.createElement('div');
        box.className = 'user-editor';

        const input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = '你的二级密码（授予操作需要验证）';

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-primary btn-sm';
        save.textContent = '确认授予';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn btn-ghost btn-sm';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => box.remove());

        save.addEventListener('click', async () => {
          const adminCode = input.value.trim();
          if (!adminCode) {
            toast('请输入你的二级密码', true);
            return;
          }
          save.disabled = true;
          try {
            await request('/api/admin/users/grant', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u.username, adminCode }),
            });
            box.remove();
            toast(`${u.username} 已是管理员，让对方登录后在「管理」里设置自己的二级密码`);
            loadAdminSettings();
          } catch (err) {
            toast(err.message || '授予失败', true);
          } finally {
            save.disabled = false;
          }
        });

        box.append(input, save, cancel);
        li.append(box);
        input.focus();
      }

      async function issueResetCode(u, main, btn) {
        btn.disabled = true;
        try {
          const res = await request('/api/admin/users/reset-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u.username }),
          });
          let chip = main.querySelector('[data-role="reset-code"]');
          if (!chip) {
            chip = document.createElement('span');
            chip.className = 'user-code';
            chip.dataset.role = 'reset-code';
            main.append(chip);
          }
          chip.textContent = `重置码 ${res.code} · 有效至 ${formatDate(res.expiresAt)}`;
          u.resetCode = res.code;
          u.resetExpires = res.expiresAt;
          btn.textContent = '换重置码';
          toast(`${u.username} 的重置码：${res.code}（${res.ttlMinutes} 分钟内有效）`);
        } catch (err) {
          toast(err.message || '生成重置码失败', true);
        } finally {
          btn.disabled = false;
        }
      }

      async function deleteUser(u, li) {
        const ok = window.confirm(
          `确定删除账号「${u.username}」？\n它的 ${u.files || 0} 个文件会一起删除，无法恢复。`,
        );
        if (!ok) return;
        try {
          const res = await request('/api/admin/users/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u.username }),
          });
          li.remove();
          toast(`已删除账号 ${res.username}${res.removed ? `（含 ${res.removed} 个文件）` : ''}`);
          await loadFiles();
        } catch (err) {
          toast(err.message || '删除失败', true);
        }
      }
    } catch (err) {
      if (err.status === 401) return showLogin('登录已过期，请重新登录');
      $('#settingMsg').textContent = err.message || '读取设置失败';
    }
  }

  $('#allowRegister').addEventListener('change', async (event) => {
    const value = event.target.checked;
    const msg = $('#settingMsg');
    try {
      const data = await request('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowRegister: value }),
      });
      state.allowRegister = Boolean(data.allowRegister);
      msg.textContent = state.allowRegister ? '已开启：任何人现在都能注册' : '已关闭：注册入口失效';
      toast(state.allowRegister ? '已开放注册' : '已关闭注册');
    } catch (err) {
      event.target.checked = !value;
      msg.textContent = err.message || '修改失败';
      toast(err.message || '修改失败', true);
    }
  });

  $('#savePassword').addEventListener('click', async () => {
    const input = $('#newPassword');
    const msg = $('#passwordMsg');
    const password = input.value;

    if (password.length < state.minPasswordLen) {
      msg.textContent = `密码至少 ${state.minPasswordLen} 位`;
      return;
    }

    const btn = $('#savePassword');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await request('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      input.value = '';
      msg.textContent = '密码已更新，立即生效';
      toast('密码已更新');
    } catch (err) {
      msg.textContent = err.message || '修改失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '保存新密码';
    }
  });

  $('#saveSecond').addEventListener('click', async () => {
    const oldCode = $('#oldSecond').value.trim();
    const newCode = $('#newSecond').value.trim();
    const msg = $('#secondMsg');
    const btn = $('#saveSecond');

    if (newCode.length < 6) {
      msg.textContent = '二级密码至少 6 位';
      return;
    }

    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const res = await request('/api/admin/second-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldCode, newCode }),
      });
      $('#oldSecond').value = '';
      $('#newSecond').value = '';
      msg.textContent = res.initial ? '二级密码已设置好' : '二级密码已更新';
      toast(res.initial ? '二级密码已设置' : '二级密码已更新');
    } catch (err) {
      if (err.status === 401) return showLogin('登录已过期，请重新登录');
      msg.textContent = err.message || '保存失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '保存二级密码';
    }
  });

  /* ------------------------------------------------------------- 启动 */

  (async function boot() {
    try {
      const session = await request('/api/session');
      state.maxUploadMb = session.maxUploadMb || state.maxUploadMb;
      state.minPasswordLen = session.minPasswordLen || state.minPasswordLen;
      state.allowRegister = Boolean(session.allowRegister);
      state.hasSecondPassword = Boolean(session.hasSecondPassword);
      state.primaryAdmin = session.primaryAdmin || null;
      if (session.authenticated) showApp(session.user || '管理员', session.role);
      else showLogin();
    } catch {
      showLogin('无法连接服务器');
    }
  })();
})();
