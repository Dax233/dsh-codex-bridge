# codex-bridge 只读数据面验证（A1–A8）

- 日期：2026-10-24
- 对象：`@local/dsh-codex-bridge`（`dsh-codex-bridge` 仓库，commit `27aac52`）
- 方法：LIVE（在已安装该插件的 DSH desktop profile 中真实调用 `codex_threads` / `codex_read` / `codex_goals` / `codex_liveness`）+ FIX（临时 `${CODEX_HOME}` 夹具 + `index.js apply()` 的 mock cordis context，不 spawn 真实 codex）+ CODE（源码静态审计）
- 离线测试：`tests/readonly.test.mjs`，`node --test tests/readonly.test.mjs` → 25/25 通过
- 安全边界：验证期间只调用只读工具；未向任何真实线程发送消息（`codex_send` 只在 mock subprocess 中走过路径）；未发真实 nudge；未修改 `${CODEX_HOME}`；未重启 DSH；未修改插件运行时源码
- **修复状态**：验证时点代码为 `27aac52`，其中 A2（缺陷 D1）与 A5（缺陷 D2）判 FAIL；两项已在提交 `4fdc340` 修复并加回归测试（见文末「修复记录」）。下文的 FAIL 描述保留验证时点证据。

> 脱敏说明：本文用 `${CODEX_HOME}`、`<thread>`、`<name>`、`<id>` 等占位符代替本机路径与真实线程标识；测试夹具位于临时目录。

## 判定总览

| ID | 能力 | 结论 |
|---|---|---|
| A1 | home / 可执行文件解析与缺失降级 | **PASS** |
| A2 | `codex_threads` 列表与过滤 | **FAIL**（仅"最近写入"字段，缺陷 D1；其余通过） |
| A3 | `codex_read` 解析与有界尾读 | **PASS-WITH-LIMITS**（限制 L1 前缀歧义、L4 续写分段） |
| A4 | `codex_goals` 官方 goal 读取 | **PASS** |
| A5 | `codex_liveness` 活性判定 | **FAIL**（缺陷 D2：配置线程按 ID 不生效；另受 D1 年龄显示影响；verdict/clamp/nudge 门禁通过） |
| A6 | 只读保证 | **PASS** |
| A7 | 并发读取 | **PASS**（写入为间歇 burst，非四线程持续同时写） |
| A8 | 与原始来源交叉核对 | **PASS**（抽样 7 线程 + 全量 128 goal 行/50 线程行） |

## 1. A1 — home / 可执行文件解析与缺失降级（PASS）

**解析顺序（CODE，`lib/codex-home.mjs`）**

- home：`config.codexHome` → `CODEX_HOME` → `~/.codex`；空串跳过；候选不存在则继续；全落空返回 `undefined`。
- 可执行文件：`config.executable` → `CODEX_BIN` → 桌面版 CLI 的平台标准位置（按版本 mtime 新→旧）→ `PATH` → 用户级常见目录（`.local/bin`、npm-global、Homebrew、`/usr/local/bin`、`/usr/bin`）→ `<home>/.sandbox-bin`、`<home>/bin`。
- 缺失降级：只读工具只检查 home，缺失时报 `Codex home not found: set config.codexHome or CODEX_HOME ...`；只有 `codex_send` 检查可执行文件，缺失时报 `codex executable not found: set config.executable or CODEX_BIN`。

**LIVE**

- `codex_threads({})` 头部正确显示解析后的 home 与可执行文件路径；可执行文件命中桌面版自带 CLI（当该目录存在时优先于其他探测位置）。
- 宿主环境的 `CODEX_HOME` 指向真实 home；profile 配置层没有 `codexHome` 覆盖（默认空串）。
- 注意：验证机上 `~/.codex` 是指向同一真实 home 的符号链接，因此 LIVE 结果**不能**单独区分 "CODEX_HOME" 与 "~/.codex" 两条候选路径；优先级由 FIX 证明。

**FIX（子进程探针，隔离 env）**

- home：config 存在 → config；仅 `CODEX_HOME` 存在 → env；仅用户 home 下 `.codex` 存在 → 该目录；三者皆无 → `undefined`。
- 可执行文件：`configured` → `CODEX_BIN` → 桌面版位置 → `PATH` → `~/.local/bin` → `<home>/.sandbox-bin`，逐级命中；全部缺失 → `undefined`。
- 缺 home：四个只读工具均报明确错误；缺可执行文件：只读工具全部正常，仅 `codex_send` 报错。

## 2. A2 — `codex_threads` 列表与过滤（FAIL，缺陷 D1）

**通过的部分（LIVE + FIX）**

