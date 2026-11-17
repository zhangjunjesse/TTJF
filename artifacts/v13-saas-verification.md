# v0.13 SaaS browser verification

The isolated real-PostgreSQL/real-HTTP browser acceptance run passed **21 checks**, produced **32 screenshots**, and recorded **zero uncaught browser errors**. All **20 layout audits** (four screens × five viewport sizes) passed. Tracked source hashes stayed identical for the entire successful run. This report covers QA task-12; the Lead's final integration review remains separate.

The canonical requirement is [the SaaS Working spec](../docs/saas-design.md): email/password, verified accounts, multiple isolated families, no billing, and one child/ledger/farm per family. The test implementation is [the SaaS browser runner](../test/saas-browser.cjs). QA changed that runner and v13 evidence only; it did not change product files.

## Executed commands and results

Commands ran from the repository root. Environment-file content, database credentials, mail tokens, passwords, PIN values, and cookie values are not included in the evidence.

```text
node --version
v22.17.0

node --check test/saas-browser.cjs
exit 0 (checked before each browser run)

node --env-file=.env.saas.test test/saas-browser.cjs
first run: exit 1; 15 checks passed; test navigation failure during viewport cleanup
second run: exit 0; 21 checks passed; 32 screenshots; sourceStable=true

npm run test:browser
> little-steps-family-dashboard@0.13.0 test:browser
> node --env-file-if-exists=.env.saas.test test/saas-browser.cjs
final frozen-source run: exit 0; 21 checks passed; 32 screenshots; sourceStable=true
```

The final successful run began **2026-11-16 14:37:47.298 UTC** and ended **14:39:07.290 UTC** (22:37–22:39 Asia/Shanghai). Its final machine-readable output was:

```json
{"result":"passed","checks":21,"screenshots":32,"sourceStable":true,"report":"artifacts/v13-browser/20261116143747298-33072/report.json"}
```

[The successful report](v13-browser/20261116143747298-33072/report.json) contains every check, timing, layout measurement, screenshot path/hash, sanitized browser request record, generated-mail metadata, late-response trace, PostgreSQL version/schema, and before/after source hash. No test was skipped in that run. A post-run integrity check independently verified all32 screenshot hashes, all19 tracked non-document source hashes against the final run, and all30 links in this evidence document. The canonical spec may subsequently receive the Lead's documentation-only update; it was unchanged during the recorded run.

