# FileBox · 私有文件下载站

一个可以**在 GitHub 上一键部署**的文件下载服务：管理员 + 注册账号，各自独立空间 → 上传/管理自己的文件 → 登录后下载自己的文件（管理员可看全部）。
后端是零外部依赖的 Node + Express，自带 Dockerfile 和 Render 蓝图，可以扔掉服务器运维那套东西。

```
浏览器 ──登录──▶ Node 服务 ──▶ 存储目录 (/data)
                     │
                     └─ 会话鉴权 / 上传 / 列表 / 下载 / 删除
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 多账号 | 管理员 + 普通账号，**每个账号只看得见自己上传的文件**；管理员额外看到全部 |
| 管理员授予 | 管理员可以把自己的二级密码作为凭证，把普通账号提升为管理员；被提升的人登录后自己设置二级密码 |
| 二级密码 | 只有管理员有，用于授予管理员这类高危操作；修改二级密码必须先提供旧的（首次设置除外） |
| 登录锁定 | 同一 IP 连续输错 5 次密码锁定 30 秒，锁定期间正确密码也进不去 |
| 注册开关 | 网页后台一键开关，默认关闭；打开后访客可自助注册（账号各自独立空间） |
| 实时改密码 | 后台直接改管理员密码，保存即生效、旧登录状态立刻失效，无需重启服务 |
| 账号登录 | 用户名 + 密码（scrypt 加盐存储），服务端签发 HttpOnly 会话 Cookie，登录态默认 12 小时 |
| 文件下载 | 列表 + 搜索 + 一键下载，保留中文/原始文件名，支持断点续传（Range） |
| 上传管理 | 拖拽或点选，多文件上传、带进度条、重名自动加 `(1)` 后缀 |
| 删除文件 | 列表内直接删除，二次确认 |
| 安全 | 未登录一律 401、Cookie `HttpOnly` + `SameSite=Lax` + CSRF 来源校验、登录失败 5 次锁 30 秒、路径穿越防护、退出登录服务端吊销会话、改密码后旧会话立即失效 |
| 移动端 | 响应式布局，手机上也能下载 |

## 一键部署

### 方式 A：Render（推荐，有免费额度）

1. **把本项目推到 GitHub**
   - 有 git：`git init && git add -A && git commit -m "init" && git push`
   - **没有 git**：在 GitHub 网页上新建仓库 → 点 `Add file → Upload files` → 把本目录里除 `node_modules/`、`storage/`、`.env` 之外的文件全部拖进去 → Commit。（GitHub 网页上传不会自动带上点开头的配置文件，`.gitignore`、`.env.example`、`.github/` 可以之后按需补，不影响部署）
2. **整理成下面这个链接**（把 `<用户名>/<仓库名>` 换成你的）：

   ```
   https://render.com/deploy?repo=https://github.com/<用户名>/<仓库名>
   ```

3. 用 GitHub 账号登录 Render，打开上面这个链接 → Render 会自动读取仓库里的 `render.yaml` → 直接确认创建，**不用填任何配置**。
4. 一两分钟后拿到形如 `https://file-box-xxxx.onrender.com` 的地址，打开就是登录页。

> 初始账号：`xujunyao`　密码：`shenye128`
> 登录后点右上角「管理」，可以直接改密码（即时生效，不用重启服务），也能打开/关闭注册入口。

> 免费实例闲置约 15 分钟后会休眠，下次访问需要 30–60 秒冷启动（页面会转一会儿才出来，属正常现象），要一直在线就升级成 Starter。

### 方式 B：Railway / Zeabur / Sealos 等任意支持 Docker 的平台

这些平台都认 Dockerfile，流程一致：

1. 新建项目 → 选择 `Deploy from GitHub repo` → 选中本仓库；
2. 平台自动识别 `Dockerfile` 构建；
3. 在环境变量里补上 `ADMIN_USER`、`ADMIN_PASSWORD`、`SESSION_SECRET`；
4. 挂载一个持久卷到 `/data`（可选，不挂就是重启丢文件）。

### 方式 C：自己的服务器 / 本地 Docker

```bash
docker build -t file-box .
docker run -d --name file-box -p 3000:3000 \
  -e ADMIN_USER=xujunyao \
  -e ADMIN_PASSWORD=shenye128 \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e COOKIE_SECURE=true \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  file-box
```

