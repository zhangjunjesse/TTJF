# v0.13 多家庭 SaaS 基础版本（历史存储决定）

2026-11-17 更新：用户选择优先简化部署和维护。当前存储与部署以 [v0.15 SQLite 决定](sqlite-migration.md)为准；本页的 PostgreSQL、多实例与 schema 测试描述保留为历史。账号、家庭隔离及业务授权契约继续有效。

日期：2026-11-16。用户明确要求“我要做成 saas 的”，并选择“邮箱＋密码”“先完成多家庭内测”。本记录拥有账号、家庭租户、数据库、邀请、恢复和 SaaS 启动边界。实现与下述本机验收已完成；公网部署、真实邮件投递和物理iPad不属于已验证现状。

后续用户要求逐项审查并补齐所有SaaS功能。[v0.14功能闭环与运行边界](saas-completion.md)拥有新增生命周期、恢复取舍及完整功能验收；本记录保留v0.13基础隔离与持久化决定，下方v13结果是当时交付证据，不能把此前21个浏览器场景等同于所有功能已经覆盖。

## 问题

现有服务把整份家庭状态、核验令牌和限速计数放在一个进程中，匿名接口能读取同一份家庭存档。浏览器在联网前会显示旧的全局缓存。它能用于一户自用，但无法安全承载多个独立家庭。仅增加登录页面不能解决存储、权限、重放、异常响应和缓存泄漏。

## 依据与范围

- 新授权：多个家庭使用同一套 SaaS 服务；邮箱密码登录；首期内测，不接支付。
- 保留原[业务需求](家庭看板需求文档.md)：每个家庭一个孩子、一套账本。账号和家庭成员不成为独立计分孩子。
- 保留[核心业务](core-redesign.md)的积分、礼品、提醒和逐笔家长核验，以及[农场](farm-design-proposal.md)的规则、视觉与目标设备。
- 替换“所有访问者共用一个家庭”的访问和持久化边界。日常“公开操作”在 SaaS 中指已登录且有家庭成员资格的人可做；不再指互联网匿名用户。
- 家长 PIN/算术仍用于每笔敏感业务确认，不替代账号登录。身份、家庭归属和成员管理由服务端验证。
- 新家庭零积分、无历史活动、无样例孩子、无虚构兑换；农场仍由用户首次开启。
- 不改真实家庭 JSON、不自动把旧家庭分配给新注册者、不上传旧数据。旧版本和存档保留，导入必须明确指定有权接收的目标家庭。
- 用户未授权付费订阅、支付、真实邮件服务收费或外部部署。本版可连接配置好的 SMTP；本机验收使用明确标注的开发邮件渠道，不声称邮件已投递外网。

## 已实现的决定与拓扑

采用现有 Node/ES5 前端和纯业务模型；增加 PostgreSQL 持久层、账号与租户 HTTP 服务、独立登录/家庭引导层。农场 renderer 不重写。

```
浏览器登录/家庭引导
  → HttpOnly 会话 + CSRF + 服务端家庭成员校验
  → familyId 限定的业务命令/查询
  → PostgreSQL 事务
  → 现有 FamilyModel 的业务规则
```

- PostgreSQL 为 SaaS 权威存储，不以 JSON 文件/浏览器缓存作为数据库故障时的替代写入。
- 一个家庭业务聚合暂保存为 JSONB，保留模型与历史快照语义；账户、成员、会话、邀请、验证令牌、核验凭据及动作回执用关系表管理。
- 每笔业务事务锁定对应家庭行，校验会话/成员/版本/逐笔授权，执行纯模型，提交状态、版本、私有核验配置和动作回执，并消耗授权。其他家庭不共用全局业务锁或内存状态。
- 同一家庭内同 ID 同内容可重放，同 ID 不同内容拒绝；不同家庭同 ID 互不影响。PIN 相关回执保留慢哈希，不能用快速明文摘要削弱密码保护。
- 登录密码采用加盐 scrypt；随机会话与邮件/邀请令牌在数据库中保存哈希。会话可撤销，有固定过期时间。生产 Cookie 为 Secure/HttpOnly/SameSite；本机 HTTP 仅开发模式可用。
- 所有写接口校验来源；已登录写入另外需要与会话绑定的 CSRF 令牌。不可用客户端提交的 userId/role 决定身份或权限。
- 既有逐笔 challenge/grant 绑定家庭、用户、会话、完整动作及版本，持久化到数据库，支持不同服务实例完成同一流程。
- 安全限速以数据库中的作用域键计数；家庭核验失败不锁死其他家庭；登录/恢复限速不能随更换实例被绕过。默认不信任转发 IP 头。
- 当前家庭日继续使用 Asia/Shanghai，作物成熟仍按真实经过的 UTC 时长。首版不新增任意家庭时区或改变既有日期口径。

