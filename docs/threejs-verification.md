# Three.js 全站农场改造验证

以下保留首次提交 `4fc7214` 的验证记录。审查后的四项修复、真实失败复现和最新定向验证见 [PR #3 审查修复验证](threejs-pr3-fixes.md)。

执行日期：2026-11-17。分支 `codex/threejs-farm-world` 已 rebase 到当日再次 fetch 确认的 `origin/main`：`26757f04539ea06c95bcdc73e3b6b8b31ae11abc`。原工作目录中的账号与邮件配置修改未被带入此分支。

## 环境和证据

- Windows、Node 22.17.0、真实无头 Microsoft Edge，沿用仓库 Puppeteer 基础设施。
- 按短组在前台执行，进度、输出、源码哈希和截图落盘至本工作树私有 `data/threejs-refactor/`；未提交数据库、账号凭据或原始浏览器报告。
- SaaS 浏览器使用临时 SQLite、回环 HTTP、合成用户和注入邮件接收器。全站地点浏览器使用独立合成 HTTP 家庭夹具；农场组件使用既有独立 fixture。三类结果分别报告。
- 以下为分批实际执行结果，不代表一次运行了全部 npm 聚合命令。较早有效结果保留；同步 main、修复导航状态后，另运行相关回归。

## Node 与构建

| 实际范围 | 结果 | 本地日志 |
| --- | --- | --- |
| `model`、`farm-model` | 76 通过 | `domain-test.log` |
| `saas-model`、`saas-calendar`、`farm-ui`、`pet`、`assistant` 初始回归 | 50 通过 | `domain-client-unit.log` |
| `saas-client`、`server`、`farm-server` | 93 通过 | `client-server-tests.log` |
| `sqlite-store`、`saas-store`、`saas-db` | 26 通过 | `sqlite-tests.log` |
| `saas-server`、`saas-auth`、`saas-startup` 初始回归 | 17 通过 | `saas-entry-tests.log` |
| `saas-data`、`saas-lifecycle`、`saas-maintenance`、`saas-action-audit` | 23 通过 | `saas-business-tests.log` |
| `v15-client` 真实浏览器 C1–C8，三批 | 4 + 2 + 2 通过 | `client-c1-4.log`、`client-c5-6.log`、`client-c7-8.log` |
| 同步最新 main 后的 `saas-initial-account`、`saas-startup`、`saas-db`、`saas-server` | 29 通过 | `main-refresh-tests.log` |
| `world-ui` 宿主映射、匿名投影、释放、异步回调、降级和生命周期 | 5 通过 | `world-unit-final.log` |
| 导航修复后的完整 `farm-ui` 与 `world-ui`（含夜景/镜头、首次加载中途离开、重复加载、上下文丢失和家庭清理） | 22 通过 | `navigation-unit-final.log` |

每个 Node 文件使用 `node --test test/<名称>.test.cjs`；C1–C8 按 `--test-name-pattern` 分批。上表含复跑，不累加为独立用例总数。

`npm run build:farm` 成功：Three.js 0.160.1、22 个内嵌模型、bundle 2,753,014 字节、gzip 1,160,390 字节，Safari15 / ES2018 构建目标。无新增运行时 CDN 或远端模型依赖。

## 全站场景浏览器

`WORLD_TEST_CASE=<组名> node test/world-browser.cjs`；11 组共 17 个检查通过，每轮报告均记录源码开始/结束哈希。分组结果为：`points` 3、`rewards` 2、`reminders` 2、`companion` 1、`settings` 1、`voice` 1、`lifecycle` 3、`fallback` 1、`layout-320` 1、`layout-390` 1、`layout-1440` 1。

覆盖真实入口点击、对应地点和实际 draw calls、最多一个 renderer、没有遗留私密农场 canvas、导航不写业务数据、表单滚动与焦点/输入选区、减少动画偏好、后台/页面恢复以及完全禁用 WebGL 后的 PIN 流程。手机视口为桌面 Edge 模拟。

## SaaS SQLite 浏览器

| 独立选定场景 | 结果 | 证据目录 |
| --- | --- | --- |
| 注册和邮箱验证、空家庭、错误 PIN 与新 PIN 后积分入账 | 3 项及前置/收尾通过 | `evidence/saas-auth/` |
| 农场开启、兑换、摆放、种植、模拟 8 小时后的收获与账本约束 | 1 项及前置/收尾通过 | `evidence/saas-farm/` |
| 退出即清理旧家庭/renderer/草稿，并隔离延迟 HTTP 回应 | 1 项及前置/收尾通过 | `evidence/saas-logout/` |
| 提醒创建、编辑、复制、改到明天、删除与授权保存 | 1 项及前置/收尾通过 | `evidence/saas-reminders/` |

使用既有 `test/saas-browser.cjs` 和 `test/saas-full-browser.cjs` 的 `TEST_CASE_PATTERN` 选择器；提醒组设 `SAAS_FULL_GROUPS=reminders`。这些是实际 SaaS 消费链，未运行的完整浏览器场景不计通过。

## 农场组件与视觉

既有 `farm/verify-v12.cjs` 的 10 个组件检查分为 visual、camera、resource、phone 四组执行，全部通过；导航 API 调整后复跑 camera 3 项。另强制 WebGL1，实际版本为 `WebGL 1.0 (OpenGL ES 2.0 Chromium)`，载入与 390px/320px 触控平移共 3 项通过。

实际检查了首页昼夜、伙伴与成长阶段、鼠标平移、滚轮/按钮缩放、浏览后地块命中、资源数量稳定、暂停恢复、两种手机宽度。自动报告只证明机制，原报告保留 `pending-image-review`；人工另外检查了本轮昼夜、桌面工坊、320px 输入、390px 设置和手机登录截图，确认可操作区域可见、农场材质与配色一致。可公开截图见 [界面预览](threejs-farm-world.md#界面预览)。

## 审查与限制

- 场景与主题交叉审查覆盖默认农场分支、资源所有权、取景、Safari 构建边界、响应布局和生命周期。审查发现普通换景清空昼夜/镜头的问题，已改为 `releaseScene()` 保留会话内视角，家庭边界的 `dispose()` 才清空。
- 审查复现并修复首次加载中途离开会丢失待应用详情焦点的问题。未完成的详情聚焦继续排队，新详情优先于旧视角，只有已就绪场景才捕获用户导航；针对性断言先失败、修后通过。
- 账号表单与业务控件继续使用语义化 HTML；所有页面的三维环境、视觉和布局统一为农场风格。保留键盘输入、读屏、授权校验与 WebGL 降级。
- 未验证原生 iPad/Safari、实体手机 GPU、外部 SMTP 投递、公网 HTTPS、真实 BFCache 或长期负载。本轮未部署、未触碰真实家庭数据。
- 本地通过不等于 GitHub CI 通过；远端检查状态以 PR 为准。
