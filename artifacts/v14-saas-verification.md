# v14 SaaS 真实浏览器验收记录（已完成）

任务 task-16。退出竞态修复后的最终真实HTTP/PostgreSQL验收通过：身份/隔离21组，完整业务27组，均0失败、0跳过、0浏览器异常；两个原始报告均 `sourceStable=true`。69张最终截图已经逐图检查，28次自动布局审计通过。下列历史失败与修复前候选完整保留，不混入最终通过计数。

## 最终结果

| 套件 | 最终原始报告 | 结果 |
| --- | --- | --- |
| `npm run test:browser` | [身份、隔离、布局及退出竞态](v14-browser/20261116164030834-54072/report.json) | 21/21；34截图；20布局；0 pageErrors；sourceStable=true |
| `npm run test:browser:full` | [全部现有业务UI→HTTP→PG](v14-full-browser/20261116163340000-29820/report.json) | 27/27；35截图；8布局；0 pageErrors/failed/skipped；sourceStable=true |

真实服务端会话仍有效、logout POST尚被浏览器扣住时，两页均无私有state/DOM；[退出处理中](v14-browser/20261116164030834-54072/cross-tab-logout-pending-masked.png)仅保留安全锁屏。放行原始请求成功后，[重新登录的资料表单](v14-browser/20261116164030834-54072/cross-tab-relogin-fresh-profile.png)显示持久化原昵称，旧草稿未恢复。测试没有伪造logout响应。

34+35张最终截图全部逐图检查。五尺寸登录/首页/账号/成员，以及积分、提醒、资料、伙伴、八种装饰预览、两级房屋、设备设置、AI、恢复、LA时区、转移/删除确认页均未见阻塞布局问题；320px长账号/成员菜单通过纵向滚动使用，不声称所有控件同时位于屏内。检查对象为报告列出的截图，不计两张输入用合成PNG。审计的控件触点至少48px，输入字号至少16px。

源码证据精确说明：完整业务报告结束后，仅将[基础套件](../test/saas-browser.cjs)里未被full执行的baseline `run()` 场景中两处 `action('profile')` 改为 `action('profile-edit')`，然后重跑得到最终21组。共用helper、fixture、产品源码未改；full未调用或导出该baseline入口。Lead release gate将这两处反向替换后校验SHA等于full原始记录，除此不豁免任何共享测试或运行时漂移。最终测试源码哈希以21组报告为准，full保留真实旧hash，不重写报告。[验收规范](../docs/saas-completion.md)在测试后由Lead作Working→Current及证据链接更新，另记为决策文档收尾，不属于运行时变化。综合结果见[发布核对汇总](v14-summary.json)。

## 已执行候选与诊断

| 运行 | 原始结果 | 说明 |
| --- | --- | --- |
| [第一次完整基线](v14-full-browser/20261116153601868-33580/report.json) | 退出1；11 checks通过、14截图、0 pageErrors；sourceStable=true | 5处刷新后家庭选择假设错误和1处提醒重绘元素句柄失效；已修测试，不改产品绕过。 |
| [前端写入中试跑](v14-full-browser/20261116154304526-13348/report.json) | 退出1；0 checks通过、3截图；sourceStable=false | 中间源码 `discardAvatar is not defined` 已即时报告负责人；不当作最终产品结论。 |
| [提醒/头像/农场/AI/恢复/时区诊断](v14-full-browser/20261116155630110-19912/report.json) | 退出1；12 checks通过、22截图；sourceStable=false | 全farm catalog/作物/house3/动物里程碑、头像、LA上海零点、AI故障恢复通过；恢复断言误把有尺寸的无私有数据占位容器当泄露。 |
| [生命周期与设备能力诊断](v14-full-browser/20261116160631582-36528/report.json) | 退出1；9 checks通过、11截图；sourceStable=false | 四组生命周期与重要事件改明天保留type/note/remindDays通过。两处测试错误：preferences无参数时点undefined动作；隐藏后SaaS占位存在一个安全子节点。 |
| [音效与恢复定向复验](v14-full-browser/20261116161225221-42020/report.json) | 退出0；6/6、4截图；sourceStable=true | 真实音频循环播放后隐藏/退出暂停且归零；设备boolean刷新保留；focus原input、同scope草稿、家长答案清除、原file chooser返回均通过。非全量运行。 |
| [修复前身份/隔离候选](v14-browser/20261116160816320-50308/report.json) | 退出0；21/21、32截图、20布局审计、0 pageErrors；sourceStable=true | 五尺寸全部32截图已逐图检查。之后独立审查发现原用例未覆盖的pending logout竞态，故此报告保留为历史候选。 |
| [修复前完整业务候选](v14-full-browser/20261116161534876-10676/report.json) | 退出0；27/27、35截图、8布局审计、0 pageErrors/failed/skipped；sourceStable=true | 所有业务分组实际通过，但完成在退出竞态修复写入前；不作为修后最终报告。 |
| [新增回归的选择器错误](v14-browser/20261116163339128-43840/report.json) | 退出1；13 checks通过、12截图；sourceStable=true | 新增cross-tab场景把实际profile-edit误写为profile，在发出logout前即失败；仅修两处baseline-only选择器后得到最终21/21。 |

## 独立复核（不计入21+27）

farm-qa的[独立覆盖矩阵](C:/Users/Administrator/AppData/Local/Temp/family-saas-review-8be6d31f7258491fba5f60b226c1cd20/coverage.md)覆盖13个分批场景，区分静态追踪与合成HTTP浏览器探针，并发现了pending logout真实前端缺陷。新freeze后的[三个独立探针](C:/Users/Administrator/AppData/Local/Temp/family-saas-review-8be6d31f7258491fba5f60b226c1cd20/report-37956.json)3/3通过、0 pageErrors、产品源码无运行期变化：普通same-session信号保留普通草稿；退出pending/failed期间focus、hide/show、persisted-pageshow及普通信号不恢复家庭；成功变login，网络失败后实际点击重试同样变login。这份独立证据的会话/业务响应是合成HTTP，未连接PG；本QA最终21组另用真实HTTP/PG和原始logout请求验证成功路径，二者不混计。独立报告仍位于审查者临时目录，主验收证据全部在项目v14目录。

