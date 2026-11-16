# v0.4 独立 UI 验收记录

验收日期：2026-11-15。测试由 ux-verifier 执行，使用本机 Microsoft Edge / Chromium、实际渲染的 DOM、命中检测后的鼠标坐标点击、真实文件选择器，以及隔离数据文件的真实 HTTP 服务。所有操作均使用测试数据与测试 PIN，没有读取或修改实际家庭数据。

## 当前结果

- 新版浏览器验收 **36 项通过，当前 0 失败、0 页面脚本错误、0 跳过**。详见 [浏览器机器结果](v4-browser-results.json)。
- 客户端回归 **C1–C8 全部通过**，详见 [客户端机器结果](v4-client-results.json)。
- 最终 [离线 HTML](../export/little-steps-demo.html) 已重新验证：**381883 bytes**，SHA256 `60eb3f4a65f3ce3cf23b0a878f81ea9226d61c30845febdba933ae55a554a69b`。
- [v0.3 验收记录](v3-verification.md)、[v0.3 浏览器结果](v3-browser-results.json)和[v0.3 客户端结果](v3-client-results.json)保留，没有被本轮报告覆盖。

团队分工累计 **146 个检查项**，按实际检查项计数，不把矩阵中的每个参数组合重复加总：

| 分工 | 项数 | 结果与来源 |
| --- | ---: | --- |
| model / server | 74 | data-engine 执行，37 model + 37 server，全通过 |
| assistant / adapter | 20 | Lead 执行，情境约束、管理语句及模型适配检查全通过 |
| pet renderer | 8 | pet-artist 执行，全通过；140 种阶段/反应/减弱动效组合属于渲染覆盖矩阵，不额外计入总数 |
| client | 8 | 本验收执行，C1–C8 当前全部通过 |
| browser | 36 | 本验收执行，真实点击、图片、界面和离线验收当前全部通过 |
| 合计 | **146** | 各负责人结果汇总；不声称 146 项均由同一次 QA 命令执行 |

本轮按变更路径定向复测并累计覆盖，不是每次微调后重新运行所有组。各轮请求分组、源文件 SHA256、导出文件 SHA256、通过数与历史失败均保存在[浏览器结果的 runs 记录](v4-browser-results.json)。CSS 收口后重跑 layout、companions、gallery；模板状态修复后重跑 template-ai；最终重新打包后重跑 offline / offline-hosted 三项。

## 浏览器检查的 36 项分解

| 组 | 项数 | 已验证行为 |
| --- | ---: | --- |
| layout | 10 | 五种视口分别验证主页面与表单。两个固定导航、无横向溢出、加分与头像/伙伴/AI表单可用，次级兑换入口及返回链可用 |
| points-ai | 1 | AI 填入同一个可编辑加分表单；生成前后不落账；人工改原因可保留；错误 PIN 不保存，正确 PIN 保存；下一笔重新验证 |
| template-ai | 3 | 新增常用项、改分值/原因/名称/停用/启用均只改模板且逐次验证；保存后清描述并显示已保存；取消保留描述，按钮可用，下一次整理能正确生成新草稿 |
| ai-races | 3 | 等待 AI 时手改不会被迟到回复覆盖；关闭后打开另一个资料场景不被旧回复污染；请求失败后仍可人工填写并验证保存 |
| companions | 2 | 植物、水豚各三种不同反应与点击摸摸；互动不发变更请求、不加减积分；公共换伙伴/改名刷新后保留成长；减弱动效保留静态反应且没有持续动画 |
| gallery | 10 | 两种伙伴各五阶段，通过受控初始账本在实际首页逐一渲染、检查阶段属性/名称并截图 |
| growth-redemption | 1 | 从 29 XP 实际逐笔验证加分至 30/100/250/500/750，检查全部阶段与首颗成长星；从次级兑换页申请并验证审批，扣分不减少 XP 或等级 |
| profile | 3 | 真实选择 PNG、居中裁剪为 192×192 JPEG、取消不保存、错误/正确 PIN、刷新持久化；非法格式与体积/像素限制；实际模型适配 HTTP 请求中没有照片；头像删除也须验证 |
| offline / offline-hosted | 3 | 最终精确内联校验；file 模式下头像、初次本机 PIN 设置、情境 AI、伙伴/积分持久化且无 HTTP；同一 HTML 经 HTTP 托管仍为本机模式且无 API 请求 |

