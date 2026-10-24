# 能力验证

本文件记录 `dsh-codex-bridge` 的能力验证：对每个工具、参数边界、失败路径与安全承诺逐项给出验证方法、结果和证据。

- 验证对象：commit `27aac52`（验证时点），修复提交 `4fdc340`；功能新增 v0.2.0 `codex_queue`、v0.2.1 可执行文件自动跟随桌面版更新（本文件「codex_queue 能力」「桌面版自动更新与工具层对接复验」节）；
- 验证环境：Windows + DSH 0.2.1-rc.3 + Codex 桌面版自带 CLI；初始验证为 0.163.0-alpha.11.2，2026-10-24 晚桌面版自动更新到 0.164.0-alpha.11.1 后分别回归（`${CODEX_HOME}` 已脱敏）；
- 安装形态：profile `dsh.profile.bundles` + `link:` 到本仓库（junction）。

方法分三类：

| 方法 | 含义 |
|---|---|
| **LIVE** | 在真实 DSH 会话里调用已安装的 `codex_*` 工具，读取真实 Codex home（只读面）。 |
| **FIXTURE** | 临时 Codex home 夹具 + 假 subprocess seam / 假 `codex` 可执行文件，`node --test` 离线复现，不消耗模型 turn。 |
| **REAL E2E** | 真实 `codex exec` 派发（仅新建测试线程）。 |

结论词：**PASS** / **PASS-WITH-LIMITS** / **FAIL** / 未验证。

## 结果摘要

| 组 | 范围 | 结果 |
|---|---|---|
| A | 只读数据面：`codex_threads` / `codex_read` / `codex_goals` / `codex_liveness` | **8/8 PASS**（A2/A5 曾判 FAIL，缺陷 D1/D2 已修复）→ [read-plane](verification/read-plane.md) |
| B | 派发面：`codex_send` / `codex_run` / runner / nudge | **7/7 PASS**（B1/B5 的 2 项限制已修复）→ [dispatch-plane](verification/dispatch-plane.md) |
| C | 集成、安装、配置门禁、依赖与性能 | **PASS**（见下） |
| E2E | 真实新线程：异步派发 → 轮询 → resume 回读 | **PASS**（见下） |
| 离线套件 | `npm test` | **78/78 pass**（unit 9 + readonly 27 + dispatch 33 + queue 9） |

## C. 集成与运行验证

### C1 工具注册 — PASS

从真实 `index.js` 的 `apply()` 捕获七个 `tools.register` 定义，参数与源码一致、无缺失：

| 工具 | 参数 | 必填 |
|---|---|---|
| `codex_threads` | `query`, `limit`, `activeWithinMinutes` | — |
| `codex_read` | `thread`, `limit`, `kinds`, `maxChars`, `tailBytes` | `thread` |
| `codex_send` | `message`, `thread`, `waitMs`, `cwd`, `model`, `approvalPolicy`, `sandboxMode` | `message` |
| `codex_queue` | `thread`, `message`, `waitMs` | `thread`, `message` |
| `codex_run` | `runId`, `limit` | — |
| `codex_goals` | `thread`, `status`, `limit` | — |
| `codex_liveness` | `threads`, `idleMs`, `nudge` | — |

七个工具均为 `{ text }` 输出 schema；全新会话可直接调用（本次验证即在全新会话中完成）。

### C2 运行注册表是 Host 级共享 — PASS

新会话的 `codex_run` 能看到上一个 DSH 会话创建的 run（同一 Host 进程的插件实例），按开始时间倒序。含义：**run 记录跨 agent 会话可见，但 DSH 重启后清空**（内存态）。2026-10-24 22:17 重启 DSH 后实测：`codex_run` 返回 `no bridge runs in this Host session yet`，确认清空行为。

### C3 安装与加载 — PASS

