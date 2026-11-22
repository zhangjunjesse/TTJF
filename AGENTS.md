# TTJF 项目约定

## 工作方式

- 默认维护模式。修改保持在当前任务范围；公开接口、持久化和业务行为的变化需有明确任务依据。
- 子 agent 使用 `gpt-6.1-sol` / `max`，`fork_turns="none"` 或必要的正整数；新建独立会话使用 `gpt-6-astra` / `xhigh`。没有用户请求不新建独立会话。
- 长任务遵循用户全局规范。进度与结果写入文件；不得起依赖当前会话存活的裸后台任务。可按文件或场景拆分短验证，分别保存输出，不将未跑项目记为通过。

## 已核实项目事实

- `npm start` 启动 `saas-server.cjs`；浏览器主要入口为 `index.html`、`app.js`、`saas-client.js`，业务计算在 `model.js`。
- `saas/` 管理账号、家庭、生命周期、业务授权、邮件、网络与临时记录清理。当前持久化由 `saas/store.cjs`、`saas/sqlite.cjs` 和 `saas/migrations/` 提供。
- 初始账号由 `saas/initial-account.cjs` 按私有环境配置幂等创建；已有账号的密码、验证状态和家庭数据保持不变。私有 `data/initialize-private.ps1` 可恢复缺失的运行配置，真实凭据不提交。普通启动要求配置 SMTP，不自动回退到文件邮件；本机回环 HTTP 与公网生产 HTTPS 使用相同业务流程。
- 目标为一个 Node 服务进程和本机 SQLite。`data/`、环境文件、开发邮件、数据库及备份不得提交或暴露为静态资源。旧 `server.cjs` 单户 JSON 服务独立保留，不与 SaaS 自动合并。
- 一个家庭一个孩子、一套账本。所有者/家长是成员角色；家庭必须恰有一个 owner。权限校验、版本判断、业务状态、一次性授权和回执须原子提交，重试不能重复记账。
- SaaS 不在浏览器持久化业务数据或凭据；上海家庭日期和作物实际生长时长属于不同时间规则。
- 家长助手的会话按账号和家庭存入 SQLite。系统提示词和工具协议在 `config/assistant/`，业务变更走原有表单和家长授权流程。通用模型聊天由 `AI_CHAT_ENABLED` 控制。
- 当前需求与范围以 `docs/sqlite-migration.md`、`docs/saas-completion.md` 和各业务设计决定为准。后者中的 PG 运行方案与历史验收由 SQLite 决定覆盖。
- `farm/` 是 3D 场景源，`farm-scene.js` 是生成产物。存储改动不重建无关视觉资源。旧 `export/` 与历史 `artifacts/` 不代表当前 SaaS 交付。
- `world-ui.js` 按业务表单/账号视图切换 Three.js 功能地点，`farm/world-stations.js` 定义地点实物，`farm-world.css` 统一全站呈现。功能场景不写业务数据；账号只使用匿名投影。农场与功能地点同时最多保留一个 WebGL 实例，家庭边界清理时释放视图状态。

## 验证入口

