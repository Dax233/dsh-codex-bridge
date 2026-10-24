# dsh-codex-bridge

DeepSeek Harness 的 Codex 桥。让 DSH 里的 Agent 可以：

- **看**：列出本机 Codex 线程（名字 / goal 状态 / 最近写入 / 转录大小）
- **读**：读某个线程的最近对话（有界尾部，不加载几百 MB 的 rollout）
- **派**：把消息/任务清单投递进某个 Codex 线程，或开一个新线程，作为无头 turn 执行
- **查**：查看派发 turn 的状态与最终消息
- **盯**：读官方 goal（active/blocked/paused）、automation，做活性快照，必要时补一条"继续"消息

前提：本机装有 Codex（桌面版自带 CLI 或 `npm i -g @openai/codex`），并已登录（`CODEX_HOME` 下的 `auth.json`）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `codex_threads` | 线程清单：`query` / `limit` / `activeWithinMinutes` |
| `codex_read` | 读线程最近条目：`thread` / `limit` / `kinds` / `maxChars` / `tailBytes` |
| `codex_send` | 投递消息：`message` / `thread`（省略=新线程）/ `waitMs` / `cwd` / `model` / `approvalPolicy` / `sandboxMode` |
| `codex_run` | 查看派发结果：无 `runId` 列表；有则详情 |
| `codex_goals` | 官方 goal 行：`thread` / `status` / `limit` |
| `codex_liveness` | 活性快照：`threads` / `idleMs` / `nudge` |

`codex_send` 默认立刻返回 `runId`，用 `codex_run` 轮询；长任务不会阻塞对话。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `codex-bridge` 行的 `config`（config 是整块替换，写全需要的字段）：

```yaml
- id: codex-bridge
  name: '@local/dsh-codex-bridge'
  config:
    codexHome: 'I:\SeoriData\.codex'
    executable: ''            # 空 = 自动探测（CODEX_BIN / %LOCALAPPDATA%\OpenAI\Codex\bin\* / PATH）
    defaultCwd: 'F:\github\memory_research'
    approvalPolicy: never     # 无头执行没有人工审批通道
    sandboxMode: ''           # 空 = 继承 Codex 原生 config.toml
    defaultWaitMs: 0
    allowNudge: false         # true 才允许 codex_liveness({nudge:true}) 真发消息
    liveness:
      idleMs: 1800000
      threads: ['seori', 'sia', 'fei', 'danny', 'kiri']
    env: {}
```

## 行为与边界

- **只读 Codex home**：转录、goal 数据库（`goals_1.sqlite`，只读打开）、写者锁、automation 文件都只读；本插件不写 `CODEX_HOME`。
- **驱动走 Harness subprocess seam**：每次 `codex exec` / `codex exec resume` 一个进程，stdout/stderr 收集而非管道，凭据类环境变量不继承（子进程只拿到 PATH/系统目录/`CODEX_HOME` 等白名单 + `config.env` 显式项）。
- **无头审批**：`codex exec` 没有人工审批通道，默认 `approval_policy=never`；sandbox 默认继承 Codex 原生配置，可从参数覆盖。
- **单写者**：同一线程已有本插件的进行中 turn 时，`codex_send` 会拒绝再开第二个写者；桌面 app 正在写的线程也可能拒绝外部 resume，错误会原样报告。
- **goal 恢复不代做**：`codex_liveness` 不会恢复 blocked goal，也不会对 paused goal 发 nudge；恢复仍需有授权的路径。

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