## 用户流程与权限

1. 邮箱注册 → 验证邮件 → 登录 → 创建家庭（家庭名、孩子称呼）或接受邀请 → 原积分/提醒/农场首页。
2. 注册后不自动初始化示例记录；一笔事务创建家庭、所有者成员和空业务状态。重复提交不重复创建。
3. 邮箱未验证不能建立/加入家庭或读取家庭数据。忘记密码通过短期一次性邮件令牌，成功后撤销既有会话；修改密码核验旧密码并撤销其他会话。
4. 家庭成员角色首期为 owner、parent。两者均参与原业务及逐笔家长核验；只有 owner 创建/撤销邀请、移除其他 parent、首次设置家长核验。不能移除唯一 owner。
5. 邀请限定目标邮箱、parent 角色和有效期。接受者需登录并验证相同邮箱，原子消费一次；过期、撤销、重放和邮箱不符均拒绝。邀请不会替换家庭孩子或账本。
6. 账号可有多个已授权家庭，客户端明确选择当前家庭；每次读取和提交仍检查当前成员关系。被移除后不能继续访问该家庭，即使已有 Cookie、挑战、授权或旧页面。
7. 账号/家庭操作入口放在现有设置区；交互保持字段、按钮、短状态，无教学长文，手机触控目标至少 48px。

## 基础接口契约（新增生命周期见v0.14决定）

新服务 `saas-server.cjs` 导出异步 `createSaasServer(options)`，返回 Node HTTP server；测试通过 options 注入数据库、邮件发送器、时钟、可信来源。SaaS 默认启动单独于保留的旧文件服务。前端根据运行时 `window.__TTJF_SAAS__ === true` 进入 SaaS 路径，旧离线入口保持明确本机模式。

账号接口（JSON，成功/错误均 `Cache-Control: no-store`）：

- `GET /api/session` → `{authenticated:false}` 或 `{authenticated:true,user:{id,email,verified},families:[{id,name,role}],csrfToken}`。
- `POST /api/auth/register {email,password}` → `202 {ok:true}`；不自动登录，界面进入查收邮件状态。
- `POST /api/auth/verify-email {token}` → `{ok:true}`。
- `POST /api/auth/resend-verification {email}`、`POST /api/auth/forgot-password {email}` → 统一 `202 {ok:true}`，不公开邮箱是否存在。
- `POST /api/auth/login {email,password}` → 会话 Cookie + 同 `/api/session` 的结果；无效凭据统一错误。
- `POST /api/auth/reset-password {token,password}`、`POST /api/auth/change-password {currentPassword,password}` → `{ok:true}`。
- `POST /api/auth/logout {}` → 撤销当前会话并清 Cookie。
- 邮件链接使用 fragment `/#verify=TOKEN`、`/#reset=TOKEN`、`/#invite=TOKEN`，页面取出后清理 URL，通过明确操作 POST 消费，避免链接预取修改状态。

家庭接口（需已验证会话及 CSRF）：

- `POST /api/families {name,childName,requestId}` → `{family:{id,name,role:'owner'}}`。
- `GET /api/families/:id/members` → `{members:[{userId,email,role}]}`。
- `POST /api/families/:id/invitations {email}` → `{invitation:{id,email,expiresAt}}`，由邮件发送一次性链接，不在普通列表返回 token。
- `GET /api/families/:id/invitations` → `{invitations:[{id,email,expiresAt,status}]}`；owner 可读。
- `DELETE /api/families/:id/invitations/:invitationId` → `{ok:true}`；owner 撤销。
- `POST /api/invitations/accept {token}` → `{family:{id,name,role:'parent'}}`。
- `DELETE /api/families/:id/members/:userId` → `{ok:true}`；owner 移除 parent，不能移除自己。

