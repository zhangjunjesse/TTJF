# TTJF 项目约定

## 工作方式

- 默认维护模式。修改保持在当前任务范围；公开接口、持久化和业务行为的变化需有明确任务依据。
- 子 agent 使用 `gpt-6.1-sol` / `max`，`fork_turns="none"` 或必要的正整数；新建独立会话使用 `gpt-6-astra` / `xhigh`。没有用户请求不新建独立会话。
- 长任务遵循用户全局规范。进度与结果写入文件；不得起依赖当前会话存活的裸后台任务。可按文件或场景拆分短验证，分别保存输出，不将未跑项目记为通过。

## 已核实项目事实

- `npm start` 启动 `saas-server.cjs`；浏览器主要入口为 `index.html`、`app.js`、`saas-client.js`，业务计算在 `model.js`。
- `saas/` 管理账号、家庭、生命周期、业务授权、邮件、网络与临时记录清理。当前持久化由 `saas/store.cjs`、`saas/sqlite.cjs` 和 `saas/migrations/` 提供。
- 目标为一个 Node 服务进程和本机 SQLite。`data/`、环境文件、开发邮件、数据库及备份不得提交或暴露为静态资源。旧 `server.cjs` 单户 JSON 服务独立保留，不与 SaaS 自动合并。
- 一个家庭一个孩子、一套账本。所有者/家长是成员角色；家庭必须恰有一个 owner。权限校验、版本判断、业务状态、一次性授权和回执须原子提交，重试不能重复记账。
- SaaS 不在浏览器持久化业务数据或凭据；上海家庭日期和作物实际生长时长属于不同时间规则。
- 当前需求与范围以 `docs/sqlite-migration.md`、`docs/saas-completion.md` 和各业务设计决定为准。后者中的 PG 运行方案与历史验收由 SQLite 决定覆盖。
- `farm/` 是 3D 场景源，`farm-scene.js` 是生成产物。存储改动不重建无关视觉资源。旧 `export/` 与历史 `artifacts/` 不代表当前 SaaS 交付。

## 验证入口

- `npm test`：领域、旧服务、客户端、家庭日期回归，包含真实 Edge/Chrome 的客户端用例。
- `npm run test:saas`：真实临时 SQLite 文件、账号/家庭/业务/生命周期/清理及备份恢复。
- `npm run test:browser`、`npm run test:browser:full`：真实 SaaS 浏览器消费链；需要 Edge/Chrome，可通过 `BROWSER_PATH` 指定。
- `npm run build:farm`、`npm run test:farm-renderer`：场景源码实质变化时使用；不要把旧 renderer 的检查结果冒充当前 SaaS 验证。
- `TEST_ARTIFACT_DIR` 可把本轮证据写到独立目录；避免覆盖历史验收。详细范围和本次已知失败基线见 `docs/sqlite-verification.md`。
- 截至接手检查，远端未配置 GitHub Actions。具体 PR 的检查状态需另外核实，不能把本地通过称作 CI 通过。

## 边界与遗留热点

- `app.js`、`model.js` 和历史浏览器测试较大；只整理与当前行为有关的职责，不借本次任务做全仓重构。
- `sqlite.cjs` 只负责本项目 SQLite 连接、值转换、事务和文件生命周期，不添加 PG 语法模拟或通用多数据库框架。
- 原生 iPad/Safari、外部 SMTP/HTTPS、生产恢复和长期负载需对应环境验收；桌面自动化不替代这些检查。
