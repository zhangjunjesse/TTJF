# v0.15 SQLite 运行与数据操作

当前运行方式为单机、单 Node.js 服务进程和本地 SQLite 文件，决定见 [SQLite 迁移](sqlite-migration.md)。默认无需 PostgreSQL 或 Docker；公网 HTTPS 和真实邮件仍在对应部署环境验收。

## 本地启动

需要 Node.js >=22.17。进入项目目录执行：

```powershell
npm ci --ignore-scripts
npm start
```

打开 http://127.0.0.1:4180/。应用自动建立私有 `data/ttjf.sqlite` 并执行版本迁移。本机 HTTP 只用于回环地址；账号、数据库和邮件均走真实流程，验证、邀请和恢复邮件使用 SMTP。普通启动没有自动文件邮箱回退；`DEV_MAIL_DIR` 只保留给显式选择本地捕获的测试，生产禁止使用。

启动会根据 `INITIAL_ACCOUNT_EMAIL` / `INITIAL_ACCOUNT_PASSWORD` 补建缺失账号，默认邮箱为 `391504704@qq.com`。密码由私有环境配置注入，以 scrypt 保存。该运维预置账号首次创建即为已验证，可直接登录；已有账号不改密码、不改验证状态、不重建家庭。没有预置家庭或旧存档；其他用户仍须注册和邮箱验证。首次登录后自行填写家庭名和孩子称呼。旧 PostgreSQL 账号不会因此迁入。

执行 `npm run db:init` 生成被 Git 忽略的 `.env.saas.local`，填写 `INITIAL_ACCOUNT_PASSWORD` 和 `SMTP_PASS`。模板采用 `smtp.qq.com:465` 和初始邮箱；不填写真实凭据的模板不能直接完成初始化。`npm start` 和 `npm run dev:saas` 都会在文件存在时读取它；外部环境变量优先。已有配置不会被自动覆盖。

当前维护者的账号和邮件配置另保存在私有 `data/initialize-private.ps1`。该脚本只在 `.env.saas.local` 缺失时创建运行配置；`tools/start-saas.ps1` 会调用它，随后由服务启动执行账号初始化。脚本包含秘密，必须像数据库备份一样私下保管，不提交 Git、不通过 HTTP 分发。部署到服务器时私下转移所需配置，并设置生产 HTTPS 来源；无需重新设计账号和邮件流程。

旧 PG 的 `.env.saas.*` / `DATABASE_URL` 不能直接作为 SQLite 配置使用，应先保存旧库及配置，再移除 `DATABASE_URL`、明确选择新的数据库路径。同时设置 `SQLITE_FILE` 也不会绕过旧配置保护，容器默认路径同样如此。

常用配置：

| 变量 | 含义 |
| --- | --- |
| `SQLITE_FILE` | 私有本地数据库路径，默认项目 `data/ttjf.sqlite` |
| `SAAS_HOST` / `SAAS_PORT` | 监听地址和端口，默认 `127.0.0.1:4180`；兼容 `HOST` / `PORT` |
| `PUBLIC_ORIGIN` | 邮件链接及同源校验使用的站点来源；开发命令默认本机地址，生产必须显式 HTTPS |
| `INITIAL_ACCOUNT_EMAIL` / `INITIAL_ACCOUNT_PASSWORD` | 缺失账号的首次创建配置；已有账号保持不变。显式填写邮箱而缺少密码会拒绝启动 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 真实邮件服务器、端口、邮箱及授权码；QQ 使用 smtp.qq.com、465 |
| `DEV_MAIL_DIR` | 仅供测试显式选择的文件邮件目录；须 development + loopback，生产禁止；普通启动不自动设置 |

退出应用使用 Ctrl+C；连接和当前清理任务会收尾，数据库文件保留。更新源码/依赖后再启动，应用按迁移版本升级数据库；升级前先备份。不要删除或覆盖 `data/`，也不要同时启动多个服务进程操作同一个数据库。测试自行使用临时目录，不需要手动建测试库。

## 直接部署 Node 服务

