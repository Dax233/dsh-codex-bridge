# 派发面验证（B1–B7）

对象：`@local/dsh-codex-bridge`，commit `27aac52`。方法：FIXTURE（验证矩阵中的 FIX），全部离线执行，不消耗真实模型 turn，不读写真实 Codex home。

测试入口：`node --test tests/dispatch.test.mjs`（32 个测试：30 个 FIX + 2 个 CODE 静态审计，全部通过，约 7.5s）。

## 方法

- **加载真实插件**：`import { apply } from '../index.js'`，在假 Host context（`tools.register` / `effect` / `get` / `subprocess`）上执行 `apply`，捕获六个工具定义后直接调用 `execute(args, { agent: {} })`。
- **假 subprocess seam**（`tests/support/fake-seam.mjs`）复刻插件实际消费的契约：
  `spawn({ argv, cwd, stdio: { stdin: { data }, stdout: { maxBytes, spill: { maxBytes } }, stderr: { maxBytes } }, graceMs, env })`
  → `{ done: Promise<{ exitCode, signal }>, collected: { stdout: { readFrom }, stderr: { readFrom } }, terminate() }`。
  collect 模式保留每个流最后 `maxBytes` 字节，丢弃前部字节时 `lossy=true`；stdout 溢出且配置 spill 时写出 `spillPath`；`terminate()` 先发 SIGTERM、`graceMs` 后仍存活则 SIGKILL。
- **假 codex 可执行文件**（`tests/fixtures/fake-codex.mjs`，另有 `.cmd` / POSIX shim 供手工使用）：Node 脚本，按 `FAKE_CODEX_*` 环境变量产生 `thread.started` / `item.completed` / `turn.completed` / `error` / `turn.failed` / 非零退出 / hang / 超大 stdout 等行为；并把 argv、cwd、env、stdin 原始字节与 SHA-256 写入 capture 文件。Windows 无法用 CreateProcess 直接执行 shebang 脚本，假 seam 用 node 启动该脚本；插件 argv 契约在记录的 spawn spec 上断言，不因该翻译而弱化。
- **临时 CODEX_HOME 夹具**（`tests/support/fixture.mjs`）：`session_index.jsonl`、`sessions/.../rollout-*.jsonl`（含 `session_meta.cwd`）、`thread-writer-locks`、`automations`、`goals_1.sqlite`（node:sqlite）。每个测试独立目录，位于 %TEMP%，测试结束删除，不接触真实 ${CODEX_HOME}。
- **凭据泄漏探针**：测试进程设置 `OPENAI_API_KEY` / `GITHUB_TOKEN` / `CODEX_API_KEY` / `AWS_SECRET_ACCESS_KEY`，断言 spawn env 与子进程实际 env 中均不存在这些键。

> **修复状态**：验证时点代码为 `27aac52`，B1 的 prompt `trim()` 限制与 B5 的 usage 回退限制已在提交 `4fdc340` 修复并加回归测试（见文末「修复记录」）。

## 结果摘要

| 项 | 结论 | 要点 |
|---|---|---|
| B1 新线程 argv/stdin/env | PASS-WITH-LIMITS | argv 形状、Unicode/多行 stdin 字节、env 白名单与凭据隔离全部符合；prompt 首尾空白被 `trim()` |
| B2 异步与轮询 | PASS | `waitMs=0` 立即 running+runId；列表/详情/轮询到 completed；`waitMs>0` 阻塞；`maxWaitMs` 封顶 |
| B3 resume | PASS-WITH-LIMITS | argv、rollout-meta cwd、线程解析、单写者保护符合；外部写者真实拒绝形态离线不可复现 |
| B4 失败路径 | PASS | 非零退出 / 协议 error / turn.failed / spawn 抛错 / done reject / 未知线程 / 未知 runId / 空 message 均为明确失败 |
| B5 codex_run 语义 | PASS-WITH-LIMITS | limit clamp、target、usage、preview、finalMessage 裁剪、lossy 标记符合；真实 CLI 的 usage 字段差异见缺陷 3 |
| B6 dispose/终止 | PASS | 运行中子进程被终止一次、run 变 failed、后续 send 被拒；已完成 run 不受影响 |
| B7 liveness nudge | PASS-WITH-LIMITS | allowNudge 门禁、固定消息、blocked/paused 不 nudge、异常捕获符合；turn 失败语义为 nudged+failed |
| CODE 静态审计 | PASS | `lib/runner.mjs` env 白名单无凭据形状名、不展开 `process.env`；buildArgv 模板与验证一致 |