[The first run's report](v13-browser/20261116142133145-54088/report.json) is retained. It stopped when the test searched for logout directly on the members page. The correct user path is Return account → Logout, and the runner was corrected to take it. That was a test navigation defect, not a product failure. Its earlier 15 workflow checks and desktop layout measurements passed, but the run is still classified failed. The frontend source also changed during that first run. [The complete second run](v13-browser/20261116142645464-16272/report.json) passed with stable sources. After the backend owner tightened mailbox validation and the Lead froze package0.13, QA reran the full suite using `npm run test:browser`. The latest linked report is that final frozen-source result, including the final security module and package hashes. The test's command/version metadata was also updated before that run; no browser scenario was removed.

## What the test actually composed

- Headless Microsoft Edge **157.0.4341.60** at the existing Puppeteer browser-test executable, real project HTML/CSS/scripts/assets, and the SaaS runtime flag enabled by the real SaaS server.
- A server created by the production `createSaasServer` factory, bound to a reserved ephemeral loopback port. The runner refuses port 4178 and unexpected browser HTTP origins.
- Real PostgreSQL **16.16**, using only `TEST_DATABASE_URL` in the dedicated local database ending `_test`. The successful fixture schema was `qa_v13_browser_33072_3253761115`.
- A supplied `pg.Pool` with `options: '-c search_path=<own schema>'`, with **no public fallback**. Migration tables and all synthetic data existed in that newly created schema. A direct SQL query verified the actual current schema; direct SQL queries also checked empty-family state and membership rows.
- Two synthetic verified accounts at `example.test`; family A and family B owned by the same account, with an invited parent joining and later leaving family A.
- Generated verification, invitation, and reset messages captured through the injected `mailer.sendMail`. Five messages were generated: two verification, two invitation, one reset. Tokens were used in memory and never persisted to the artifacts. No external mailbox or SMTP delivery was involved.
- Normal workflows driven by hit-tested UI clicks and keyboard input. `FamilyDemo` and `FamilySaas` were used for observations, not to set business state or invoke hidden product actions. Negative authorization checks also used real HTTP with actual browser cookies/CSRF values.
- Fixture teardown closed its browser contexts/server/pool and dropped only the validated schema created by that invocation. Cleanup produced no error. No real records under the legacy data directory were opened, no live 4178 records were requested, no renderer was rebuilt, and no v12 evidence was overwritten.

## Passed behavior

| Area | Observed result |
|---|---|
| Anonymous startup | Real SaaS login UI; no family state or farm canvas; no automatic business-state request. A direct unauthenticated state request returned 401 and `Cache-Control: no-store`. Synthetic legacy browser data did not render. |
| Registration and verification | Registration generated a real verification message but did not log the user in. Logging in before verification showed the verification gate; family creation returned 403 `EMAIL_UNVERIFIED`, and SQL confirmed zero family rows. Opening the mail fragment cleared it from the URL without consuming it. The explicit Verify button completed verification, after which login reached onboarding. Session cookie was HttpOnly with an allowed SameSite setting. |
| Empty family | Creating family A produced the supplied child, zero earned/spent/available points, empty history arrays, and `farm:null`. Browser state matched the HTTP response and actual PostgreSQL JSON. Exactly one initial membership existed. No old JSON/sample records appeared. |
| PIN-protected points | Owner configured the family PIN through the UI. A wrong PIN left earned points at zero. Correct operation-bound verification then committed one 500-point entry with a grant-bearing action request. |
| Farm loop | First use created the welcome plot; harvest yielded three carrots. The UI exchanged and placed a flowerpot, planted six carrot plots, advanced the injected server clock by eight hours, reloaded, and harvested 18 carrots. The points ledger remained earned500/spent0/available500. |
| Persistence | Closing/recreating the HTTP server instance against the same PostgreSQL schema and reloading the browser returned exactly the completed family state. This did not restart PostgreSQL or the operating-system process. |
| Same-browser family isolation | Family B started empty with a distinct child and no started farm. Switching A→B→A→B retained separate ledger/farm/history. Family A's child did not remain in family B's DOM. Synthetic legacy storage keys were unchanged and unused in the inspected storage windows. |
| Late 200 after switch | An actual completed family-A state response was held, the UI switched to lower-revision family B, and the old callback was released. Family B's state, scope epoch, and selected family remained unchanged. |
| Late 401 after re-login | Real HTTP logout revoked the old session while its browser cookie remained. The next real state request returned 401 and was held. The UI then logged out, logged in again, and opened B. Releasing the old 401 did not clear the new session/family. |
| Late 200 after logout and drafts | A real draft was typed before logout. Logout cleared family state and farm rendering; releasing the old 200 and allowing foreground ticks did not resurrect them. Logging in again and reopening the editor found the old draft absent. |
| Invitation ownership/email binding | Owner invitation generated a real message. The owner account, whose verified email did not match the target email, could not consume it; the invitation stayed pending. |
| Accept once/share existing family | The target account registered and verified, opened the invitation, and explicitly accepted. It saw the existing child, 500-point ledger and 18-carrot farm. Reusing the same invitation was rejected. |
| Remove and revoke | Owner removed the invited parent through the confirmation UI. A request carrying the removed parent's retained cookie and family ID returned 403 without state, and reloaded UI showed no family. A new invitation was then revoked; the target's explicit acceptance was rejected and its family list stayed empty. |
| Storage unavailable | Throwing getters for both localStorage and sessionStorage still permitted real login, opening A, switching to empty B, and logout. No uncaught browser error or old-family DOM remained. |
| Cross-tab logout and pageshow | Two real tabs in one browser context shared the session. Logout in one cleared the other tab. A dispatched persisted `pageshow` event rechecked the session and retained the login-only, empty-state result. |
| Password recovery | Forgot-password generated a reset message. Opening its link did not revoke the old session. Explicit reset revoked the old session; the old password failed, the new password succeeded, and family state remained intact. |
| Layouts and runtime | Five viewport sizes × login/home/account/members audited without horizontal document overflow. Every measured visible control was at least48px in both dimensions and measured input text was at least16px. Selected primary controls were hit-test reachable. No uncaught browser errors were recorded. |

The three late-response traces each record **one attempted abort** and an eventual callback release. These are real HTTP 200/401 responses with their real bodies. Only callback timing and the already-completed request's abort behavior were instrumented; no success/error response was fabricated.

## Screenshot inspection

QA personally opened and inspected **11 final-run screenshots** with the image-reading tool: all five home/farm views, small-phone login/account/members, the [unverified account gate](v13-browser/20261116143747298-33072/unverified-cannot-create-family.png), [new empty family](v13-browser/20261116143747298-33072/new-family-zero-history.png), and [logout after late response](v13-browser/20261116143747298-33072/logout-cleared-after-late-response.png). Before the final backend-only freeze, QA also personally inspected **all20 layout screenshots plus the same three critical views** in [the preceding successful run](v13-browser/20261116142645464-16272/report.json). The UI source hashes are unchanged between the two successful runs, and the five final home screenshots have the same hashes as those already inspected. The table below links all20 final layout captures; the remaining screenshots are listed and hashed in [the final report](v13-browser/20261116143747298-33072/report.json). Individual visual inspection is claimed only for the sets explicitly listed here.

| Viewport | Login | Home/farm | Account | Members |
|---|---|---|---|---|
| Desktop 1440×1000 | [Image](v13-browser/20261116143747298-33072/desktop-login.png) | [Image](v13-browser/20261116143747298-33072/desktop-home.png) | [Image](v13-browser/20261116143747298-33072/desktop-account.png) | [Image](v13-browser/20261116143747298-33072/desktop-members.png) |
| iPad landscape size 1024×768 | [Image](v13-browser/20261116143747298-33072/ipad-landscape-login.png) | [Image](v13-browser/20261116143747298-33072/ipad-landscape-home.png) | [Image](v13-browser/20261116143747298-33072/ipad-landscape-account.png) | [Image](v13-browser/20261116143747298-33072/ipad-landscape-members.png) |
| iPad portrait size 768×1024 | [Image](v13-browser/20261116143747298-33072/ipad-portrait-login.png) | [Image](v13-browser/20261116143747298-33072/ipad-portrait-home.png) | [Image](v13-browser/20261116143747298-33072/ipad-portrait-account.png) | [Image](v13-browser/20261116143747298-33072/ipad-portrait-members.png) |
| Phone size 390×844 | [Image](v13-browser/20261116143747298-33072/phone-login.png) | [Image](v13-browser/20261116143747298-33072/phone-home.png) | [Image](v13-browser/20261116143747298-33072/phone-account.png) | [Image](v13-browser/20261116143747298-33072/phone-members.png) |
| Small phone size 320×568 | [Image](v13-browser/20261116143747298-33072/small-phone-login.png) | [Image](v13-browser/20261116143747298-33072/small-phone-home.png) | [Image](v13-browser/20261116143747298-33072/small-phone-account.png) | [Image](v13-browser/20261116143747298-33072/small-phone-members.png) |

Visual observations: the business home keeps the named child, ledger, farm, farm buttons, and bottom navigation visible at all five sizes. The small-phone farm scene scales down while the measured action buttons remain 48px high; the farm open button is 68×48px. Long synthetic email addresses wrap within the account/member card. The small-phone members screenshot is a viewport capture of a vertically scrollable page, so invitation history/footer below its bottom edge is not claimed to fit simultaneously. The runner actually scrolls to and clicks Return account during cleanup. There was no observed horizontal truncation, overlapping primary control, old-family display, or broken farm rendering in the inspected images.

## Limits and remaining checks

- **Physical iPad not verified.** These are headless desktop Edge viewport sizes with mouse/keyboard browser automation, not iPad Safari, mobile virtual keyboard, real touch gestures, installed-app behavior, or device power/suspension testing.
- **External SMTP delivery not verified.** Real application-generated messages were captured by an injected mailer. Public email delivery, SPF/DKIM, provider throttling and mailbox-link interaction remain outside this run.
- Local HTTP test mode does not establish public HTTPS deployment, Secure-cookie behavior under HTTPS, reverse-proxy configuration, or production CSRF/origin deployment settings.
- Crop maturity uses an injected eight-hour clock advance. The clock also advances16minutes before the repeated layout login sweep to leave the previous authentication rate-limit window; the limiter itself was not disabled or weakened.
- Cross-tab logout is real; `pageshow({persisted:true})` is explicitly dispatched. Native BFCache restore, OS process kill/restart, network offline recovery, storage quota exhaustion, and browser-specific storage denial policies are not claimed. Storage failure is injected as throwing storage getters.
- Browser late-response evidence covers actual `/api/state`200 after switch/logout and401 after re-login. It does not independently establish late409/timeout, late AI/avatar/wake-lock callbacks, or every possible business-action race. Those need their corresponding frontend/backend regression evidence and Lead review.
- This run does not replace backend concurrency, grant/session binding, duplicate-action, static-file allowlist, rate-limit, expired-invitation, mail-failure, migration, or backup/restore tests. It does not exercise payment/billing, which is outside the chosen beta scope.
- No product defect was found in the final browser run. Product owners were informed of the results; no product edit was made by QA. Final release readiness depends on the Lead reviewing this evidence together with the separate backend and frontend suites.
