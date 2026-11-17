# v0.14 SaaS 运行与数据操作

本页描述当前运行入口、配置和运维工具。基础账号/租户决定见[saas-design.md](saas-design.md)，生命周期、恢复和完整验收见[saas-completion.md](saas-completion.md)。公网域名、实际SMTP服务、线上备份策略和物理iPad仍须在对应环境验收；本机通过不等于已经上线。

## 开发环境

需要Node.js >=22.17、Docker Compose和已安装的Edge/Chrome（浏览器测试使用）。从项目根目录执行：

```powershell
npm ci --ignore-scripts
npm run db:init
npm run db:up
npm run db:bootstrap
npm run dev:saas
```

[初始化工具](../tools/saas-local.cjs)生成随机凭据；已有完整配置不覆盖，缺失一部分时停止。配置文件均被Git忽略：

- `.env.saas.postgres`：仅供本机PostgreSQL容器初始化的管理员凭据。
- `.env.saas.local`：非超级用户的开发库连接、4180端口和发信配置（开发文件邮箱或SMTP）。
- `.env.saas.test`：独立测试数据库连接，不指向开发库。

[Compose定义](../compose.saas.yml)固定镜像摘要，容器为`ttjf-saas-pg-v13`，持久卷为`ttjf-saas-pgdata-v13`，仅监听`127.0.0.1:55432`。数据库分别为`ttjf_saas`和`ttjf_saas_test`。应用角色`ttjf_app`不是超级用户，不能创建角色或数据库。初始化工具只对这个明确的本机地址和角色进行配置。

启动后打开 <http://127.0.0.1:4180/>。新安装不会自动创建账号或家庭；正常流程为注册、验证邮箱、登录，再创建家庭。初始化工具默认把验证/邀请/恢复邮件写入`DEV_MAIL_DIR`指定的私有目录（默认`data/saas-mail`），这种文件发信模式不会投递到真实邮箱。注册后查看对应JSON的`to`、`subject`和`text`，复制链接到当前浏览器并确认。该目录不提供HTTP访问，不能放在assets中或公开分享。配置`SMTP_HOST`或`SMTP_URL`后改用实际SMTP发信；邮件链接仍由`PUBLIC_ORIGIN`决定。

用户明确指定的本机初始账号已按[初始用户决定](saas-initial-user.md)完成一次性准备，凭据不随仓库分发。该账号可直接登录并创建家庭；家庭创建者获得owner权限，账号没有平台超管或跨家庭访问权。程序启动不会重置该密码、复建用户或自动分配旧存档。

停止应用用终端Ctrl+C；应用会释放连接。停止本机数据库可用`docker compose -f compose.saas.yml stop`，保留卷。重新运行`npm run db:up`即可启动。删除持久卷会删除开发与测试数据库，本页不提供一键清空命令。

旧单户服务由`npm run start:legacy`启动，默认4178，以旧JSON文件为权威。它不自动接入SaaS，不能作为多家庭互联网服务。SaaS启动不读取旧JSON，也不把旧存档分配给第一个注册者。

## 生产配置

