# v0.15 SQLite 验证记录

日期：2026-11-17。基线：`e045d39f2dbf27601c833abcd5c3413a91f36ed6`。本轮在 Windows、Node 22.17.0、内置 SQLite 3.50.0、Microsoft Edge 上验证，所有数据均为独立临时文件和合成账号。没有连接实际 PostgreSQL、旧家庭存档或外部邮件服务。

## 实际完成

`npm test` 和 `npm run test:saas` 所定义的全部用例按文件或用例组执行，合计 **293/293 通过，0 失败、0 跳过、0 取消**。不是把多次运行写成一次整套命令通过，也没有把重跑和前置步骤重复计数。

| 范围 | 通过数 | 实际入口 |
| --- | ---: | --- |
| 原领域、旧服务、农场、SaaS 模型/日期/客户端 | 219 | `node --test` 执行 package.json 的核心文件，暂不含 v15-client |
| 真实浏览器客户端 C1–C8 | 8 | `node --test --test-name-pattern='C[1-4]' test/v15-client.test.cjs`，另分 C5–C6、C7–C8 |
| SQLite 连接、约束、事务、持久化和备份 | 13 | `node --test test/sqlite-store.test.cjs` |
| 直接 Node 启动、开发邮件及重启登录 | 2 | `node --test test/saas-startup.test.cjs` |
| 账号与邮件 | 6 | `node --test test/saas-auth.test.cjs` |
| 家庭事务、授权和重复请求 | 5 | `node --test test/saas-store.test.cjs` |
| HTTP、隔离和 UUID 大小写兼容 | 9 | `node --test test/saas-server.test.cjs` |
| 家庭私有导出/导入 | 5 | `node --test test/saas-data.test.cjs` |
| 整库备份/恢复、初始化及文件保护 | 8 | `node --test test/saas-db.test.cjs` |
| 生命周期、撤权、交接和删除竞争 | 12 | `node --test test/saas-lifecycle.test.cjs` |
| 临时数据清理 | 5 | `node --test test/saas-maintenance.test.cjs` |
| 独立业务动作审计 | 1 | `node --test --test-reporter=spec test/saas-action-audit.test.cjs` |

最后一项在真实 HTTP → 授权 → SQLite 链路中覆盖 **27 类动作、98 个变体和 528 项检查**，提交 98 个回执；重复执行不重复入账，另一家庭未改变。它是一个 Node test，不把 98 个变体再加到 293 项总数里。最终审计的源码哈希与交付代码一致。

干净安装 `npm ci --ignore-scripts --no-audit --no-fund` 成功；生产依赖只保留 nodemailer，数据库使用 Node 内置模块。`npm ls --all` 与 `git diff --check` 通过。可选 Compose 使用示例环境文件执行 `config --quiet` 通过，未构建或运行容器。

精确命令、时间、计数、审计源码哈希和浏览器场景清单保存在 [机器可读结果](sqlite-verification-results.json)。完整本机日志和截图在 `.git/codex-sqlite/`，不作为运行依赖，不把包含合成令牌的原始浏览器请求记录提交到仓库。

## 定向浏览器检查

额外完成 **18 个唯一的选中检查**，前置步骤单列，不重复计算：

- 基础浏览器 14 项：匿名隔离、注册验证、空家庭、逐笔 PIN 核验、积分和农场持久化、多家庭切换、迟到 200/401、退出清草稿、邀请加入/撤权及找回密码，并检查无未捕获异常和无业务浏览器存储。
- 完整业务浏览器 4 项：修改密码并撤销另一会话、家庭改名及所有权交接、积分模板创建/编辑/禁用/启用、提醒创建/编辑/复制/改期/删除。

使用 `TEST_CASE_PATTERN` 选择原有场景，完整业务另用 `SAAS_FULL_GROUPS`。每块都是独立临时 SQLite 和真实浏览器点击；数据库权限、业务断言及默认完整运行路径保留。例如：

```powershell
$env:TEST_ARTIFACT_DIR = 'data/test-evidence'
$env:TEST_CASE_PATTERN = 'Late actual200|Late actual401'
node test/saas-browser.cjs

$env:SAAS_FULL_GROUPS = 'points'
$env:TEST_CASE_PATTERN = 'Template create/edit/disable/enable'
node test/saas-full-browser.cjs
```

本轮没有把基础 21 项、完整业务 27 项全部重新跑完：基础中两个浏览器存储/跨页签场景和五个视口扫查未选；完整业务中其余 22 个业务场景未选，结束时的无异常检查作为前置/收尾条件执行。没有将这些未选项目计为通过。物理 iPad/Safari、外部 SMTP/HTTPS、生产数据恢复、完整 PG 账号迁移和长期负载也未验证。

## 发现、修复与复核

- Windows 的备份 fsync 最初使用只读句柄而报 EPERM，改用可写句柄后备份恢复回归通过，没有忽略同步错误。
- 真实 SQLite 的 `INSERT OR ROLLBACK` 可提前结束事务；修复后，即使回调捕获错误也不能继续以 autocommit 漏写。回归验证失败事务没有残留写入，后续事务仍可使用。
- PG UUID 类型原本大小写等价，SQLite UUID 列增加一致 NOCASE 排序规则；主外键、唯一性及真实 HTTP 参数都验证，动作 ID 和令牌保留大小写敏感。
- 修改过的备份可能包含删除家庭的触发器；整库工具现在拒绝本版本没有声明的所有触发器。恢复拒绝覆盖目标，失败不改源备份，清理仅删除本次创建的暂存文件。恢复成功后旧会话、邮件令牌、邀请及临时授权失效，永久账本和回执保留。
- 原容器自动设置 `SQLITE_FILE` 可能绕过旧 `DATABASE_URL` 保护。先建立会失败的回归，再改为任何残留旧 URL 都拒绝启动。核心/启动 15 项及业务动作审计随后重跑通过。
- 定向选择所有权交接后，旧测试收尾仍停在账号页而拿不到业务快照；测试运行器改为通过真实家庭选择页面返回后再验证重载，原业务断言保留，该场景整块复验通过。

早期源码仍在编辑时的一次浏览器运行、收尾未修复的一次运行均排除。迟到响应与退出合跑曾触及本机 55 秒边界而被终止，未计通过；拆为迟到响应、退出与密码恢复两块后均完成。过程中的依赖尚未落盘、Windows 同步失败和上述审查复现日志均保留。

成功浏览器运行期间源码均稳定。较早报告与最终版本仅在后续改动的工具恢复保护、完整浏览器定向收尾、旧 URL 启动拒绝上有差异；前两项不在基础浏览器执行路径，浏览器夹具不携带旧 URL。相关工具、核心/启动和动作审计分别复验，机器结果显式记录每次的 `changedSinceRun`，没有宣称所有场景来自同一个整套运行。

在上述已执行范围内，修复后**无已知失败**。远端接手时未配置 GitHub Actions，本机结果不代表 CI 或生产部署已通过。
