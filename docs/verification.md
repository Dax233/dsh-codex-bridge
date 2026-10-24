# 能力验证

本文件记录 `dsh-codex-bridge` 的能力验证：对每个工具、参数边界、失败路径与安全承诺逐项给出验证方法、结果和证据。

- 验证对象：commit `27aac52`（验证时点），修复提交 `4fdc340`；
- 验证环境：Windows + DSH 0.2.1-rc.3 + Codex 桌面版自带 CLI 0.163.0-alpha.11.2（`${CODEX_HOME}` 已脱敏）；
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
| 离线套件 | `npm test` | **68/68 pass**（unit 8 + readonly 27 + dispatch 33） |

## C. 集成与运行验证

### C1 工具注册 — PASS

从真实 `index.js` 的 `apply()` 捕获六个 `tools.register` 定义，参数与源码一致、无缺失：

| 工具 | 参数 | 必填 |
|---|---|---|
| `codex_threads` | `query`, `limit`, `activeWithinMinutes` | — |
| `codex_read` | `thread`, `limit`, `kinds`, `maxChars`, `tailBytes` | `thread` |
| `codex_send` | `message`, `thread`, `waitMs`, `cwd`, `model`, `approvalPolicy`, `sandboxMode` | `message` |
| `codex_run` | `runId`, `limit` | — |
| `codex_goals` | `thread`, `status`, `limit` | — |
| `codex_liveness` | `threads`, `idleMs`, `nudge` | — |

六个工具均为 `{ text }` 输出 schema；全新会话可直接调用（本次验证即在全新会话中完成）。

### C2 运行注册表是 Host 级共享 — PASS

新会话的 `codex_run` 能看到上一个 DSH 会话创建的 run（同一 Host 进程的插件实例），按开始时间倒序。含义：**run 记录跨 agent 会话可见，但 DSH 重启后清空**（内存态）。

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

> 生效条件：运行中的 DSH Host 需重载插件 bundle（禁用→启用）或重启，LIVE 工具才使用修复后的代码；本仓库 `npm test` 已覆盖修复后行为。

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

## 未验证 / 方法边界

- macOS / Linux 实机行为（代码只按平台标准位置探测，Windows 之外未实测）。
- 真实 Codex 桌面 app 与本插件同时写同一线程时的拒绝形态（只验证了插件侧单写者保护）。
- 真实 `nudge` 在真实 stalled 线程上的端到端效果（仅验证门禁与夹具路径；默认关闭）。
- 超过 `maxOutputBytes` 的 spill/lossy 在真实 CLI 下的行为（夹具已覆盖逻辑）。
- DSH 重启后运行注册表清空（按内存实现推断，未实测重启）。
- `node:sqlite` 不可用运行时的实际降级表现（仅代码审阅）。

## 复现

```sh
npm test        # 单元 + 只读面 + 派发面：68 个离线测试，不消耗模型 turn
npm run smoke   # 只读冒烟（需要本机 Codex home）
```

LIVE 项需要装有 Codex 并登录的机器，在 DSH 会话里直接调用六个 `codex_*` 工具复验；分面方法与证据见 [read-plane](verification/read-plane.md) 与 [dispatch-plane](verification/dispatch-plane.md)。