应用仍运行HTTP，由同机可信反向代理终止TLS。为进程设置下列环境变量后运行`npm start`。示例中的值都是占位符，需替换；配置不要提交Git。

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://your-domain.example
SAAS_HOST=127.0.0.1
SAAS_PORT=4180
DATABASE_URL=postgresql://APP_USER:ENCODED_PASSWORD@DB_HOST:5432/APP_DATABASE?sslmode=verify-full
MAIL_FROM=小小向前 <no-reply@your-domain.example>
SMTP_HOST=your-smtp-host.example
SMTP_PORT=587
SMTP_USER=YOUR_SMTP_ACCOUNT
SMTP_PASS=YOUR_SMTP_PASSWORD
```

- `PUBLIC_ORIGIN`必须是站点的完整HTTPS来源，不带路径、查询、用户名或密码。来源不符的写入会被拒绝。
- PostgreSQL连接中的密码按URL编码；按数据库服务的要求配置受信CA。使用最小必要权限的应用角色；迁移需要当前schema的建表权限。应用在数据库迁移锁下执行[001基础迁移](../saas/migrations/001-initial.sql)与[002生命周期迁移](../saas/migrations/002-lifecycle.sql)，并按迁移版本避免重复执行002。
- SMTP可改用`SMTP_URL`，支持`smtp://`和`smtps://`；不要同时混用两套配置。465使用隐式TLS，其他端口在生产要求STARTTLS。生产拒绝注入测试发信器，也不会回退到开发文件邮箱。
- HTTPS的会话Cookie含Secure、HttpOnly、SameSite=Lax；写请求还需来源检查和CSRF。不要在反代改写站点来源，内部HTTP监听只绑定可信接口。
- 默认不信任`X-Forwarded-For`。确有反向代理时设置`SAAS_TRUSTED_PROXIES`为逗号分隔的精确IPv4/IPv6地址；不接受CIDR、通配符或任意信任。只有直接连接地址被信任时才从转发链右向左选第一个不可信客户端地址，混乱/重复/过长头回退到直接地址。反代应覆盖外部转发头。配置缺失时多人可能共用代理地址的匿名限速。
- 家庭日固定为Asia/Shanghai。前端依据服务器校准时间显示家庭日期、星期、加分时间和提醒；设备时区不改变周末或月底兑换。农作物按实际经过时长成熟。
- 可选AI沿用`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`；不配置时为原有指令演示。数据库共享的家庭并发租约最多2个，第三个被拒绝；服务实例退出后租约会过期。
- 临时记录维护默认每300000ms执行，每张表每批最多200条。`SAAS_CLEANUP_INTERVAL_MS`允许0关闭定时器或1000..86400000；`SAAS_CLEANUP_BATCH_SIZE`允许1..1000。使用事务级advisory锁协调多实例、跳过被锁行；错误回滚整批，日志不带凭据。维护不删除家庭业务、永久回执或导入审计，没有匿名HTTP维护入口。服务器关闭会停止计时器并等待当前批次。

健康入口`GET /api/health`检查数据库连通性，只返回健康状态，不返回家庭数量或业务状态。SMTP配置能启动不等于实际投递成功：需要在授权的真实邮箱完成注册、邀请和恢复的外部验收。邮件失败记录简短错误码，不输出密码或令牌；注册/找回仍用统一响应避免泄露邮箱是否存在。

当前没有计费、支付、套餐限制、组织管理员后台或多孩子账本。一个账号可加入多个家庭，owner和parent都不成为额外计分孩子。家庭改名、退出、所有权交接、自助删除与账号注销由页面提供，交接与删除要求账号当前密码；owner必须先移交或删除所有拥有的家庭，才可注销。

## 容器与反向代理模板

[Dockerfile](../Dockerfile.saas)、[生产Compose](../compose.production.yml)、[环境示例](../saas.env.example)和[构建排除规则](../.dockerignore)是当前可审查模板。镜像只复制运行文件和公开资源，使用非root用户、只读根文件系统、临时目录、进程/内存上限和数据库健康检查；不打包真实数据、环境秘密、测试工具、文档证据或历史ZIP。

复制环境示例为被Git忽略的`.env.saas.production`，替换数据库、域名、SMTP占位值。数据库是外部管理的PostgreSQL，容器内的localhost不是主机数据库地址。生产应把`SAAS_NODE_IMAGE`固定到经过审查的Node22镜像摘要。按需要选择未占用的网段/端口；以下命令是部署步骤，未在公网执行：

```sh
docker compose --env-file .env.saas.production -f compose.production.yml config --quiet
docker compose --env-file .env.saas.production -f compose.production.yml build --pull
docker compose --env-file .env.saas.production -f compose.production.yml up -d
```

默认只向主机`127.0.0.1:4180`发布HTTP。Docker桥接网段为`172.30.80.0/28`，主机网关`172.30.80.1`作为精确信任代理；修改`SAAS_PROXY_ADDRESS`时要同时保证它与实际Docker网关一致。反向代理须运行在该主机，TLS由它终止。若已有4180服务，先安排切换或改`SAAS_PUBLISHED_PORT`并相应调整反代目标。不要把模板直接叠加到当前开发预览。

