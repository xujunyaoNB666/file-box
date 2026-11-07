'use strict';

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    files: [],
    query: '',
    maxUploadMb: 512,
    uploading: 0,
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

  function showLogin(message) {
    $('#loginView').hidden = false;
    $('#appView').hidden = true;
    $('#topbarActions').hidden = true;
    $('#loginMsg').textContent = message || '';
    setTimeout(() => $('#username').focus(), 60);
  }

  function showApp(user) {
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    $('#topbarActions').hidden = false;
    $('#userChip').textContent = user;
    $('#dzHint').textContent = `单个文件不超过 ${state.maxUploadMb} MB，支持一次选择多个文件`;
    loadFiles();
  }

  /* ------------------------------------------------------------- 登录 / 退出 */

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
      showApp(data.user || username);
    } catch (err) {
      msg.textContent = err.message || '登录失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await request('/api/logout', { method: 'POST' });
    } catch {
      /* 忽略退出失败 */
    }
    state.files = [];
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
        : '还没有文件。管理员可以在上方拖拽上传。';
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

      tr.append(tdName, tdSize, tdDate, tdAct);
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

  /* ------------------------------------------------------------- 启动 */

  (async function boot() {
    try {
      const session = await request('/api/session');
      state.maxUploadMb = session.maxUploadMb || state.maxUploadMb;
      if (session.authenticated) showApp(session.user || '管理员');
      else showLogin();
    } catch {
      showLogin('无法连接服务器');
    }
  })();
})();