## B1 新线程派发 argv/stdin/env — PASS-WITH-LIMITS

证据（`B1-new-thread` 等）：

- **argv**：`<executable> exec --json --skip-git-repo-check -C <cwd> -c approval_policy=never -`，与矩阵一致。可选 `model` / `approvalPolicy` / `sandboxMode` 依次追加为 `-m <model>`、`-c approval_policy=<...>`、`-c sandbox_mode=<...>`，位置在结尾提示标记 `-` 之前；未传 `cwd` 时使用 `config.defaultCwd`。
- **stdin**：子进程侧 capture 证明收到的原始 stdin 字节与发送内容逐字节一致（UTF-8；中文、emoji、tab、多行均保留；字节数与 SHA-256 与测试期望一致），而不是只经插件内存推断。
- **env**：spawn spec 与子进程 env 都只含白名单键（`PATH`、`SystemRoot`、`TEMP` 等）以及对照夹具显式声明的键；四个凭据标记键均不存在；`CODEX_HOME` 指向夹具 home，`NO_COLOR=1`、`TERM=dumb`。
- **CODE**：`lib/runner.mjs` 的 `ENV_KEYS` 是显式数组（29 项），全文没有 `...process.env`，白名单内没有 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL 形状的名字；`CODEX_HOME` 为显式赋值。
- **限制**：`index.js` 在派发前执行 `message.trim()`，因此 prompt 的首尾空白不会原样到达 stdin；内部换行与 Unicode 不变。矩阵“prompt 原样传入”按内容成立、按首尾空白不成立，行为由 `B1 prompt fidelity` 测试固定。建议 README 注明，或改为用 trim 判空、传原串。

## B2 异步与轮询 — PASS

- `waitMs=0`：子进程夹具延迟 500ms 时，`codex_send` 37ms 返回 `status: running` + runId；`codex_run` 无参列表可见该 run（target `(new)`、prompt 预览）；详情为 running、`target: (new)`、`final message: (none yet)`。
- 轮询到 `completed` 后详情含 `target: (new) -> <thread-id>`、`usage`、final message。
- `waitMs>0`：子进程延迟 100ms 时阻塞到 completed 才返回（耗时 ≥ 延迟）。
- `maxWaitMs` 封顶：`config.maxWaitMs=1000`、请求 `waitMs=5000`、子进程睡眠 2500ms → 1053ms 返回 `status: running`（未获得结果，但按封顶返回，提示继续轮询）。
- 无 run 时列表返回 `no bridge runs in this Host session yet`。
- **限制**：跨 DSH 会话的 Host 级 run 可见性属于 LIVE/C2（见 `docs/verification.md`），FIX 只覆盖同一插件实例。

## B3 resume 续聊 — PASS-WITH-LIMITS

- **argv**：`<executable> exec resume --json --skip-git-repo-check -c approval_policy=never <thread-id> -`；resume 不带 `-C`（与源码一致），cwd 由子进程工作目录承载。
- **cwd**：未传 `cwd` 时取线程 rollout 首行 `session_meta.payload.cwd`；显式 `cwd` 可覆盖。
- **线程解析**：名称、`@名称`、id 前缀都解析到同一线程 id；解析结果出现在 argv 倒数第二个位置。
- **单写者**：同线程已有本插件 running turn 时再次 `codex_send` 返回 `refused: thread <label> already has a running bridge turn (<run-id>); poll codex_run instead of starting a second writer`，seam 调用数保持 1（未 spawn 第二个进程）。
- **外部写者拒绝**：离线无法复现真实 Codex 行为；FIX 用假 CLI 以 exit 1 + stderr 模拟，插件回报 `status: failed`、`stderr tail` 与 final message，错误不被吞掉。真实 Codex 桌面 app 的拒绝文本/退出码未验证（见“未验证”）。
- **限制**：本组只验证插件侧契约；真实 writer-lock 竞争形态需 E2E。

## B4 失败路径 — PASS