下面是Nginx TLS站点内的最小location片段，证书和真实server_name由部署者配置；这里覆盖客户端自行提交的转发头，不透传未经核验的前缀：

```nginx
location / {
    proxy_pass http://127.0.0.1:4180;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    client_max_body_size 256k;
}
```

本机Compose配置校验通过。实际镜像构建已尝试，但DockerHub匿名令牌端点连接超时，停在基础镜像元数据获取；**镜像未构建成功、容器运行与上述Nginx配置未验证**。这不影响已经运行的本机Node入口。公网HTTPS、SMTP投递、代理实际客户端地址与镜像漏洞/摘要检查仍需在部署环境验收。

## 页面恢复与隐私

SaaS不在localStorage或sessionStorage保存家庭业务、草稿、PIN或grant。每个请求绑定当时的账号、家庭和页面作用域；切换/logout/失效后迟到结果被丢弃。唯一设备偏好是独立键`ttjf-saas-device-sound-v1`中的音效布尔值。已有账号通知键`ttjf-saas-auth-change-v1`只记录随机操作标识与退出阶段，不含用户或家庭信息；刷新时可读取尚未结束的退出标记，防止旧会话恢复。退出开始立即销毁草稿并锁定其他页签，直到确定结果；失败时显示重试退出。

隐藏时家庭DOM立即清空，音频、语音、wake和3D资源停止；普通草稿仅保留在内存。回到页面先校验服务器会话和家庭，再用最新业务版本恢复同一账号/家庭/会话中的非敏感编辑。PIN、密码、challenge、grant和自动提交事务不恢复；身份/会话变化或成员撤销会销毁保存内容。只有focus不会销毁表单；头像文件选择保留独立input，返回结果仍必须通过原会话与家庭重验。原生OS图片选择、系统挂起与BFCache仍需真机验收。

## 旧家庭导入

[私有数据工具](../tools/saas-data.cjs)是运维CLI，不通过网页提供。原始文件只读；默认dry-run；执行时要求明确目标家庭UUID和已验证的所有者邮箱。目标必须是刚创建、未设置家长核验、没有任何业务活动的空家庭。不会覆盖已有账本或偷偷接管账号。

1. 由接收者自行注册、验证并创建一个空家庭。暂不设置PIN或开启农场。
2. 在受控运维环境确认数据归属，准备私有`{revision,state,parent,receipts}`存档。普通网页业务导出缺少私有凭据，不可直接冒充完整恢复文件。
3. 先检查dry-run输出的源摘要、目标家庭和记录数量；确认后才加`--apply`。

```powershell
node --env-file-if-exists=.env.saas.local tools/saas-data.cjs import --source "PRIVATE_SOURCE.json" --family "TARGET_FAMILY_UUID" --owner "OWNER_EMAIL"
node --env-file-if-exists=.env.saas.local tools/saas-data.cjs import --source "PRIVATE_SOURCE.json" --family "TARGET_FAMILY_UUID" --owner "OWNER_EMAIL" --apply
```

上面脚本在存在时加载`.env.saas.local`；外部已设置的环境变量优先。生产应直接注入正确的`DATABASE_URL`，也可执行`node tools/saas-data.cjs ...`。不要把密码作为命令行参数。

导入事务验证归属、空白条件、模型、私有核验摘要和动作回执，然后一起写入；任何失败全部回滚。原有孩子、历史积分、兑换、农场、PIN摘要与回执内容保留。旧scrypt默认16384工作因子继续有效。目标版本取`max(源版本,目标版本+1)`，使已经打开的空白页面失效；源版本和SHA-256另存入导入审计。原文件不改，重复导入被拒绝。目标ID和成员关系保持目标家庭自己的值，不继承未知账号。

本轮仅用合成存档验收，未读取或导入用户真实旧家庭。

## 家庭私有备份与恢复