安装依赖，准备持久化私有目录和生产环境文件。例如复制 `saas.env.example` 为被 Git 忽略的 `.env.saas.production`，设置：

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://your-domain.example
SAAS_HOST=127.0.0.1
SAAS_PORT=4180
SQLITE_FILE=/srv/ttjf-data/ttjf.sqlite
MAIL_FROM=小小向前 <no-reply@your-domain.example>
SMTP_HOST=your-smtp-host.example
SMTP_PORT=587
SMTP_USER=YOUR_SMTP_ACCOUNT
SMTP_PASS=YOUR_SMTP_PASSWORD
INITIAL_ACCOUNT_EMAIL=391504704@qq.com
INITIAL_ACCOUNT_PASSWORD=YOUR_INITIAL_ACCOUNT_PASSWORD
```

路径、域名和密码占位值均需替换。若不需要预置账号，移除两项 `INITIAL_ACCOUNT_*`；不要保留邮箱而留空初始密码。Windows 可使用本机私有绝对路径。运行账号必须能读写数据库所在目录，因为 SQLite 需要创建回滚日志；目录不得由静态网站公开提供，也不得放在网络共享盘。数据库与备份不进入 Git。

```powershell
npm ci --omit=dev --ignore-scripts
node --env-file=.env.saas.production saas-server.cjs
```

由操作系统现有服务管理器保持这个单进程运行，使用现有 HTTPS 入口代理到本机 4180。无需额外引入队列、Redis、数据库容器或编排系统。生产不能使用开发文件邮箱；SMTP 可改用 `SMTP_URL`，不要混用两套配置。465 使用隐式 TLS，其他端口在生产要求 STARTTLS。

反向代理只应把可信请求送到本机监听。应用默认不信任 `X-Forwarded-For`；确实经代理时，设置 `SAAS_TRUSTED_PROXIES` 为逗号分隔的精确 IPv4/IPv6 地址，不支持 CIDR 或通配符。代理必须覆盖客户端传入的转发头。TLS 站点可按实际环境采用：

```nginx
location = /api/assistant/voice/stream {
    proxy_pass http://127.0.0.1:4180;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 90s;
    access_log off;
}
location = /api/award-photos {
    proxy_pass http://127.0.0.1:4180;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    client_max_body_size 1028k;
}
location / {
    proxy_pass http://127.0.0.1:4180;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    client_max_body_size 256k;
}
```

启用加分照片时，请同步更新反向代理的上传路径限制。每张 JPEG 压缩后最多 768 KiB，经过 Base64 编码的上传请求最多 1028 KiB。已入账照片随 SQLite 备份，也可随单家庭 JSON 备份迁移。单家庭 JSON 超过 64 MiB 时使用整库备份。

`GET /api/health` 检查数据库可用性，只返回健康状态。生产启动成功不等于 SMTP 已实际投递或 HTTPS 代理已验收；注册、邀请、找回应在授权测试账号完成外部验收。

## 家长助手语音识别

在服务进程读取的私有配置文件（本机 `.env.saas.local`，生产按实际服务配置）填写 `VOLC_ASR_API_KEY`，或填写旧版的一对 `VOLC_ASR_APP_KEY` 和 `VOLC_ASR_ACCESS_KEY`。使用火山语音控制台中与已开通资源对应的密钥。重启服务并重新打开页面后生效。凭证只由服务端读取。可用 `ASR_PROVIDER=browser` 切回浏览器听写。

- 默认 `VOLC_ASR_MODE=bigmodel_async` 使用双向流式优化版，按住时显示中间字幕。也支持 `bigmodel` 和 `bigmodel_nostream`。后者适合等整段结果，短句录音期间可能没有字幕。默认资源 ID 为 `volc.seedasr.sauc.duration`，可用 `VOLC_ASR_RESOURCE_ID` 改为实际开通的资源。热词示例为 `VOLC_ASR_HOTWORDS=["积分","刷牙"]`。[火山流式识别协议](https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh)
- 浏览器申请单声道采集、回声消除、降噪和自动增益，实际效果取决于设备和环境。Web Audio 将采集结果转换成 16 kHz 单声道、16 位小端 PCM，每 50 毫秒发给本站。本站按火山建议合并为 200 毫秒一包，松手补发剩余采样。端点检测由火山处理。页面只显示中间结果，整段定稿才能进入助手。开始传输音频前可以自动重连一次，传输中断后需要重新录音。[火山双向流式接口](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)
- 外网需使用 HTTPS，本机可用 localhost 或回环地址。反向代理需支持上方 WebSocket 配置。音频从按住时开始传输，上滑取消无法撤回此前已传出的音频。时长计费以开通的资源为准，应将已发送的静音也计入费用估算。[火山计费说明](https://docs.volcengine.com/docs/doubao-voice/billing-instructions?lang=zh)

同一标签页一次只采集一路麦克风。火山录音最长 60 秒，切到后台导致录音中断时，回到页面重新按住即可。火山收到的热词来自服务端配置。浏览器原有的家庭名称匹配只用于本地核对候选词。

在 Android 等移动设备上，浏览器和麦克风会影响回声消除与降噪的效果。用目标手机分别在安静处和有人说话时读同一句含名字、分数的指令，核对最终文字。排查字幕慢时，分别记录按住到提示收音、开始说话到首条字幕、松手到定稿的时间。音频采集、分包、网络和识别都会影响等待时间。`bigmodel_nostream` 模式主要看松手到定稿。[浏览器音频采集规范](https://www.w3.org/TR/mediacapture-streams/#media-track-constraints)

测试时可设置 `ASSISTANT_FLOW_CASE=cloud-voice` 再运行 `npm run test:assistant:flow`，用合成音频验证按住发送、取消、断线和听写草稿。

## 整库备份和恢复

备份包含账号、家庭、账本、核验摘要和操作回执，属于私有数据。工具使用 SQLite 一致性备份 API，拒绝覆盖已有输出。项目内备份只允许位于私有 `data/`，也可选择项目外私有路径。

```powershell
npm run db:backup -- --output data/backups/ttjf-20261117.sqlite
```

备份源由 `SQLITE_FILE` 指定；生产可直接运行 `node --env-file=.env.saas.production tools/saas-db.cjs backup --output PRIVATE_FILE`。对完整备份做私有异机保存，并定期用恢复流程核对，而不是直接复制正在写入的数据库文件。

恢复前停止应用。恢复写入一个不存在的新文件，验证数据库完整性、外键和应用结构；不会覆盖仍在使用的目标。恢复过程使旧会话和一次性凭据失效，避免历史备份重新启用曾被撤销的登录和授权。

```powershell
npm run db:restore -- --source data/backups/ttjf-20261117.sqlite --output data/restored.sqlite --app-stopped
```

随后设置 `SQLITE_FILE` 指向恢复文件，在本机重新登录并核对家庭、积分、农场数据，确认后恢复正常访问。原库和原备份保留；恢复不会自动更改部署配置或切换流量。确切参数可运行 `node tools/saas-db.cjs --help` 查看。

## 家庭私有导出与旧存档导入

`tools/saas-data.cjs` 保留家庭级工具；该格式包含业务状态、家长核验摘要和动作回执，不包含账号、成员、会话和邀请。它不能替代整库备份。

```powershell
npm run saas:data -- backup --family FAMILY_UUID --owner OWNER_EMAIL --output data/backups/family.json
npm run saas:data -- import --source PRIVATE_SOURCE.json --family TARGET_FAMILY_UUID --owner OWNER_EMAIL
npm run saas:data -- import --source PRIVATE_SOURCE.json --family TARGET_FAMILY_UUID --owner OWNER_EMAIL --apply
```

导入先默认 dry-run；实际应用需已验证所有者和新建空家庭，目标不能已设置家长核验、开启农场或出现业务活动。原文件只读，事务保留原账本、农场、核验摘要与动作回执；重复导入拒绝，失败全部回滚。旧 PG 环境可由旧版本工具导出家庭，再在新 SQLite 版本明确创建接收账号和空家庭；本轮不提供整个 PG 账号数据库的自动转换，也不接触真实用户存档。

## 可选容器部署

现有 `Dockerfile.saas`、`compose.production.yml` 作为可选方式保留；默认安装不依赖它们。镜像使用内置 SQLite，持久卷挂载到 `/app/data`，根文件系统只读、进程使用非 root 用户。删除数据卷会删除数据库，不作为日常升级步骤。

```sh
docker compose --env-file .env.saas.production -f compose.production.yml config --quiet
docker compose --env-file .env.saas.production -f compose.production.yml build --pull
docker compose --env-file .env.saas.production -f compose.production.yml up -d
```

Compose 强制库路径为 `/app/data/ttjf.sqlite`，端口默认只发布到主机 `127.0.0.1:4180`。容器恢复后需要通过 Compose override 把 `environment.SQLITE_FILE` 改为同一持久卷内的恢复文件路径；仅修改 `.env.saas.production` 的同名变量不会覆盖 Compose 的强制值。桥接代理地址配置要与实际入口一致，生产镜像应固定经过审查的摘要。本轮未运行容器，不能把模板存在或配置语法检查称作部署通过。

## 原有业务及运维边界

- 家庭日固定上海；浏览器设备时区不改变兑换日与积分日期。作物按经过时长成熟。
- 临时记录清理默认每 300000ms、每表最多 200 条；`SAAS_CLEANUP_INTERVAL_MS` 允许 0 关闭或 1000..86400000，`SAAS_CLEANUP_BATCH_SIZE` 允许 1..1000。仅清理临时会话/令牌等，不删除永久业务回执与家庭记录。
- AI 配置沿用 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`，未配置则使用本地指令演示；家庭在途请求上限保留。
- 多家庭隔离、逐笔家长核验、页面隐藏遮蔽、跨页签退出、上海家庭时间保持原功能要求。`server.cjs` 旧单户文件服务仍独立运行，不能代替当前多家庭服务。
- 当前不包含支付、多孩子账本、任意家庭时区或组织管理员后台。

## 开发验证

```powershell
npm test
npm run test:saas
npm run test:browser
npm run test:browser:full
```

数据库测试创建真实临时 SQLite 文件并清理，不依赖外部服务。浏览器需要本机 Edge/Chrome，可设置 `BROWSER_PATH`；`TEST_ARTIFACT_DIR` 可指定本轮输出目录。长任务可按文件或场景分块执行，记录每块结果与覆盖，不把未执行用例算作通过。

本轮实际命令与结果见 [SQLite 验证记录](sqlite-verification.md)。历史 `tools/verify-saas-release.cjs` 是 v0.14 固定证据校验器，不用于 v0.15。物理 iPad/Safari、外部 SMTP/HTTPS、容器运行、生产数据恢复和长期负载尚需在实际环境验收。