- profile `package.json` 的 `dsh.profile.bundles` 含 `@local/dsh-codex-bridge`，`dependencies` 为指向本仓库的 `link:`；
- `node_modules/@local/dsh-codex-bridge` 是指向仓库目录的目录联接；
- 修改源码后经 bundle 禁用→启用热重载生效（验证期间修复 resume 参数时实证），DSH 重启后同样生效。

### C4 配置门禁 — PASS

未写 profile 级覆盖时使用默认配置：`approvalPolicy: never`、`allowNudge: false`、`sandboxMode: ''`（继承 Codex 原生配置）。实测 `codex_liveness({ nudge: true })` 在默认配置下返回：

```text
refused: nudge requested but config.allowNudge is false (set allowNudge: true in the plugin config to enable)
```

即默认绝不向 Codex 线程自动发消息；拒绝发生在任何子进程启动之前。

### C5 依赖、可移植性与只读静态审计 — PASS-WITH-LIMITS

- 运行时零第三方依赖（`dependencies` / `peerDependencies` 为空）；导入只有 `node:crypto`、`node:fs`、`node:os`、`node:path` 与本地 `lib/*.mjs`。
- 源码与文档无本机绝对路径（测试夹具里的固定字符串除外）。
- 运行时唯一与写入相关的调用是 `node:sqlite` 的 `DatabaseSync(file, { readOnly: true })`；没有 `writeFile`/`appendFile`/`mkdir`/`unlink` 等调用（只读保证另见 read-plane A6：夹具树哈希前后一致、0 spawn）。
- **限制**：`engines.node` 写 `>=22`，但 `node:sqlite` 在 Node 22 需要 `--experimental-sqlite`（23.4+/24 才默认可用）。缺失时 goal 能力优雅降级，其余工具正常。

### C6 性能 — PASS

| 调用 | 实测耗时 | 说明 |
|---|---|---|
| `codex_threads(limit=1)` | 51ms | 全量 catalog（128 条 goal、全部 rollout 扫描） |
| `codex_goals(limit=1)` | 21ms | 只读 sqlite 查询 |
| `codex_read(783MB rollout)` | 29ms | 只读尾部窗口（默认 1.5MB），不整文件加载 |
| `codex_send(waitMs=0)` 返回 | 92ms | 异步派发立即返回 runId |

### C7 文档一致性 — PASS（已按验证结果补齐）

README 与实际行为一致；验证中发现的边界已补进 README「行为与边界」：prompt 原样传入、无取消/流式、默认读 kinds 含 developer、liveness 默认扫描范围、`node:sqlite` 依赖。

## E2E. 真实派发（仅新建测试线程）

1. **异步派发**：`codex_send({ message: 'Reply with exactly one line: VERIFY-ASYNC-OK…', waitMs: 0 })` 92ms 返回 `status: running` + runId；`codex_run({ runId })` 轮询 19s 后 `completed`，`final message: VERIFY-ASYNC-OK`，并回报新线程 id。
2. **resume 续聊**：对同一线程 `codex_send({ thread, message: 'What single line did you reply in the previous turn?…', waitMs: 90000 })` 15s 完成，模型正确回忆 `VERIFY-ASYNC-OK` → 上下文连续性成立。
3. **回读**：`codex_read` 看到两轮 user/assistant/turn-end 记录；`cwd` 为调用方 DSH 会话工作区（未传 `cwd` 时的会话工作区兜底生效）；`codex-cli` 版本与 provider 正确；`kinds` 过滤与 `maxChars` 截断生效；线程 id 前缀可解析。
4. **线程可见**：`codex_threads` 按 query 找到新线程；`codex_run` 列表同时包含两次新 run 与上一会话的 run（C2）。

## 验证中发现并修复的缺陷（提交 `4fdc340`）