原 `/api/state`、`/api/meta`、`/api/parent/challenge`、`/api/parent/verify`、`/api/action`、`/api/assistant` 保留原业务 payload 和返回结构。必须带 `X-Family-ID`，POST 另带 `X-CSRF-Token`。所有包含业务状态/私有配置投影的成功、重放、冲突和错误响应增加 `{familyId,userId}`，校验成员资格在任何状态返回之前。健康检查不返回家庭 revision/数量。

确切parent路径保留为原有`/api/parent/challenge`和`/api/parent/verify`，原业务payload与字段保持兼容。新服务默认由`npm start`运行，本机显式配置使用`npm run dev:saas`，旧单户入口改为`npm run start:legacy`。

初始迁移在PostgreSQL事务迁移锁下执行，开发应用角色为非超级用户，开发库与测试库分开。运行、SMTP/HTTPS参数与私有数据操作由[运维说明](saas-operations.md)维护。助手另使用数据库短期租约，跨实例每家庭最多2个进行中的请求，异常退出后租约过期恢复；不以全局并发槽阻断其他家庭。

## 前端隔离

- 登录和家庭成员确认完成前不读取/显示任何家庭状态，不使用 createSeed 作为缺省。
- SaaS 模式不在 localStorage 保存业务数据、草稿、PIN 或核验令牌。明确离线版仍用原独立存储；绝不自动导入到 SaaS。
- 每个请求捕获 userId/familyId 和单调递增的页面作用域版本。切换/退出/失效时中止请求并使旧回调失效；版本号只在同一家庭作用域中比较。
- 所有迟到的成功、409、401、超时、AI/头像转换都不能改变新账号/家庭的页面、草稿、锁、提示或连接状态。
- 退出清空家庭状态、草稿、PIN/grant、重试事务、时钟及提醒，停止语音/声音，释放 renderer。tick/pageshow/恢复页在未 ready 时不重建旧场景。
- 跨页签退出发出无业务信息的变更信号；重新获得焦点/恢复页面时验证会话，不能先露出旧家庭画面。

## 替代方案

- 每家庭单独部署文件服务：能隔离文件，但不能提供统一账户、邀请和运维，未采用为 SaaS 主线。
- SQLite 单进程多租户：真实可用且部署简单，但数据库写并发和多实例边界不符合本次从家庭开发版转 SaaS 的目标；PostgreSQL 优先。
- 直接把整个前后端换成大型框架/ORM：会同时改变已验收业务和旧 iPad 兼容性，本版保持现有业务与渲染器，仅替换必要边界。
- 手机验证码/微信登录：用户明确选择邮箱密码，其他身份提供方不在本版。
- 订阅支付/套餐：用户明确先多家庭内测，不建立虚构付费状态或支付成功页面。

## 验收与直接证据

最终核心回归211通过、真实PostgreSQL回归23通过，均0失败/跳过。最终浏览器21场景、20次布局审计、32截图、0脚本错误，运行期间源码hash稳定；本记录与运维说明是在该运行后完成的文档更新。历史失败的测试导航记录保留，不冒充通过。具体命令、环境、时钟/生命周期模拟边界和图像检查见各证据。

