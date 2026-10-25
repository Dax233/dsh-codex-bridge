# dsh-codex-bridge

DeepSeek Harness 的 Codex 桥。让 DSH 里的 Agent 可以：

- **看**：列出本机 Codex 线程（名字 / goal 状态 / 最近写入 / 转录大小）
- **读**：读某个线程的最近对话（有界尾部，不加载几百 MB 的 rollout）
- **派**：把消息/任务清单投递进某个 Codex 线程，或开一个新线程，作为无头 turn 执行
- **排队**：当线程已被其他写者占用（例如 Codex 桌面版持有 writer），用官方 `codex queue` 通道投递，并可选等该 turn 完成返回最终消息
- **查**：查看派发 turn 的状态与最终消息
- **盯**：读官方 goal（active/blocked/paused）、automation，做活性快照，必要时补一条"继续"消息

前提：本机装有 Codex（桌面版自带 CLI 或 `npm i -g @openai/codex`），并已登录（`CODEX_HOME` 下的 `auth.json`）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `codex_threads` | 线程清单：`query` / `limit` / `activeWithinMinutes` |
| `codex_read` | 读线程最近条目：`thread` / `limit` / `kinds` / `maxChars` / `tailBytes` |
| `codex_send` | 投递消息：`message` / `thread`（省略=新线程）/ `waitMs` / `cwd` / `model` / `approvalPolicy` / `sandboxMode` |
| `codex_queue` | 投递到被其他写者占用的线程（官方 queue 通道）：`thread` / `message` / `waitMs` |
| `codex_run` | 查看派发结果：无 `runId` 列表；有则详情 |
| `codex_goals` | 官方 goal 行：`thread` / `status` / `limit` |
| `codex_liveness` | 活性快照：`threads` / `idleMs` / `nudge` |

`codex_send` 默认立刻返回 `runId`，用 `codex_run` 轮询；长任务不会阻塞对话。

`codex_queue` 用于 `codex_send` 因 `active writer` 被拒绝的线程（通常是 Codex 桌面版持有的线程）：消息由持有写者投递并执行，`waitMs` 会在本地 rollout 里观察该 turn，完成时返回最终消息。

## 配置

插件**不内置任何本机路径**：Codex home 依次取 `config.codexHome` → `CODEX_HOME` → `~/.codex`；可执行文件依次取 `config.executable` → `CODEX_BIN` → 桌面版自带 CLI 的标准安装位置 → `PATH` → 常见包管理器目录（npm-global、Homebrew、`/usr/local/bin`）。

工作目录同理：`codex_send` 的 `cwd` 省略时，新线程用 `config.defaultCwd`，再退化为调用它的 DSH 会话工作区；resume 优先用线程自己的 cwd。

所有配置都可省略，按需在 profile 的 `cordis.patch.yml` 里覆盖 `codex-bridge` 行（config 是整块替换，写全需要的字段）：

```yaml
- id: codex-bridge
  name: '@local/dsh-codex-bridge'
  config:
    codexHome: ''             # 空 = CODEX_HOME 或 ~/.codex
    executable: ''            # 空 = 自动探测
    defaultCwd: ''            # 空 = 调用会话的工作区
    approvalPolicy: never     # 无头执行没有人工审批通道
    sandboxMode: ''           # 空 = 继承 Codex 原生 config.toml
    defaultWaitMs: 0
    queueTimeoutMs: 30000    # codex queue 命令自身的超时
    queuePollMs: 1200        # 等待投递结果时的 rollout 轮询间隔
    disposeGraceMs: 5000
    allowNudge: false         # true 才允许 codex_liveness({nudge:true}) 真发消息
    liveness:
      idleMs: 1800000         # 多久没写入算停滞
      lockFreshMs: 120000     # 写者锁多久内算"正在工作"
      threads: []             # 需要监测的线程名/ID；空 = 所有 goal / automation 关联线程
    env: {}
```

### 可移植性

- 插件代码里没有写死的家目录、盘符或工作区路径；所有位置都来自 env、`PATH` 或平台标准安装目录。
- 子进程环境按白名单透传（`PATH`、`HOME`/`USERPROFILE`、`TEMP`/`TMPDIR`、`XDG_*`、系统目录等 + `CODEX_HOME`），不继承凭据类变量。
- Windows/macOS/Linux 的差异只体现在"桌面版自带 CLI 的探测位置"这一处，命令行参数与协议一致。当前只在 Windows 实测过；其他平台走 `PATH` 找到的 CLI 即可。

## 行为与边界