| 注入 | 观察 |
|---|---|
| 非零退出（exit 3）+ stderr | `status: failed`；final message 取 stderr；`stderr tail` 可见 |
| JSON `error` 事件（exit 0） | `status: failed`；`error: <message>`；final message 兜底 |
| `turn.failed` 事件 | `status: failed`；`error: <error.message>` |
| `ctx.subprocess.spawn` 同步抛错 | 工具调用 reject（错误原文透传）；不产生 run 记录 |
| seam `done` reject（异步启动失败） | run 变 failed；`error` / final message 记录 seam 错误；无未处理 rejection |
| 未知线程 | 抛 `unknown Codex thread "<ref>"; named threads: ...` |
| 未知 runId | 抛 `unknown run id "<id>"` |
| 空 / 非字符串 message | 抛 `message must be a non-empty string`，零 spawn |
| liveness threads 含未知线程 | 抛 `unknown Codex thread ...` |

所有失败路径都能从工具输出或异常直接定位原因，没有静默成功。

## B5 codex_run 语义 — PASS-WITH-LIMITS

- **limit clamp**（31 个 run）：默认 8 行；`limit:100` → 30 行；`limit:0` → 1 行；`limit:2.5` → 退回默认 8 行（非取整，与 `docs/verification.md` 缺陷 6 一致）。
- **target 标注**：列表中新线程为 `(new)`，resume 为 `<thread-id>`；详情中新线程完成后为 `(new) -> <thread-id>`。
- **prompt 预览**：列表行内单行化并裁剪到 60 字符 + `…`。
- **finalMessage 裁剪**：6500 字符的 final message 在 `codex_run` 详情中为 6000 字符 + `…`（实测长度 6001）。
- **usage**：夹具 `turn.completed.usage.total_tokens=1500` → `usage: 1.5k`。
- **大输出**：`maxOutputBytes=4096`、stdout 约 200KB 时 run 仍 completed，尾部事件解析正确，详情显示 `(stdout window truncated; full stream spilled on disk)`；假 seam 写出 200,404 字节 spill 文件（夹具行为，不是真实 CLI）。
- **限制**：真实 Codex 0.163 的 `turn.completed.usage` 没有 `total_tokens`（只有 input/output tokens），LIVE 下 `usage` 显示 `—`（见 `docs/verification.md` 缺陷 1）；本组 FIX 按插件契约验证了 total_tokens 路径，二者结论一致不矛盾。

## B6 dispose / 终止 — PASS

- 运行中（hang）子进程：`dispose()` 调用一次 `terminate()`；子进程退出（夹具内 exitCode null / signal SIGTERM）；run 变 `status: failed`，final message 兜底 `codex exited without a message`。
- dispose 后再次 `codex_send`：reject `codex bridge is shutting down`。
- 已完成的 run 不受 dispose 影响（terminate 次数 0，状态仍 completed）。
- 同线程二次写的保护见 B3。

## B7 liveness nudge 路径 — PASS-WITH-LIMITS

- `allowNudge=true` + stalled goal-active 线程（2 小时无写入，默认 idle 阈值 30 分钟）：输出恰好一条 `  nudged -> run <run-id> (completed)`；派发 argv 为 resume 且含该线程 id；子进程 stdin 与固定续跑消息逐字节一致（SHA-256 一致）。
- `allowNudge=false`：精确返回 `refused: nudge requested but config.allowNudge is false (set allowNudge: true in the plugin config to enable)`，零 spawn。
- blocked / paused goal（同样 2 小时无写入）：输出 `blocked goal (needs an authorized resume; not nudged)` / `paused goal (not nudged)`，零 spawn。
- 派发异常（用已 dispose 的 runner 模拟）被捕获为 `  nudge failed: codex bridge is shutting down`，不中断 liveness 输出。
- 已派发但 turn 失败（exit 1）时输出 `  nudged -> run <run-id> (failed)`；`nudge failed:` 只用于派发/等待异常，二者不会静默失败。这是语义边界，不是缺陷。
- 线程已有 running bridge turn 时 verdict 为 `working (bridge turn <run-id>)`，不会再次 nudge（spawn 数不增）。

## CODE 静态审计 — PASS

- `lib/runner.mjs`：`ENV_KEYS` 显式 29 项白名单；无 `...process.env`；白名单无凭据形状名；`CODEX_HOME` 显式赋值。
- `buildArgv` 新线程 / resume 模板与 B1/B3 实测一致；`index.js` 含 `runs.runningFor(thread.id)` 单写者守卫与 refused 文案。

## 测试清单

`tests/dispatch.test.mjs`（32 个测试）：