访问 `http://服务器IP:3000`。前面套一层 Nginx / Cloudflare 拿 HTTPS 时，记得 `COOKIE_SECURE=true`。

## 本地运行

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 改代码自动重启
npm test           # 冒烟测试：登录/上传/列表/下载/删除/退出全链路
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./storage` | 文件存储目录；容器内建议 `/data` |
| `ADMIN_USER` | `xujunyao` | 登录账号 |
| `ADMIN_PASSWORD` | `shenye128` | 初始管理员密码，**只在账号文件不存在时生效**；之后改密码请用网页后台 |
| `ADMIN_SECOND_PASSWORD` | `xujunyaoNB666` | 主管理员的初始二级密码，**只在库里还没有二级密码时写入一次**；之后请用网页后台改 |
| `LOGIN_LOCK_SECONDS` | `30` | 连续输错 5 次后的锁定时长（秒） |
| `USERS_FILE` | `DATA_DIR/.users.json` | 账号与注册开关的存储文件（含密码哈希，不进 Git） |
| `SESSION_SECRET` | 每次启动随机 | 会话签名密钥；不固定的话重启后需要重新登录 |
| `SESSION_TTL_HOURS` | `12` | 登录有效期（小时） |
| `MAX_UPLOAD_MB` | `512` | 单文件大小上限 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设 `true` |

## ⚠️ 关于文件存储（部署前必读）

服务把文件存在 `DATA_DIR` 这个本地目录里，**它不跟随代码仓库，也不进 Git**。

- **Render 免费实例没有持久磁盘**：重新部署、实例休眠重建后，磁盘会重置，上传的文件会丢失。三种解法：
  1. 升级到带 Persistent Disk 的实例（`render.yaml` 里把末尾 `disk:` 那段取消注释即可，`mountPath: /data` 已配好）；
  2. 文件放自己服务器 / VPS 上跑 Docker，用 `-v` 挂卷，最稳；
  3. 文件本来就不多的话，也可以把文件直接放在仓库里（见下方「往仓库里预置文件」）。
- 想确认当前实例的文件还在不在：打开页面看列表，或 `GET /healthz` 看服务是否醒着。

### 往仓库里预置文件（不依赖上传）

`storage/` 默认不进 Git。如果希望「部署完就有文件可下」，可以：

1. 把文件放进 `storage/` 目录；
2. 删掉 `.gitignore` 里的 `storage/` 那两行；
3. 提交推送 —— 部署后这些文件会随代码一起上线（适合镜像、安装包这类不常变的大文件；注意 GitHub 单文件 100MB 上限）。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查 |
| `GET` | `/api/session` | 当前登录状态 |
| `POST` | `/api/login` | `{username, password}` 登录 |
| `POST` | `/api/register` | `{username, password}` 注册，仅在后台开启注册时可用 |
| `GET` | `/api/admin/settings` | 后台设置与账号列表（需管理员） |
| `POST` | `/api/admin/settings` | `{allowRegister}` 开关注册入口（需管理员） |
| `POST` | `/api/admin/password` | `{password}` 实时改管理员密码，旧会话立即失效（需管理员） |
| `POST` | `/api/admin/users/password` | `{username, password}` 后台重置某个账号的密码（需管理员） |
| `POST` | `/api/admin/users/delete` | `{username}` 删除账号并清空其文件目录；管理员账号不可删（需管理员） |
| `POST` | `/api/admin/users/reset-code` | `{username}` 为普通账号生成/更换 8 位重置码（30 分钟有效，需管理员） |
| `POST` | `/api/admin/users/grant` | `{username, adminCode}` 用操作者自己的二级密码把普通账号提升为管理员 |
| `POST` | `/api/admin/second-password` | `{oldCode, newCode}` 设置/更换自己的二级密码；已有时必须提供旧值 |
| `POST` | `/api/password` | `{password}` 任何已登录账号自助改密码，旧会话全部失效（需登录） |
| `POST` | `/api/forgot/reset` | `{username, code, password}` 用重置码自助重置密码；管理员账号不可用 |
| `POST` | `/api/logout` | 退出并吊销会话 |
| `GET` | `/api/files` | 文件列表（需登录） |
| `POST` | `/api/upload` | `multipart/form-data`，字段名 `files`，可多文件（需登录） |
| `GET` | `/api/files/:id/download` | 下载（需登录，支持 Range） |
| `DELETE` | `/api/files/:id` | 删除（需登录） |

`:id` 是文件名的 base64url 编码，服务端会再校验一遍，不允许任何路径穿越。

## 目录结构

```
.
├── server.js                 # 后端全部逻辑（Express + busboy）
├── public/
│   ├── index.html            # 登录页 / 文件列表
│   ├── styles.css
│   └── app.js                # 前端交互与上传进度
├── scripts/smoke-test.mjs    # 冒烟测试
├── Dockerfile                # 任意容器平台可用
├── render.yaml               # Render 一键部署蓝图
├── .env.example
├── （可选）.github/workflows/ci.yml   # 测试工作流，推送它需要带 workflow 权限的令牌
└── storage/                  # 运行时生成：<用户名>/ 存文件，.users.json 存账号（不进 Git）
```

## 账号与空间（多用户）

- **存储布局**：`DATA_DIR/<用户名>/<文件名>`，一人一个目录。老版本平铺在 `DATA_DIR` 根目录的文件会在管理员第一次打开列表时**自动搬进管理员目录**，不会丢。
- **可见性**：普通账号只能读写自己目录里的文件，下载别人的文件 id 直接 404；管理员列表带「所属账号」列，可下载/删除所有人的文件。
- **账号数据**：`DATA_DIR/.users.json`（默认），密码用 `scrypt` 加盐哈希保存，文件权限 `0600`。它跟随 `DATA_DIR` 走，挂持久卷就会一直保留；`storage/` 已在 `.gitignore`，不会误传进 Git。
- **注册入口**：默认关闭。后台打开后任何人可自助注册，新账号天生带独立空目录；关掉后接口立即返回 403，已注册账号不受影响。
- **成员管理**：后台「已注册账号」每一行可「改密码」（重置该账号密码，立即生效，对方需用新密码重登）、「发重置码」、「授予管理员」和「删除」（删账号并一并删掉它的文件，删除前会二次确认）。
- **管理员之间互不改动**：非本人的管理员行不显示任何操作按钮，后端也会拒绝修改/删除/发重置码给另一个管理员账号（`/api/admin/users/password` 对他人管理员返回 403）。
- **二级密码**：只有管理员账号有，作用是给「授予管理员」这类高危操作上第二把锁。主管理员 `xujunyao` 的初始二级密码由 `ADMIN_SECOND_PASSWORD` 决定（默认 `xujunyaoNB666`），只在库里还没有二级密码时写入一次；之后想换必须在后台填「旧的二级密码 + 新的二级密码」，旧的对不上就拒绝。被提升为主管理员的账号初始没有二级密码，本人登录后在「管理 → 我的二级密码」里首次设置即可（首次允许不填旧值）。
- **登录锁定**：同一 IP 连续输错 5 次密码，锁定 30 秒，提示「密码输错次数过多，请 N 秒后再试」；成功登录会清零计数。
- **改密码**：顶栏「改密码」是账号自助入口（普通账号和管理员都能用），保存即生效——老密码立即失效，其它设备上的会话全部作废，当前浏览器会自动重新签发。
- **忘记密码**：普通账号在登录页点「忘记密码」→ 填「账号 + 重置码 + 新密码」即可自助重置。重置码要管理员在后台那行点「发重置码」生成（8 位、30 分钟有效、用一次就作废，重新生成会顶掉旧的）。**管理员账号不支持这条路径**，它自己在后台改密码。

## 安全边界（说清楚不装）

这版是**多账号 + 独立空间 + 管理员分级**，但不是企业级权限系统：没有账号审批、没有邀请码、没有按文件分享链接与有效期、没有审计日志。管理员能看全部文件，普通账号看不到别人的；管理员之间互不改动，谁能当管理员由二级密码把关。要更强的管控再加。

默认密码写在 `render.yaml` / `.env.example` 里只是为了开箱即用，**公开仓库请务必改成自己的密码**，或登录后立刻在后台改掉。