| 可观察承诺 | 直接证据 | 结果与边界 |
| --- | --- | --- |
| 邮箱注册/验证/登录/找回密码/退出真实改变数据库和会话 | [PG账号测试](../test/saas-auth.test.cjs)、[PG结果](../artifacts/v13-saas-tests-final.txt)、[真实浏览器](../artifacts/v13-saas-verification.md) | 通过；本机SMTP协议发送另有后端用例；未验证外网投递 |
| 新家庭无样例历史；欢迎田只一次；重新创建服务实例保留 | [空家庭模型](../test/saas-model.test.cjs)、浏览器family-business/persistence | 通过；真实PG持久化；8小时成熟用注入时钟，不是连续等待 |
| A/B同对象ID/actionID/revision仍隔离 | [PG权限与业务测试](../test/saas-server.test.cjs)、浏览器family-isolation | 通过；端点、重放/冲突/错误返回均先核验成员 |
| 跨用户/会话/家庭逐笔授权不可复用 | PG业务测试与账号撤销测试 | 通过；保留Cookie、challenge/grant也不能绕过撤销 |
| 两服务实例同时写同一家庭不重复入账 | [PG持久层测试](../test/saas-store.test.cjs) | 通过；共用真实PG、独立实例/连接；动作重放、版本竞争、首次配置竞争 |
| 数据库故障/事务回滚不假成功、不本地记账 | PG真实触发器回滚/不可用测试、[客户端隔离测试](../test/saas-client.test.cjs) | 通过；故障后重新执行仍只有一次提交 |
| 邀请仅目标已验证邮箱接受一次；撤销立即阻断 | PG邀请并发/过期/移除；浏览器invitations | 通过；被移除账号不能用旧页面或Cookie继续访问 |
| 切换/退出后无旧DOM、缓存和迟到反馈 | [核心结果](../artifacts/v13-core-tests.txt)、客户端VM、浏览器真实迟到200/401和跨页签 | 通过；409/timeout/头像/AI/wake由VM覆盖；真实BFCache/OS挂起未验证 |
| 原积分、提醒、农场规则不退化 | 核心211回归、SaaS真实加分→收获→兑换→摆放→播种→成熟→收获 | 通过；renderer未改，未用新样例覆盖旧家庭 |
| 五视口可操作，无长篇界面说明 | [页面验收与图像](../artifacts/v13-saas-verification.md) | 通过；可见控件至少48px；桌面Edge不代表物理iPad |
| 私有导入/恢复归属明确且原子，保留旧PIN和回执 | [数据工具测试](../test/saas-data.test.cjs)、PG23结果 | 4用例通过；默认dry-run、空目标、回滚、旧凭据重放、备份恢复；只用合成数据 |
| 实际4180入口加载当前代码并拒绝匿名/私有访问 | [实际预览记录](../artifacts/v13-live-preview.json)、[登录截图](../artifacts/v13-live-login.png) | 7静态文件hash匹配，6处保护检查，0写请求/脚本错误 |

## 已落地的数据与回退边界

新家庭由`createEmptyFamily`初始化，原`createSeed`只供明确旧演示路径。旧JSON不会由SaaS启动读取，也没有自动归属、上传或重置。私有CLI导入只接收完整envelope，要求已验证owner与新建空家庭；原文件不改，业务/核验/回执同事务导入，源摘要与版本留下审计。目标版本至少递增一次，防止先前空页面继续提交。备份文件只放私有目录且不覆盖既有文件；整库生产灾难恢复是运维说明中的待执行流程，不由家庭备份测试代替。

选择现有业务模型加JSONB家庭聚合，是为了保留已验收的积分与农场事务语义。代价是同一家庭的操作串行、JSONB随历史增长；内测不增加计费、复杂分片或多孩子账户。应用角色不使用PostgreSQL超级用户；测试只创建并删除自己的独立schema。

v0.13交付曾在页面隐藏/恢复时清空家庭和未提交输入，该恢复取舍已由[v0.14决定](saas-completion.md)替换：隐藏私密DOM、暂停资源并失效授权，同一会话/用户/家庭重验后恢复普通内存草稿；变更身份或权限则销毁。真机系统图片选择和应用切换仍需额外验收。保留旧文件服务与离线交付作为独立路径，不提供从数据库故障自动退回旧账本的行为。

## 风险与明确边界

实际 SMTP 投递、正式域名/HTTPS、云数据库、外部部署和物理 iPad 性能需要相应环境。开发邮件渠道必须明确本机用途，生产启动不得静默回退到本地文件发信。旧家庭迁移需操作者指定并验证目标归属；v0.13交付未替用户注册账号、设置密码或接管原家庭。随后用户明确授权的指定本机账号初始化由[初始用户决定](saas-initial-user.md)拥有；其余注册验证、家庭隔离和禁止自动接管旧家庭的边界仍保留。备份恢复工具必须可先 dry-run，正式恢复不得悄悄覆盖现有家庭。