- 列表字段：名称 / id / goal 状态 / 最近写入 age / 转录大小 / automation / running 标记；按最近活动降序。
- `query`：名称与 id 子串、大小写不敏感。
- `limit`：clamp 到 1–50（`0`/`负数→1`、`100→50`、非整数回退默认 15）。
- `activeWithinMinutes`：真实数据上把工具结果与独立扫描（rollout mtime / writer-lock mtime / goal 更新时间取最大，阈值 now−N 分钟）比对，集合完全一致。
- 无匹配：`no Codex threads matched (home: ...)`。
- running 标记与 `codex_liveness` 的 `working (bridge turn <run-id>)`：FIX 中经 mock 运行验证（真实只读面没有本插件运行中的 turn）。
- goals 不可用：header 显示 `goals unavailable (reason)`。
- 大小：有 rollout 的线程显示 `<MB>`；无本地 rollout 显示 `—`。

**缺陷 D1（"最近写入"字段错误）**

- 现象：只存在于 `session_index.jsonl`、没有 rollout / goal / writer-lock 的线程，`last=` 显示约 `20750.6d`（约 57 年前）而不是"未知"或索引中的更新时间。验证机真实 catalog 298 个线程中 151 个属于此类。
- 连带影响：`activeWithinMinutes` 对这类线程永远判定为"很久没活动"；`codex_liveness` 的 idle/stalled 年龄文本同样极端错误。
- 根因：`lib/catalog.mjs` 合并时保留了 `indexUpdatedAt`，但 `lastActivityMs` 只取 `max(rollout.mtimeMs, lockMtimeMs, goal.updatedAtMs)`，未使用索引更新时间；三类来源皆无时 `lastActivityMs=0`。
- 最小复现（FIX 夹具）：构造只含 `session_index.jsonl` 一条记录、无 rollout 的 `${CODEX_HOME}`，然后
  `codex_threads({query:'<archived-thread>'})` → `last=20750.6d`；`codex_liveness({threads:['<archived-thread-id>']})` → `idle 20750.6d`。
- 修复建议（不代改代码）：`lastActivityMs` 增加 `Date.parse(thread.indexUpdatedAt)`（有限值时）作为候选；或在所有来源缺失时显示 `last=—`。
- 结论：按矩阵"最近写入正确"要求，本项判 FAIL；列表/过滤/clamp/排序/running 等其余能力均通过。

## 3. A3 — `codex_read` 解析与有界尾读（PASS-WITH-LIMITS）

**解析**：全 id / id 前缀 / 名称 / `@名称` / 大小写均可解析（LIVE+FIX）；未知线程明确报错并列出可选项；无本地 rollout 的线程报 `has no local rollout file (no transcript recorded)`。

**clamp（LIVE+FIX 一致）**

- `limit`：1–40（默认 12；`0→1`、`100→40`、非整数→12）。
- `maxChars`：100–4000（默认 600；`1→100`、`99999→4000`，裁剪末尾加 `…`）。
- `tailBytes`：65,536–8,388,608（默认 1,500,000；数值过小/过大均被 clamp，header 显示实际窗口）。

**有界尾读**

- LIVE：真实 783–784MB rollout 的多次读取耗时 24–47ms（默认窗口 1.4MB）与 338ms（一次默认窗口重测；均 < 2s），8.0MB 窗口 47ms；header 标注窗口且 `last event` 与独立解析一致。
- FIX：800MB 稀疏 rollout 夹具，`tailBytes` 请求 100MB 被 clamp 到 8MB；通过 `fs.readSync` 计数验证只读 2 次、合计约 8.45MB（64KB session-meta + 8MB 尾窗），耗时约 39ms，不整文件加载。
- `readTailLines`：窗口过大→整读（`truncated=false`）；窗口过小→丢弃首个不完整行、`truncated=true`、读取字节不超过窗口。
- `readSessionMeta`：能解析超过 64KB 的 session_meta 首行（100KB 测试通过）。
- `kinds` 过滤、header 字段（thread/cwd+cliVersion+provider/rollout+age/goal/last event）、`(tail window ...)`/`(whole file read)` 说明均验证。

**限制 L1 — 短 id 前缀歧义静默解析**：真实 catalog 中有多对线程的 UUID 前 8 位相同；`resolveThread` 在多个前缀匹配时取 catalog 顺序中的第一个（即最近活动较新者），不报歧义。用户若只给短前缀，可能读到非预期线程且无提示。

**限制 L4 — 续写分段只读最新段**：同一线程存在多个 rollout 文件（续写/压缩分段）时，catalog 取 mtime 最新的文件作为该线程的 rollout：`codex_threads` 的 size 是最新分段大小而非整线程转录总和，`codex_read` 也只读最新分段。验证机 23 个有 rollout 的线程中 2 个受影响（最新段 35.0MB / 合计 61.0MB；最新段 50.0MB / 合计 55.6MB）。最新段较小（例如刚 resume 的线程）时，`limit` 内可读条目会少于旧段中实际存在的最近对话。