模板新增、所有模板管理操作、取消草稿，以及伙伴互动/换伙伴都没有增加累计积分。成长仅由累计获得积分驱动；500 XP 时仍是第 5 阶段、0 星，750 XP 为第 6 级、1 星。

## 五视口与实际画面

下列积分与提醒图已逐张打开检查。小屏内容可以纵向滚动；没有把滚动区下方内容描述为“全部首屏可见”。

| 视口 | 积分 | 提醒 |
| --- | --- | --- |
| 1440×1000 | [桌面积分](v4-desktop-points.png) | [桌面提醒](v4-desktop-reminders.png) |
| 1024×768 | [iPad 横屏积分](v4-ipad-landscape-points.png) | [iPad 横屏提醒](v4-ipad-landscape-reminders.png) |
| 768×1024 | [iPad 竖屏积分](v4-ipad-portrait-points.png) | [iPad 竖屏提醒](v4-ipad-portrait-reminders.png) |
| 390×844 | [手机积分](v4-phone-points.png) | [手机提醒](v4-phone-reminders.png) |
| 320×568 | [小手机积分](v4-small-phone-points.png) | [小手机提醒](v4-small-phone-reminders.png) |

1024×768、提醒条正在显示、主滚动区处于顶部时，额外检查元素真实边界和中心命中：

- 底部导航顶边：**692 px**。
- 四个常用行为的末行底边：**671.078 px**，均在导航上方。
- 三个伙伴互动底边：**549 px**，均可点击。
- 成长剩余提示底边：**634.5 px**，首屏可见。

手机布局的常用行为在伙伴之前。390 宽度的伙伴场景为 **318×190 px**；320 宽度为 **266×180 px**，均大于所在卡片宽度的 80%。已打开检查[植物手机图](v4-companion-plant-phone.png)、[水豚手机图](v4-companion-capybara-phone.png)、[减弱动效静态反应](v4-companion-reduced-motion.png)，角色与反应道具清楚。

十阶段完整截图由 gallery 生成，pet-artist 已逐张复看并确认不需再改 SVG。本验收另打开检查了[植物第 3 阶段](v4-companion-plant-stage3.png)与[水豚第 5 阶段](v4-companion-capybara-stage5.png)。这十个起始账本是测试夹具，不能描述为用户通过真实使用获得的积分。

## AI、头像与离线证据

- [加分 AI 草稿](v4-context-points-draft.png)与[迟到结果保留手改](v4-context-late-manual-edit.png)：确认前没有账本变化。
- [模板保存后的状态](v4-context-template-management.png)与[取消后保留描述](v4-context-template-cancel.png)：实际按钮可用、aiBusy 为 false，没有“正在整理”的残留提示；随后再发一次修改请求得到新的 6 分草稿。
- [头像本机预览](v4-avatar-local-preview.png)：通过真实文件选择器加载合成的 600×400 PNG。图像左右为红/绿条，中间为蓝色；192×192 JPEG 两个角的像素均验证为蓝色，证明取了居中方形，而不是简单拉伸。原 PNG 含测试用 tEXt 元数据标记，编码后的头像不含此标记。
- [头像错误提示](v4-avatar-rejected-input.png)：SVG、超过 8 MiB 的有效 PNG、4001×4001 的有效 PNG 均被拒绝，既有头像保持不变。图片保存前不写动作；错误 PIN 不保存；保存/刷新后的昵称与头像一致；删除仍需家长验证。
- 模型隐私测试使用真实浏览器 → 真实服务器 → 实际 assistant adapter → **本机 loopback 模拟模型服务**。检查上游收到的实际请求，不含 `childAvatar`、`data:image/`、原图/元数据标记或测试 PIN。此项证明适配路径的数据隔离，不证明真实外部模型的理解能力。
- [离线头像持久化](v4-offline-growth-avatar.png)与[HTTP 托管离线伙伴](v4-offline-http-companion.png)：同一最终 HTML 分别在 file 与 HTTP 模式运行。file 模式监测到 0 HTTP 请求；HTTP 模式只加载页面本身（浏览器 favicon 请求单独忽略），没有 `/api/` 请求。
- 最终离线文件精确包含当前 [model.js](../model.js)、[assistant.js](../assistant.js)、[pet.js](../pet.js)、[app.js](../app.js)四份脚本，以及[主样式](../styles.css)、[伙伴样式](../pet.css)，并含显式本机模式标识。脚本和样式按规范化换行比较完整内容，没有残留外链 script / stylesheet。