## 真实缺陷与回归合同

独立farm-qa复现：同浏览器context两页，observer打开孩子资料并留昵称草稿；initiator点击退出，拦截真实 `POST /api/auth/logout` 使请求尚未到达服务端。服务器cookie仍有效，第一轮真实跨页信号导致observer重新获取会话并恢复旧家庭/草稿。随后退出成功才清除。已由前端修复，并通过上述最终真实HTTP/PG回归；QA未改产品。

[基础套件](../test/saas-browser.cjs)的现有cross-tab组现已补强：真实拦截请求；只读确认服务器会话仍有效；让应用正常发送跨页信号，再触发focus、persisted-pageshow、hidden/visible；1.5秒观察期间两页家庭state/DOM均不得恢复。放行原始请求成功后重新登录，资料表单必须为已持久化的原名字，不含旧草稿。请求/响应体没有伪造。该组仍计为原有21组中的一组。

## 完整业务覆盖合同

[覆盖矩阵](v14-saas-coverage-plan.md)和[完整套件](../test/saas-full-browser.cjs)逐功能覆盖：

- 积分模板新增/修改/停用/启用、常用及自定义加分、校验、保存为常用、历史与记录；每次受限写入前PG不变，实际challenge→verify→带grant动作后UI/HTTP/PG一致。
- 礼品新增/修改/停用/启用、申请/取消/换选不扣分、逐笔审批、余额不足、周末/月末限制、正好余额归零、历史快照不随改价变化。
- 提醒创建/修改/复制/改明天/取消；完成/恢复/稍后10分钟/知道了不加分；真实前台计时器到点；跨日仍可达；重要事件提前范围及改明天保留event/remindDays/note。
- 合成头像真实file chooser、canvas解码压缩、取消、孩子改名/保存/重载/移除；PIN→算术→新PIN、错误答案、家庭名/月末天数设置。
- 两种伙伴、改名、成长/旧背包、免费互动；六田三种作物各轮播种和真实HTTP收获，全部八种需作物兑换的catalog、预览不持久化、摆放/收起/恢复、房屋2/3、两种动物每日去重及第3/7日里程碑；农场不改积分账本；服务实例重启恢复。
- 真实生产本地指令解析器经HTTP生成可编辑加分/提醒/礼品草稿，草稿不写PG，确认仍逐笔核验；账本回答、模板不加分、实际JSON Blob导出与当前家庭PG一致；受控HTTP503保留草稿、无语音API文字回退。
- 同scope普通草稿在隐藏后先验证再恢复；focus保留原input；PIN答案/grant不可恢复或自动提交；选图原上下文返回；成员被移除后不恢复旧草稿，再邀请为空草稿。
- America/Los_Angeles浏览器仍按上海零点、周末、月底三天及提醒计时器；页面00:01账本时间落为正确UTC。
- 密码修改拒绝错误旧密码、保留当前会话、撤销另一会话、旧密码不可登录；家庭改名、所有权交接及角色变化、家长退出、成员账号删除、owner账号删除受阻、精确名/密码家庭删除、无家庭及未验证账号删除、无关家庭完整保留。
- 设备独立音效boolean刷新保留、隐藏/退出实际音频暂停归零；常亮仅记录浏览器API接受与UI状态，非物理设备续亮证明。

## 执行方法与边界

```powershell
npm run test:browser
npm run test:browser:full
```

- 每次创建dedicated test数据库中的独立 `qa_v14_browser_*` schema，pool仅该search_path；随机loopback端口，拒绝4178/4180。不读取真实家庭JSON，不接触原预览业务，不重建renderer。执行后仅删除本次验证过前缀的测试schema。
- 全部新结果在v14唯一RUN目录；原v13和失败基线不覆盖。每个报告包含实际命令、版本、开始/结束源码哈希、HTTP动作元数据、截图及哈希、失败上下文；定向运行明确列出跳过分组。
- 业务状态只由页面表单/鼠标命中点击/逐笔确认产生；SQL只读核对state/revision。表单输入使用原生input/change事件。导出实际Blob与PG比较，不编造导出文件。
- 提醒/农场等待使用注入服务端时钟、浏览器Date和performance偏移；前台原生timer运行。不是墙钟等待8小时或后台推送。
- 邮件由真实注册/验证/邀请/恢复逻辑生成并由注入mailer捕获；没有外部SMTP投递。AI实际本地parser，apiKey为空；仅特定合成故障输入触发HTTP503；没有外部模型或麦克风测试。
- 五种桌面Chromium视口不是物理iPad/Safari。真实file chooser接收合成PNG，但隐藏/可见/focus为合成事件；没有OS选择器挂起、软键盘、原生BFCache、物理设备常亮/扬声器的证明。
- HTTP服务实例重启不等于OS进程或PostgreSQL重启。用户HTTPS环境、生产数据备份/恢复、外部发布不在此浏览器证据范围。

后端与集成参考：Lead最终[核心227/227测试日志](v14-core-tests.txt)、[42/42真实PG测试日志](v14-saas-tests.txt)、[27动作/98变体的独立授权审计](v14-action-audit.json)，均通过；QA未重复跑后端授权矩阵。[发布核对汇总](v14-summary.json)另记录静态/匿名原服务验证与Docker构建的实际边界。