## 4. A4 — `codex_goals` 官方 goal 读取（PASS）

- LIVE：默认 40 行、按更新时间降序；真实数据 128 行 goal（active/blocked/paused 混合，随 Codex turn 变动）。
- `thread` 过滤支持名称与全 id；`status` 精确过滤；无匹配与未知线程均有明确提示。
- `limit` clamp 1–200（`0→1`、`1e6→200`、非整数→40）。
- 每行含名称、id、status、tokens（紧凑单位）、更新时间 age、objective 摘要（折行折叠、截断 110 字符 + `…`）。
- 降级：无 goals 数据库 → `goals unavailable: no goals database found`；坏 schema → `goal query failed on <file>: ...`；只有 `goals_2.sqlite` 时仍能探测读取；空表 → 无匹配提示。
- 只读：`new DatabaseSync(file, { readOnly: true })`（CODE）；LIVE 在 Codex 桌面同时写 WAL 期间多次读取成功。
- 交叉核对：工具输出的 128 行与直接 sqlite 快照逐行比对，**128/128** 一致（见 A8）。

## 5. A5 — `codex_liveness` 活性判定（FAIL，缺陷 D2）

**通过的部分（LIVE + FIX）**

- 默认集合 = goal 关联线程 ∪ automation 关联线程 ∪ `config.liveness.threads`（按名称）。LIVE 默认 129 行 = 128 goal 线程 + 1 automation 线程。
- verdict 覆盖（FIX 确定性构造 + LIVE 观察）：`working (bridge turn ...)`、`working (writer lock fresh)`、`working (goal active)`、`stalled: goal active, no write for ...`、`blocked goal (needs an authorized resume; not nudged)`、`paused goal (not nudged)`、`automation thread (idle ...)`、`idle ...`。
- `idleMs` clamp 到 60s–24h（`1→1m`、`59999→1m`、`1e15/86400001→1.0d`；`0`/省略回退 config 默认 30m）。
- nudge 门禁：`allowNudge=false` 时 `nudge:true` 明确拒绝（`refused: nudge requested but config.allowNudge is false ...`）且不产生任何进程；blocked/paused 永不 nudge（FIX：allowNudge=true 时 stalled 恰好 1 次 resume spawn，blocked/paused 0 次）。
- 显式 `threads` 参数支持名称或 id；未知线程明确报错。

**缺陷 D2 — `liveness.threads` 配置写线程 ID 不生效**

- 文档（README 配置示例）声明该配置项接受"线程名/ID"；工具参数 `threads` 也确实接受两者。
- 实现只匹配名称：`config.liveness.threads.includes(thread.name)`。写入线程 id 时默认集合为空 → `no goal- or automation-backed threads found`。
- 最小复现（FIX 夹具）：同一线程，配置 `liveness.threads:['<name>']` → 出现在默认集合；`liveness.threads:['<thread-id>']` → 不在默认集合。
- 修复建议：谓词同时比较 `thread.name` 与 `thread.id`。
- 另：D1 使仅索引线程的 idle/stalled 年龄文本错误（verdict 分类本身正确）。

## 6. A6 — 只读保证（PASS）

**静态审计（CODE）**：`index.js` 与 `lib/*.mjs` 中无 `writeFile/appendFile/createWriteStream/mkdir/rm/unlink/rename/copyFile/truncate/writeSync/chmod/utimes` 等写调用；`openSync` 仅两处以 `'r'` 打开；无 `node:child_process` 导入（子进程仅经 `ctx.subprocess.spawn` 的 send/nudge 路径）；SQLite 以 `{ readOnly: true }` 打开；无 `process.env.* =` 赋值。

**夹具树哈希（FIX）**：完整跑 `buildCatalog` + `readGoals` + 四个只读工具后，小型 `${CODEX_HOME}` 夹具的文件清单/大小/mtime/sha256 树哈希前后完全一致（相同 digest），mock 记录到 0 次子进程 spawn。

## 7. A7 — 并发读取（PASS）

- 55s 连续并发压测：63 轮 × 7 个并发调用（`codex_threads(limit 50)`、4×`codex_read(tailBytes 64KB)`、`codex_goals(limit 200)`、`codex_liveness()`），共 441 次调用，**0 错误、0 超时**，单调用最慢 611ms。
- 压测窗口内四个在研线程的 rollout 均真实增长（分别 +207,894 / +53,755 / +28,268 / +88,311 字节），期间存在同一窗口内两线程同时写入的情形。
- 并发结果与直接扫描一致：50/50 线程 size 吻合、128/128 goal 行吻合、4 次并发 `codex_read` 全部正常返回。
- 限制：真实写入是间歇 burst，未观察到四个线程 100% 同时写入的稳定窗口；结论覆盖"读写并发时不报错/不阻塞/结果一致"。