## 已处理发现与历史记录

1. **真实界面问题：模板管理状态文案残留。** 生成子表单并保存返回列表后，实际 `aiBusy=false`、按钮 `disabled=false`，但父列表还显示“正在整理；你也可以继续手动填写。”。已用真实 UI 定向复现并保存失败轮，见[修复前截图](v4-template-ai-failure.png)。修复后先把父页标记为草稿已整理；只有实际保存成功才清空描述并显示列表已更新；取消保留描述。新增回归覆盖保存、取消、再次整理，三项通过。没有把这个问题夸大成后台请求未结束。
2. **实际视觉收口：** 首稿手机伙伴在半宽列内偏小，横屏 iPad 的末行行为与成长提示需要滚动。按 Lead 复核意见改成手机常用行为在前、全宽伙伴图，以及 1024×768 紧凑布局；最后使用上述真实边界与命中断言验收。保留[首稿手机图](v4-firstpass-phone-points.png)与[首稿 iPad 图](v4-firstpass-ipad-landscape-points.png)便于比较。
3. **测试适配：** C5 的同名审批按钮同时出现在首页与兑换弹层，旧选择器误取背景按钮；改为限定 `.sheet`，只复跑 C5 后通过。该过程保存在[客户端结果](v4-client-results.json)。
4. **测试适配：** `.companion-card svg` 首个匹配是标题图标，不是角色；改成 `svg.pet-scene` 后减弱动效断言通过。角色实际属性一直正确。
5. **测试时序：** Chromium 的 `setViewport` 返回时，应用的 `visualViewport` resize 事件可能尚未执行，曾读到旧桌面导航坐标。改成等待导航实际落到新视口底边后再点；五视口重新通过。没有为此改产品代码。

历史失败保留在机器报告 runs 中；当前 failed / errors 数组为空。没有删掉失败记录来制造一次性全绿。

## 证据边界

- 浏览器是实际 Edge，但尺寸模拟不等于 iPad mini 4 / iPadOS 15.8.7 / Safari 真机验证。没有触控虚拟键盘、真实语音输入、唤醒词、实际听音、后台通知或八小时设备常驻的实测证据。
- 情境指令理解使用明确的本地指令演示；隐私检查使用明确的本机模拟模型服务。未用真实外部模型密钥，不声称外部模型联调通过。
- 服务器与账本是真实实现，数据文件、PIN、头像及阶段账本均为隔离测试夹具。固定/加速时钟不是实际等待十分钟或八小时。
- C1–C8 使用真实浏览器但受控 XHR/授权响应/轮询时点，证明客户端竞态处理；其本身不作为服务器授权安全性的证据。后者由 data-engine 的真实 HTTP 检查与 browser 业务组中的真实服务操作补充。
- v0.3 未改变的完整提醒生命周期验收证据继续保留，本轮没有宣称重新执行旧版全部 35 项。新版提醒界面已在五视口检查，原有断线、同步、重试、价格变化八项客户端回归已重新执行。

## 重现方式

在项目根目录、新 PowerShell 终端中执行全量检查：

```powershell
node --test test/model.test.cjs test/server.test.cjs test/assistant.test.cjs test/pet.test.cjs test/client.test.cjs
$env:V4_OFFLINE = '1'
node test/v4-browser.cjs
```

定向复测并保留累计结果，例如：

```powershell
$env:V4_GROUPS = 'template-ai'
node test/v4-browser.cjs
$env:V4_GROUPS = 'offline,offline-hosted'
node test/v4-browser.cjs
node --test --test-name-pattern="C5 " test/client.test.cjs
```

主要测试代码为[v4 浏览器验收](../test/v4-browser.cjs)、[客户端回归](../test/client.test.cjs)及[复用的浏览器基础函数](../test/browser.cjs)。需要本机 Edge 与可加载的 puppeteer-core；独立 HTTP 服务、临时状态和浏览器上下文由各组创建并清理。