- `npm test`：领域、旧服务、客户端、家庭日期回归，包含真实 Edge/Chrome 的客户端用例。
- `npm run test:saas`：真实临时 SQLite 文件、账号/家庭/业务/生命周期/清理及备份恢复。
- `test/saas-package.test.cjs` 已纳入 `test:saas`：验证 Docker 显式 COPY 和默认拒绝清单包含 HTML 资源，并通过真实 SaaS HTTP 检查临时打包静态根；不等于实际镜像构建。
- `npm run test:browser`、`npm run test:browser:full`：真实 SaaS 浏览器消费链；需要 Edge/Chrome，可通过 `BROWSER_PATH` 指定。
- `npm run build:farm`、`npm run test:farm-renderer`：场景源码实质变化时使用；不要把旧 renderer 的检查结果冒充当前 SaaS 验证。
- `npm run test:world`：场景宿主路由、匿名投影、生命周期与降级回归；已纳入 `npm test`。`npm run test:world:browser` 默认运行 points 组，通过 `WORLD_TEST_CASE` 选择各独立短组，范围见 `docs/threejs-farm-world.md`。组件 renderer 支持 `TEST_CASE_PATTERN` 分组及 `TEST_ARTIFACT_DIR`，未选择项明确报告，不覆盖历史图像。
- `npm run test:world:contrast`：真实控件渐变、交互状态和禁用状态；`npm run test:farm-context:browser`：真实 WebGL 丢失/恢复，`FARM_CONTEXT_CASE` 分别选 `switching`（默认）、`loading-first`、`restoring-first`、`dispose`。各组独立执行并落盘。
- `npm run test:ui:flows`：真实临时 SQLite 的加分确认、常用模板、兑换记录、指令和重试；`UI_REFINEMENT_CASE` 分别选 `award`（默认）、`template`、`history`、`voice`、`retry`、`balance`（空原因加分、保存常用、刷新与历史总积分/可兑换积分）。`npm run test:ui:layout` 用 `UI_LAYOUT_WIDTH`、`UI_LAYOUT_HEIGHT` 指定视口，检查首页占屏、触控命中、卡片、输入和弹框，`UI_LAYOUT_CASE=long` 运行长积分布局。`npm run test:ui:credit` 检查共用渲染器的积分宝箱、降级及资源释放。各入口使用 `TEST_ARTIFACT_DIR` 保存独立证据。
- `npm run test:ui:keyboard` 在真实 SaaS 表单上模拟手机键盘压缩、移动可见区域。用 `MOBILE_KEYBOARD_CASE=award|template|reminder|pin|pin-landscape` 分别检查立即加分（默认）、常用行为、提醒和竖屏/横屏家长 PIN。系统输入法和 Safari 真机需单独验收。
- `npm run test:assistant:flow` 使用真实 SaaS 和临时 SQLite，按 `ASSISTANT_FLOW_CASE=phone|template|tablet|landscape` 验证助手交接、记账、清空和布局。`npm run test:assistant:panel` 按 `ASSISTANT_PANEL_CASE=layout|lifecycle|drafts|voice|history` 独立验证面板交互。两者均支持 `TEST_ARTIFACT_DIR`。
- `npm run test:home:views` 使用隔离的家庭和 SQLite 测试首页。用 `DEVICE_HOME_CASE=phone|phone-landscape|desktop-screen|tablet|preferences|storage|sync` 选择手机、横屏、桌面窄窗口、平板、本机偏好、存储不可用或打开七日小结时收到家庭账本更新的场景。首页在首次打开时按窗口大小选择视图，只有用户显式保存的视图偏好才写入本机。
- `TEST_ARTIFACT_DIR` 可把本轮证据写到独立目录；避免覆盖历史验收。详细范围和本次已知失败基线见 `docs/sqlite-verification.md`。
- `npm run test:pet-home:browser` 通过隔离的 SaaS/SQLite 测试伙伴首页。`PET_HOME_CASE=home|preview|rotation|scope|touch|portraits` 选择场景，`PET_HOME_WIDTH`、`PET_HOME_HEIGHT` 选择手机或平板视口。`portraits` 检查 WebGL 不可用时的十套形态、成长足迹和伙伴设置。实体 iPad/Safari 需单独验收。
- `farm/forest-bud/` 提供晶叶龙的模型、动作和成长装扮。改动形象后运行 `npm run build:farm` 和 `node tools/render-dragon-portraits.cjs`，同步实时模型与 `assets/farm/portraits/` 的静态图。
- 截至接手检查，远端未配置 GitHub Actions。具体 PR 的检查状态需另外核实，不能把本地通过称作 CI 通过。

## 边界与遗留热点

- `app.js`、`model.js` 和历史浏览器测试较大；只整理与当前行为有关的职责，不借本次任务做全仓重构。
- `sqlite.cjs` 只负责本项目 SQLite 连接、值转换、事务和文件生命周期，不添加 PG 语法模拟或通用多数据库框架。
- 原生 iPad/Safari、外部 SMTP/HTTPS、生产恢复和长期负载需对应环境验收；桌面自动化不替代这些检查。
