# FileBox · 私有文件下载站

一个可以**在 GitHub 上一键部署**的文件下载服务：单个账号登录 → 上传/管理文件 → 任何人登录后即可下载。
后端是零外部依赖的 Node + Express，自带 Dockerfile 和 Render 蓝图，可以扔掉服务器运维那套东西。

```
浏览器 ──登录──▶ Node 服务 ──▶ 存储目录 (/data)
                     │
                     └─ 会话鉴权 / 上传 / 列表 / 下载 / 删除
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 账号登录 | 用户名 + 密码，服务端签发 HttpOnly 会话 Cookie，登录态默认 12 小时 |
| 文件下载 | 列表 + 搜索 + 一键下载，保留中文/原始文件名，支持断点续传（Range） |
| 上传管理 | 拖拽或点选，多文件上传、带进度条、重名自动加 `(1)` 后缀 |
| 删除文件 | 列表内直接删除，二次确认 |
| 安全 | 未登录一律 401、Cookie `HttpOnly` + `SameSite=Lax` + CSRF 来源校验、登录失败 5 次锁 15 分钟、路径穿越防护、退出登录服务端吊销会话 |
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

> 账号：`xujunyao`　密码：`shenye128`
> 要改的话去 Render 控制台 → 该服务 → Environment → 修改 `ADMIN_PASSWORD` → Save，服务会自动重启。

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
| `ADMIN_PASSWORD` | `shenye128` | 登录密码，**线上务必改掉** |
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
└── （可选）.github/workflows/ci.yml  # 测试工作流，需带 workflow 权限的令牌才能推送
├── .env.example
└── storage/                  # 运行时生成，存文件（不进 Git）
```

## 安全边界（说清楚不装）

这版做的是**单账号门禁**，不是多用户体系：只有一套账号密码，登录的人都能上传/删除。要多人分权、审计日志、分享链接有效期，需要另外加。

密码通过环境变量下发、比对用常量时间比较，但**默认密码写在 `render.yaml` 里只是为了开箱即用**，公开仓库请务必改成自己的密码（或改成 Render 部署时手动填写）。