```powershell
node --env-file-if-exists=.env.saas.local tools/saas-data.cjs backup --family "FAMILY_UUID" --owner "OWNER_EMAIL" --output "data/backups/private-family.json"
```

此备份含家庭业务、私有家长核验摘要及完整动作回执。输出文件以独占创建方式写入并同步落盘，既有文件拒绝覆盖。项目内只允许写在Git忽略的`data/`下；拒绝assets、源码目录及解析到这些目录的路径。外部路径由操作者选择私有位置。不要发给其他用户或放到网盘公共链接。

恢复时建立一个归属明确的新空家庭，再按前一节先dry-run、后apply。恢复保留业务与逐笔核验，但不会迁移登录账号、成员、会话、邀请或旧grant。已验证的所有者可以重新邀请成员。这不是整个SaaS数据库的备份替代。

## 整库备份与灾难恢复

生产使用数据库服务商的备份/PITR或PostgreSQL原生`pg_dump`。以下是运维步骤，**本轮未在真实生产库执行**。先配置受保护的PGPASSFILE及PGHOST、PGPORT、PGUSER、PGDATABASE、TLS环境参数，避免把数据库密码展开到进程参数或日志。

```text
pg_dump --format=custom --no-owner --file=PRIVATE_BACKUP.dump
pg_restore --list PRIVATE_BACKUP.dump
```

备份应加密存放并定期在隔离环境恢复验证。`pg_restore --list`用于先检查归档；实际恢复指向另行创建的空数据库，不能覆盖仍在使用的生产库，不先让应用创建空表：

```text
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname=NEW_EMPTY_DATABASE PRIVATE_BACKUP.dump
```

恢复后、接入流量前，需要使归档中的会话和一次性令牌失效，防止已撤销的旧凭据因历史备份而重新可用。在**恢复目标库**确认连接后执行：

```sql
BEGIN;
UPDATE saas_sessions SET revoked_at=now() WHERE revoked_at IS NULL;
UPDATE saas_email_tokens SET consumed_at=now() WHERE consumed_at IS NULL;
UPDATE saas_invitations SET revoked_at=now() WHERE consumed_at IS NULL AND revoked_at IS NULL;
DELETE FROM saas_parent_grants;
DELETE FROM saas_parent_challenges;
DELETE FROM saas_assistant_leases;
COMMIT;
```

随后在隔离环境验收登录、各家庭隔离、账本/农场对账，再由操作者决定切换生产连接。这里没有执行自动切换、删除旧库或对外发布。

## 本轮证据与边界

- [核心回归](../artifacts/v14-core-tests.txt)：227通过，0失败/跳过，包括当前v14客户端、原领域/旧服务、空家庭及四个系统时区下的上海家庭日回归。退出等待/失败/同时退出/刷新/存储禁用新增回归包含在该数量内。
- [真实PostgreSQL回归](../artifacts/v14-saas-tests.txt)：42通过，0失败/跳过，包括生命周期竞争、两实例并发、数据库故障回滚、账号/邀请撤销、真实本机SMTP、临时记录清理及合成私有备份/CLI恢复。
- [全动作审查](../artifacts/v14-action-audit.json)：27类、98变体、528条分组检查，均验证HTTP授权与SQL落库、异户拒绝、同回执重放及篡改拒绝。该审查包含在42项数据库回归中，不重复计数。
- [浏览器验收](../artifacts/v14-saas-verification.md)：身份隔离21/21及完整业务27/27，69截图、28布局检查、0脚本错误/跳过；真实HTTP/PostgreSQL、浏览器点击、五视口和48px目标。失败/诊断轮保留，不能当作最终通过。成熟/跨日使用受控时钟，恢复页派发事件不等同真实BFCache/iPad挂起。
- [v13历史验收](../artifacts/v13-saas-verification.md)保留原211核心、23数据库、21浏览器结果；不替代v14验收。
- 外网投递、公开域名/HTTPS、容器实际运行、云数据库故障恢复、物理iPad/Safari、麦克风和长时间前台性能均不由这些证据覆盖。