| # | 缺陷 | 修复 | 回归测试 |
|---|---|---|---|
| D1 | 仅存在于 `session_index.jsonl` 的线程 `last` 显示约 20750.6d，`activeWithinMinutes` 误排除（真实 298 线程中 151 个受影响） | `lib/catalog.mjs` 把索引 `updated_at` 纳入 `lastActivityMs` | readonly「A2 index-only threads report the session_index update age…」 |
| D2 | `config.liveness.threads` 写线程 ID 不生效（实现只比较名称，与 README 不符） | `index.js` 同时比较名称与 ID（大小写不敏感） | readonly「A5 configured liveness threads match by id as well as by name」 |
| D3 | Codex 0.163 的 `turn.completed.usage` 无 `total_tokens`，`codex_run` 的 `usage` 恒为 `—` | `lib/util.mjs` 新增 `usageTotal()`：`total_tokens` → `totalTokens` → `input+output` 回退 | unit「usageTotal tolerates…」+ dispatch「B5 usage falls back…」 |
| D4 | `codex_send` 对 message 做 `trim()`，prompt 首尾空白不原样传入 | `index.js` 只 trim 判空，原始 message 进 stdin | dispatch「B1 prompt fidelity: the prompt reaches stdin byte-for-byte…」 |

D1 在真实 `${CODEX_HOME}` 上做了模块级修复前后对比：151 个仅索引线程从 `lastActivityMs=0`（20750.6d）变为真实索引年龄（16–23 天量级），epoch 行 0 个。

> 生效条件与复验：运行中的 DSH Host 需重载插件 bundle（禁用→启用）或重启，LIVE 工具才使用修复后的代码。2026-10-24 22:17 重启 DSH 后，D1 / D3 / D4 已在 live 工具上复验通过（见下节）；D2 因当前 profile 未配置 `liveness.threads`，仍只有离线测试证据。

## 重启后 live 复验（2026-10-24 22:17，重启后代码 = `d5514ae`）

| 检查 | 结果 |
|---|---|
| 六个 `codex_*` 工具重新注册并可用 | PASS（重启后直接调用成功） |
| C2 运行注册表重启后清空 | `codex_run` 返回 `no bridge runs in this Host session yet`（此前只有推断，现已实测） |
| D1：仅索引线程的最近写入 | 抽样归档线程显示 `last=16.5d`（修复前为 20750.6d）；Top 50 行无 epoch 年龄；`activeWithinMinutes=30d` 返回 35 行且包含仅索引线程（修复前会被误排除） |
| D3：`codex_run` usage | 真实 turn 完成 27s 后详情显示 `usage: 17.5k`（修复前恒为 `—`） |
| D4：prompt 逐字节 | 新线程 rollout 中的 user 消息与发送内容完全一致（长度 100，首尾各两个换行均保留） |
| 真实派发链路 | 新线程 27s 完成 `AFTER-RESTART-OK`；`codex_read` 可回读；`codex_run` 列表含该 run |
| D2：按 ID 配置 liveness 线程 | 仍未 live 触发（profile 未配置 `liveness.threads`）；由离线回归测试覆盖 |

## 仍存在的限制（未修复，均为设计或已知边界）

| 编号 | 限制 | 说明 |
|---|---|---|
| L1 | 短 id 前缀歧义静默解析 | 多个线程共享 8 位前缀时取最近活动者、不报歧义；派发时建议用完整 id。 |
| L4 | 续写分段只读最新段 | 同一线程多个 rollout 分段时，`codex_threads` 的 size 与 `codex_read` 只覆盖最新段；真实 23 个线程中 2 个受影响。 |
| — | 无取消、无流式 | 运行中 turn 只能等 `codex_run` 或 Host 关闭时终止；只回最终消息。 |
| — | 默认读 kinds 含 `developer` | Codex 注入的长指令可能占满默认 12 条窗口；读对话传 `kinds: ['user','assistant','turn-end']`。 |
| — | liveness 默认扫描全部 goal/automation 线程 | 历史线程多时输出很长；用 `config.liveness.threads` 收窄。 |
| — | 未知线程导致整次调用失败 | `codex_liveness({ threads: [...] })` 中一个错名会中断整批，而非逐条标注。 |
| — | `limit` 传小数退回默认值 | 非取整（如 2.5 → 默认 8/15）；用整数。 |
| — | 桌面版持有的线程不能 `codex_send` resume | Codex 0.163/0.164 以 writer 锁拒绝外部 CLI 写入，无绕过选项；写方向用官方 `codex queue`（v0.2.0 起由 `codex_queue` 封装）。 |
| — | liveness 的 `writer lock fresh` 短暂误报 | Codex 写入 `thread_settings_applied` 等非对话事件也会刷新锁文件 mtime；不影响读取与 queue 派发。 |