## 8. A8 — 与原始来源独立交叉核对（PASS）

独立来源：直接读 `session_index.jsonl`、自写解析器读 rollout 尾部、直接 SQL 查 `goals*.sqlite`、lock 文件 stat、`automation.toml`。

- 抽样 7 个线程（4 个活跃研究线程 + automation 线程 + 稳定历史线程 + 未命名线程）：名称/id/goal 状态/rollout 大小（含增长容差）/last write 量级/goal tokens/objective 摘要/`codex_read` header 的 cwd、cliVersion、provider、last event/`codex_liveness` 的 goal 字段全部一致（28 项比较 + 7 项 objective 全过）。
- 全量：`codex_goals` 128 行与 sqlite 快照 **128/128** 一致；`codex_threads(limit 50)` 的 50 行中，有 rollout 的 23 行 size 全部一致，无 rollout 的 27 行均正确显示 `—`。
- 说明：交叉核对期间目标线程仍在写入，size/last-write 使用调用窗口前后快照 + 增长容差判定。

## 9. 缺陷与限制汇总

| 编号 | 类型 | 影响 | 位置 | 建议 |
|---|---|---|---|---|
| D1 | 缺陷 | 仅索引线程"最近写入"显示约 `20750.6d`；`activeWithinMinutes` 误排除；liveness 年龄文本错误 | `lib/catalog.mjs` `lastActivityMs` 未含 `indexUpdatedAt` | 将索引更新时间纳入 max；或全缺失时显示 `—` |
| D2 | 缺陷（实现/文档不一致） | `config.liveness.threads` 写线程 ID 不生效（名称生效） | `index.js` liveness 默认集合谓词仅比较 `thread.name` | 同时比较 `thread.id` |
| L1 | 限制 | 8 位 id 前缀歧义静默解析为最近活动线程，无提示 | `lib/catalog.mjs#resolveThread` | 前缀命中多个时要求更长前缀或报歧义 |
| L4 | 限制 | 续写分段的线程只读/只统计最新段；旧段不可见 | `scanRollouts`/`readTailLines` | 如需完整转录，可按 `continuations` 合并读取 |

未发现：fs 写调用、CODEX_HOME 被修改、goals 映射错误、verdict 分类错误、nudge 违规开启。

## 10. 未验证 / 边界外

- 真实 nudge 派发与真实 `codex_send` 写入（属派发面 B7；本次只验证 mock 路径与 `allowNudge=false` 拒绝路径）。
- 运行时不提供 `node:sqlite` 时的降级分支（只代码审阅，未构造该运行时）。
- 非 Windows 平台的 LIVE；桌面版 CLI 探测分支仅在 win32 断言（FIX）。
- 冷缓存下的 700MB+ 读取耗时（本次为热读，仍 < 2s）。
- `automation.toml` 单引号值解析（真实数据为双引号，未构造反例）。
- 并发读到正在 append 的 rollout 末尾不完整行时的丢行率（按设计跳过无法解析的行，未统计）。

## 12. 修复记录（提交 `4fdc340`）

| 缺陷 | 修复 | 回归测试 |
|---|---|---|
| D1 仅索引线程 `last` 显示约 20750.6d | `lib/catalog.mjs` 把 `session_index` 的 `updated_at` 纳入 `lastActivityMs` 的最大值 | `A2 index-only threads report the session_index update age, not the epoch` |
| D2 `config.liveness.threads` 按 ID 不生效 | `index.js` 默认集合谓词同时比较线程名与 ID（大小写不敏感） | `A5 configured liveness threads match by id as well as by name` |

修复后在真实 `${CODEX_HOME}` 上做模块级复核：298 个线程中 151 个仅索引线程的 `lastActivityMs` 从 0 变为索引 `updated_at`（例如 22.88d / 16.46d），epoch 行 0 个；旧公式下 151/151 为 epoch。

生效条件：运行中的 DSH Host 需重载该插件 bundle（禁用→启用）或重启后，LIVE 工具才使用修复后的代码；本仓库的离线测试已覆盖修复后的行为。

## 11. 复现

```sh
node --test tests/readonly.test.mjs   # 离线，25/25 通过，不读取真实 ${CODEX_HOME}，不 spawn codex
```

LIVE 复现（需在安装本插件的 DSH profile 中，只调用只读工具）：
`codex_threads({}) / codex_threads({query, limit, activeWithinMinutes})`、
`codex_read({thread, limit, maxChars, tailBytes, kinds})`、
`codex_goals({thread, status, limit})`、
`codex_liveness({threads, idleMs, nudge:false})`。
D1/D2 的最小夹具复现见本地证据文件（`read-plane-evidence.md` 同目录指引）。