- **只读 Codex home**：转录、goal 数据库（按 `goals*.sqlite` 探测，只读打开）、写者锁、automation 文件都只读；本插件不写 `CODEX_HOME`。
- **驱动走 Harness subprocess seam**：每次 `codex exec` / `codex exec resume` 一个进程，stdout/stderr 收集而非管道，凭据类环境变量不继承（子进程只拿到 PATH/系统目录/`CODEX_HOME` 等白名单 + `config.env` 显式项）。
- **无头审批**：`codex exec` 没有人工审批通道，默认 `approval_policy=never`；sandbox 默认继承 Codex 原生配置，可从参数覆盖。
- **单写者**：同一线程已有本插件的进行中 turn 时，`codex_send` 会拒绝再开第二个写者；桌面 app 正在写的线程也会拒绝外部 resume（Codex 报 `already has an active writer`），此时用 `codex_queue` 走官方队列通道。
- **queue 通道**：`codex_queue` 通过官方 CLI 写 Codex 自己的队列（插件不直接写 `CODEX_HOME` 文件）；投递与执行由持有写者的进程完成，失败会原样报错。
- **goal 恢复不代做**：`codex_liveness` 不会恢复 blocked goal，也不会对 paused goal 发 nudge；恢复仍需有授权的路径。
- **prompt 原样传入**：`codex_send` 只用 `trim()` 判断是否为空，首尾空白与内部换行都会原样到达 Codex。
- **无取消、无流式**：运行中的 turn 不能通过工具取消（Host 关闭时会被终止），`codex_send` 只返回最终消息；长任务用 `waitMs: 0` + `codex_run` 轮询。
- **`codex_read` 默认含 developer 条目**：默认 kinds 包含 `developer`（Codex 注入的较长指令），只看对话时传 `kinds: ['user', 'assistant', 'turn-end']`。
- **liveness 默认扫描范围**：不带 `threads` 时扫描所有 goal/automation 线程，历史线程多时输出很长；用 `config.liveness.threads`（线程名或 ID 均可）收窄。
- **goal 读取依赖 `node:sqlite`**：运行时缺少该模块时 goal 相关能力优雅降级（显示 goals unavailable），其余工具不受影响。
- **可执行文件跟随桌面版更新**：每次派发前校验缓存的 `codex` 路径；Codex 桌面版自动更新换 bin 目录后会自动重新探测（无需重启插件），`codex_threads` 头部显示当前解析结果。

## 验证

```sh
npm test        # 单元 + 只读面 + 派发面 + 队列通道：78 个离线测试，不消耗模型 turn
npm run smoke   # 只读冒烟（需要本机 Codex home）
```

能力矩阵、验证方法、原始结论与已知限制见 [docs/verification.md](docs/verification.md)；分面细节见 [read-plane](docs/verification/read-plane.md) 与 [dispatch-plane](docs/verification/dispatch-plane.md)。验证环境为 Windows + DSH 0.2.1-rc.3 + Codex 桌面版 CLI；真实派发验证只新建测试线程。

## 监控与自动介入（watch）

插件本身**没有后台定时器，也不会唤醒 DSH 会话**；`codex_liveness({ nudge: true })` 只是向 Codex 线程补发一条续跑消息（默认关闭），方向相反。要让 relay "只在异常时介入"，用两层：

1. **唤醒层**：DSH 的 `schedule_create` 定时把一条 prompt 投递回本会话（Host 级 durable reminder；也可用 Windows 计划任务，但那样只能发通知、不能唤醒 DSH）。
2. **规则层**：`node scripts/watch.mjs --json` 读取 `${CODEX_HOME}`（rollout heartbeat / goals / automation / liveness），只输出告警：
   - 运行异常：`heartbeat_missing`、`heartbeat_stale`、`thread_idle`、`automation_inactive`
   - 回执/阶段异常：`template_missing`、`generic_receipt`、`stage_no_evidence`、`stage_stalled`
   - 目标漂移：`goal_drift`、`goal_missing`（需人工确认是否授权）
   退出码 0 = 无告警，10 = 有告警，2 = 检查本身失败；`--json` 供定时任务解析。

配置：脚本**不内置部署专属默认值**。必须提供 `thread`（`--thread <name>` 或 `watch.config.json`），否则退出码 2 并给出提示；模板键、泛化措辞、期望 goal 默认关闭，按需在配置里开启（字段示例见 `watch.config.example.json`）。阈值默认 heartbeat 90 分钟、线程 2 小时、连续 3 次未推进；`tailBytes`（默认 4 MiB）控制 rollout 尾部读取量。

唤醒层示例（在 relay 会话里创建，约每 30 分钟一轮）：

```text
schedule_create prompt = "运行 node <本仓库>/scripts/watch.mjs --json。
退出码 0 就静默结束；退出码 10 时用一句话汇报告警 code 与 thread，其它不要做。"
```

`schedule_create` 到点把 prompt 投递回本会话，模型据此执行脚本；脚本本身仍不持有定时器、不联网、不写 Codex home。

## 安装

```sh
# 本仓库目录安装为当前 profile 的 bundle
```
在 DSH 中用插件管理器安装本目录（绝对路径），或在 profile 的 `package.json` 里 `link:` 后加入 `dsh.profile.bundles`。

## 开发

```sh
node --check index.js
node --check lib/catalog.mjs
```

## License

MIT