## 对接桌面版持有的线程：writer 锁与官方 queue 通道（2026-10-24 补充实测）

真实环境里五个研究线程（seori / sia / fei / danny / kiri）由 Codex 桌面版进程持有 OS 级 writer 锁（`${CODEX_HOME}/thread-writer-locks/<id>.lock` 被独占锁定）。因此：

- `codex_send`（内部 `codex exec resume`）对这类线程失败：
  `thread-store conflict: thread <id> already has an active writer` / `thread/resume failed ... (code -32600)`；`codex exec resume --help` 没有绕过 writer 的选项。
- `codex_threads` / `codex_read` / `codex_goals` / `codex_liveness` 仍然可用（只读不受影响）。
- Codex CLI 0.163 提供官方队列通道：`codex queue --thread <完整 UUID> --message <text>`（用线程名会报 `No active session found matching '<name>'`）。投递后由桌面版消费并执行 turn，队列项随即从 `queued_items` 移除；本次实测 seori 在投递后数秒内执行，DSH 侧用 `codex_read` 回读到 `RELAY-HANDSHAKE-OK`。
- 结论：桌面版运行时，relay 的"写"方向应走 queue；v0.2.0 起由 `codex_queue` 工具封装（本机 live 工具需重载/重启后可见）。

| 能力 | 对桌面版持有的线程 |
|---|---|
| `codex_threads` / `codex_read` / `codex_goals` / `codex_liveness` | 可用（只读） |
| `codex_send`（resume） | 不可用：外部 writer 被拒（错误里会提示改用 `codex_queue`） |
| `codex_queue`（v0.2.0，官方 CLI 通道） | 可用：桌面版消费执行，`waitMs` 可观察完成并返回最终消息 |

### codex_queue 能力（v0.2.0）

- 实现：调用官方 `codex queue --thread <UUID> --message <text>`；线程名/前缀先由 catalog 解析成 UUID（CLI 的 `--thread <name>` 只认 "active session"，实测不可靠）。
- `waitMs > 0`：投递前记录线程 rollout 尾部最后事件时间作为基线，轮询 rollout 直到出现"包含本次消息的 user 行 + 随后的 task_complete"，返回该 turn 的最终消息；超时则明确返回 `status: queued, no completed turn observed ...`。
- 验证方法：FIXTURE（`tests/queue.test.mjs` 8 个测试：argv/名称与前缀解析/失败/超时/等待成功/等待超时/发送 hint）+ LIVE（用新代码经真实 CLI 投递真实 seori 线程）。
- LIVE 结果（2026-10-24T14:49Z）：`codex_queue(thread=seori, waitMs=120000)` → 13s 后 `status: delivered and completed after 13s`，`final message: QUEUE-TOOL-OK`；`codex_send(thread=seori)` → 2s 失败并输出 `use codex_queue` 提示。
- 生效条件：DSH 工具层需要重载该插件 bundle 或重启 DSH 才暴露 `codex_queue`（首次 LIVE 验证是在进程内 harness 中直接调用新代码 + 真实 CLI 完成的）；2026-10-24 23:12 重启后工具层已加载 v0.2.0，并完成真实工具调用（见下节）。

## 桌面版自动更新与工具层对接复验（2026-10-24 23:0x–23:17Z）