| 组 | 测试 |
|---|---|
| B1 | new thread argv/stdin/env、cwd 默认与 argv 覆盖、prompt 保真与 trim、空 prompt 拒绝 |
| B2 | waitMs=0 异步+列表+轮询、waitMs>0 阻塞、maxWaitMs 封顶、空列表 |
| B3 | resume argv/cwd/线程解析、单写者拒绝、外部写者拒绝形态 |
| B4 | 非零退出、协议 error、turn.failed、spawn 抛错、done reject、非法参数、liveness 未知线程 |
| B5 | target/preview/usage、limit clamp、finalMessage 裁剪、超大 stdout lossy+spill |
| B6 | dispose 终止运行中进程、dispose 不影响已完成 run |
| B7 | allowNudge=true 固定单条消息、allowNudge=false 拒绝、blocked/paused 不 nudge、nudge 异常捕获、turn 失败语义、running 线程不重复 nudge |
| CODE | env 白名单静态审计、buildArgv 模板静态审计 |

## 修复记录（提交 `4fdc340`）

| 限制 | 修复 | 回归测试 |
|---|---|---|
| prompt 首尾空白被 `message.trim()` 去掉 | `index.js` 只用 `trim()` 判空，原始 message 进入 stdin | `B1 prompt fidelity: the prompt reaches stdin byte-for-byte, edge whitespace included` |
| 真实 Codex 0.163 的 usage 无 `total_tokens` → `usage: —` | `lib/util.mjs` 新增 `usageTotal()`：`total_tokens` → `totalTokens` → `input_tokens + output_tokens`；`codex_run` 使用 | `usageTotal tolerates CLI field-name differences` + `B5 usage falls back to input+output tokens when the CLI omits total_tokens` |

生效条件：运行中的 DSH Host 需重载该插件 bundle（禁用→启用）或重启后，LIVE 工具才使用修复后的代码。

## 复现

```sh
node --check index.js
node --test tests/dispatch.test.mjs

# 可选：把每条断言的原始观察写成 JSON 证据
DISPATCH_EVIDENCE_DIR=<证据目录> node --test tests/dispatch.test.mjs
```

Windows PowerShell 下设置环境变量的写法：

```powershell
$env:DISPATCH_EVIDENCE_DIR = "$env:TEMP\dispatch-evidence"; node --test tests/dispatch.test.mjs
```

不依赖真实 ${CODEX_HOME}、不消耗真实模型 turn；假可执行文件、夹具 home 与 spill 文件全部在 %TEMP% 下创建，结束删除。

## 缺陷与限制

| # | 级别 | 现象 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | info | prompt 首尾空白被 `message.trim()` 去掉 | 严格“原样传入”只在内容层成立 | README 注明；或用 trim 仅判空、传原串 |
| 2 | info | nudge 已派发但 turn 失败显示为 `nudged -> run ... (failed)`，不是 `nudge failed:` | 语义边界，仍明确可见 | 文档化；或统一两种失败措辞 |
| 3 | minor | 真实 Codex 0.163 的 usage 无 `total_tokens`，LIVE 下 `usage: —` | 详情 usage 不可用 | 回退计算 input+output tokens（与 `docs/verification.md` 缺陷 1 相同） |
| 4 | info | `limit` 传小数退回默认值而非取整 | 轻微意外行为 | 文档化或取整（与 `docs/verification.md` 缺陷 6 相同） |

本组未验证（FIX 方法边界，需 LIVE/E2E 补）：

- 真实 `codex exec` 的端到端行为（B8，由 Lead 执行）；
- 真实 Codex 桌面 app 与插件同时写同一线程时的拒绝文本/退出码；
- 真实 CLI 触发 stdout 超限时的 lossy/spill 行为；
- Host 级跨 DSH 会话 run 注册表（C2，LIVE）；
- macOS / Linux 上的进程终止与 spawn 语义（本组在 Windows 11 上执行，假 seam 的翻译只覆盖 Node 脚本）。

## 安全边界

- 全程未调用真实 `codex_send` / nudge；未向任何真实线程派发任务。
- 未读写真实 ${CODEX_HOME}；夹具与 spill 只在 %TEMP%。
- 未修改插件运行时源码（`index.js`、`lib/**`、`README`、`package.json`、既有测试均未改动）。
- 原始证据（含真实临时路径与随机 id）保存在验证者本地研究目录，不随本仓库发布；本文件与 `tests/dispatch.test.mjs` 可公开复跑。
