# PR #3 审查修复验证

日期：2026-11-17。复现基线为 PR 提交 `4fc72142e693077840666764e53659fb01a40a5a`；再次 fetch 后 `origin/main` 为 `26757f04539ea06c95bcdc73e3b6b8b31ae11abc`，PR 分支仍为该复现基线。本轮仅修复审查指出的四类问题及相关路径，没有合并或部署。

## 修复及复现

| 审查问题 | 修复前的实际失败 | 修复与结果 |
| --- | --- | --- |
| Docker 运行包漏资源 | 根据 COPY 构造的静态根通过真实 SaaS HTTP 请求，`farm-world.css` 与 `world-ui.js` 均 404；默认拒绝清单也缺少两个例外 | 两个文件同时进入 COPY 与精确 `.dockerignore` 例外。新增回归从 HTML 收集顶层依赖，逐项验证临时运行根的 HTTP 内容和 context 清单；2/2 通过，已加入 `test:saas`。默认拒绝及私密文件排除保留。 |
| WebGL 恢复显示旧地点 | 使用真实 `WEBGL_lose_context`，恢复后 `presentation=rewards` 而 `station.id=points` | 模型完成和 context 恢复共用准备路径：根据最新选项重建场景、应用灯光和视口、绘制，然后通知 ready。四组 6/6 通过，含两种加载/恢复先后、连续恢复和销毁中恢复。 |
| 主按钮文字对比度下降 | 完整红灯回归中 7 类真实按钮的 28 个启用交互状态均低于 4.5:1；农场收获数量徽标也存在低对比度 | 加深共享绿色、展开农场及危险确认渐变；收获徽标使用深色半透明底，禁用样式保持原规则。28/28 状态通过，最差保守下界 4.9191:1；危险确认最差 5.6708:1。 |
| Windows 跨盘截图失败 | D: 工作树配 C: `TEST_ARTIFACT_DIR`，原代码生成含 `D:\...\C:\...` 的路径，真实截图报 ENOENT | 截图和哈希直接使用绝对输出路径；报告同盘仍记录相对路径，跨盘记录绝对路径。跨盘镜头检查 3/3 通过，3 张实际 PNG 的 SHA-256 与报告一致；同盘截图检查也通过。 |

对比度检查使用真实 Edge 加载的 CSS、实际产品控件及稳定态 computed style，覆盖 default、hover、键盘焦点、active，以及后代数量文字的背景叠加。计算整个不透明 RGB 渐变的最浅通道边界，计入 brightness 和像素量化，得到保守下界；不是使用透明 `backgroundColor` 替代渐变，也不把它宣称为逐像素采样结果。遇到不支持的透明度、混合、伪元素或图层直接失败。禁用兑换实际点击没有发起提交。

WebGL 回归保留严格 ready 断言：每次 ready 回调时当前地点已一致且已有 draw calls。恢复后的地点、伙伴、成长、夜景和视口，以及仅灯光/视口变化的两组 PNG，均与 context 正常时应用相同选项的参考图 SHA-256 一致。始终保持同一个 renderer/canvas，没有未捕获页面异常。

## 本轮实际验证

- `npm run build:farm`：通过，Three.js 0.160.1、22 个模型、Safari15 / ES2018，生成 bundle 2,753,040 字节。
- `node --test test/farm-ui.test.cjs test/world-ui.test.cjs test/saas-client.test.cjs test/saas-server.test.cjs test/saas-package.test.cjs`：55/55 通过（包含上述打包 2 项）。
- `npm run test:farm-context:browser`：按 `FARM_CONTEXT_CASE=switching`、`loading-first`、`restoring-first`、`dispose` 四个独立进程执行，合计 6/6 通过。默认只执行 switching。
- `npm run test:world:contrast`：7 类真实主按钮 × 4 个状态，28/28 通过；另验证禁用兑换和没有业务写入。
- `farm/verify-v12.cjs`：跨盘镜头/命中 3 项，同盘截图 1 项（重复地块检查），资源稳定/暂停恢复 2 项均通过。通过 `TEST_CASE_PATTERN` 选择，未运行的项保留 skipped。
- `test/world-browser.cjs`：分别选择 `points` 3 项、`lifecycle` 3 项、`layout-390` 1 项，7/7 通过；包含真实保护表单进入/取消授权、输入焦点与选区、夜景和镜头切换保留。
- 使用临时 SQLite SaaS 服务重新截图匿名手机登录；同时刷新桌面工坊和手机设置预览。没有真实账号或家庭记录。
- 语法与 `git diff --check` 通过。独立只读复核覆盖打包清单、路径、恢复顺序、资源所有权和四组恢复测试，未发现剩余具体问题。

## 复跑与证据

每组独立前台运行，日志和结果落盘。打包/路径/样式/集成证据在修复工作树的 `data/pr3-review-fixes/`；context 证据在 `data/context-fix/`。原失败结果保留，不将失败 probe 或跳过项目计为通过。原始报告和测试运行目录不提交。

跨盘场景在 Windows 上从 D: 工作树执行，并把 `TEST_ARTIFACT_DIR` 设为 C: 的可写证据目录。示例（目录必须已获写入授权）：

```powershell
$env:TEST_ARTIFACT_DIR = 'C:/your-writable-evidence/pr3-cross-drive'
$env:TEST_CASE_PATTERN = 'Real mouse dragging|Wheel and visible|An actual plot'
$env:V12_EVIDENCE_TAG = 'pr3-review'
node farm/verify-v12.cjs
```

没有运行完整 npm/浏览器套件，没有实际构建 Docker 镜像；模拟 COPY 静态根的 HTTP 结果不等于容器运行验收。桌面 Edge 不替代原生 iPad/Safari、实体 GPU、外部 SMTP/HTTPS 或真实系统后台/BFCache。本地结果不等于 GitHub CI 通过。