**背景**：23:09–23:12 Codex 桌面版自动更新，CLI 从 0.163.0-alpha.11.2 升到 0.164.0-alpha.11.1，并删除了旧 bin 目录 `...\Codex\bin\37f54d68e5533a51\`（新目录 `...\bin\2993767bd1dfb009\`）。插件在加载时缓存了这个旧路径。

**现象（缺陷 D5，v0.2.1 修复）**：所有派发工具在 spawn 时失败 `spawn ...codex.exe ENOENT`；`codex_threads` 头部仍显示已不存在的旧路径。只读工具不受影响。

**临时处置**：为让本次会话继续，在旧路径创建指向新 exe 的 hardlink 兼容 shim；重载 v0.2.1 后该 shim 不再需要，可删除。

**修复（v0.2.1）**：
- `index.js` 改为 `resolveExecutable()`：每次派发前校验缓存路径是否存在，失效则重新探测（config → CODEX_BIN → 桌面版标准位置 → PATH …），`codex_threads` 头部显示实时解析结果；
- `lib/runner.mjs` 的 spawn 统一走 `spawnResolved`，遇到 `ENOENT` 时重新探测并重试一次；
- 回归测试：queue Q9「a cached executable path that disappears is re-resolved before dispatch」。
- 修复 live 验证（新代码 + 真实 home）：缓存旧路径 → 把文件移走 → `codex_threads` 头部自动切换为 `...\bin\2993767bd1dfb009\codex.exe`。

**CLI 0.164 回归**：
- 新线程派发 18s 完成 `CLI164-OK`，`codex_run` `usage: 17.5k`（协议与解析未受升级影响）；
- `codex_send` 对 seori 仍被 writer 锁拒绝（2s），仍输出 `use codex_queue` 提示。

**工具层 relay 复验（v0.2.0 已在 DSH 工具层加载）**：
- `codex_queue({ thread: 'seori', waitMs: 180000 })` → 68s 返回 `status: delivered and completed after 1m`；
- seori 回复：`RELAY-QUEUE-TOOL-OK` / `sia=active fei=blocked danny=active kiri=active` / `NONE`；随后 seori 的正常 heartbeat 按时开始；
- 说明：消息投递、桌面版执行、DSH 侧等待与回读在真实工具层闭环成立。

**顺带观察（minor）**：Codex 写入 `thread_settings_applied` 等非对话事件也会刷新 writer-lock mtime，`codex_liveness` 会短暂误报 `working (writer lock fresh)`；不影响读取与 queue 派发。

## 未验证 / 方法边界

- macOS / Linux 实机行为（代码只按平台标准位置探测，Windows 之外未实测）。
- ~~真实 Codex 桌面 app 与本插件同时写同一线程时的拒绝形态~~ 已实测：桌面版持有 writer 锁时 `codex_send` 被 Codex 以 `thread-store conflict: ... already has an active writer` 拒绝（见上一节）。
- 真实 `nudge` 在真实 stalled 线程上的端到端效果（仅验证门禁与夹具路径；默认关闭）。
- 超过 `maxOutputBytes` 的 spill/lossy 在真实 CLI 下的行为（夹具已覆盖逻辑）。
- `config.liveness.threads` 按 ID 生效的 LIVE 触发（当前 profile 未配置该项；离线测试已覆盖）。
- `node:sqlite` 不可用运行时的实际降级表现（仅代码审阅）。

## 复现

```sh
npm test        # 单元 + 只读面 + 派发面 + 队列通道：78 个离线测试，不消耗模型 turn
npm run smoke   # 只读冒烟（需要本机 Codex home）
```

LIVE 项需要装有 Codex 并登录的机器，在 DSH 会话里直接调用七个 `codex_*` 工具复验；分面方法与证据见 [read-plane](verification/read-plane.md) 与 [dispatch-plane](verification/dispatch-plane.md)。
