# dsh-codex-memories

Codex 风格的**长期记忆**插件，为 DSH 提供跨会话的持久记忆。

它复刻了 Codex 记忆系统的完整两阶段结构：先把每个会话提取成结构化记忆，再合并成一份可检索的手册，并在每次对话前把精炼摘要注入上下文。

## 它解决什么问题

DSH 的会话是彼此隔离的。上一次你纠正过的偏好、踩过的坑、验证过的命令，下一次不会自动出现，除非你再说一遍。这个插件让 Agent 自己记住：

- 你说过一次的工作方式，下次默认照做
- 某个仓库里哪条命令能跑、哪里是坑
- 某个问题的症状、原因、修法

## 工作原理

```
会话结束（空闲 N 秒）
   └─ Stage 1  每个会话用模型提取 → session_summaries/<slug>.md + raw_memories.md
        └─ Stage 2  累积到阈值后用模型合并 → MEMORY.md + memory_summary.md
             └─ 每次对话前，memory_summary.md 注入模型上下文
```

数据层是纯 Markdown，可以自己打开、编辑器改、git 管版本；`index.json` 记录提取缓存与合并水位。

## 安装

```bash
dsh plugin --profile web add @lushdawn/dsh-codex-memories
```

本地开发：

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

装好后重启 DSH，或让 live profile 热加载。

## 使用

对话里输入命令：

| 命令 | 作用 |
| --- | --- |
| `/memory status` | 看记忆根目录、已提取会话数、待合并数、上次提取/合并时间 |
| `/memory show` | 打印当前的 `memory_summary.md` |
| `/memory extract` | 立即提取当前会话（不等空闲定时器） |
| `/memory backfill` | 扫描历史会话，补齐启动前没提取过的 |
| `/memory consolidate` | 立即把待合并记忆合并进 `MEMORY.md` |
| `/memory forget <sessionId\|all>` | 丢弃某个会话的提取记录（手册内容保留） |
| `/memory on` / `off` | 当前进程内开关自动提取 |

模型侧工具（`dedicatedTools` 开启时）：

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 按关键词在记忆文件里做行级检索，支持 `any` / `all` / `on_same_line` |
| `memory_read` | 按行范围读某个记忆文件 |
| `memory_list` | 列出记忆目录清单与待合并状态 |
| `memory_note` | 写一条 ad-hoc 笔记（模型唯一被允许的写路径） |

模型被要求用 `MEMORY.md:12-14|note=[...]` 的格式标注它用到了哪段记忆。

## 配置

在 profile 的 patch 里覆盖，全部字段都有安全默认值：

```yaml
- insert:
    - id: dsh-codex-memories
      name: dsh-codex-memories
      config:
        storageDir: ''            # 默认 $DSH_HOME/memories
        generate: true            # 是否自动提取
        use: true                 # 是否注入 summary
        dedicatedTools: true      # 是否暴露 memory_note
        model: ''                 # 通用路由，如 deepseek-official/deepseek-flash
        extractModel: ''          # Stage 1 路由，留空回退 model
        consolidationModel: ''    # Stage 2 路由，留空回退 model
        idleSeconds: 120          # 会话空闲多久后提取
        maxSessionsPerRun: 3      # 单轮最多提取几个会话
        maxSessionAgeDays: 30     # 超过这个天数的会话不再提取
        consolidationThreshold: 2 # 攒够几个新记忆就合并
        maxInjectChars: 9000      # 注入上下文的 summary 字符上限
        minSessionMessages: 4     # 少于这么多条消息的会话跳过
        extractMaxTokens: 8000
        consolidateMaxTokens: 16000
```

`model` 留空时，插件读取当前默认模型；再取不到就退回 `deepseek-official/deepseek-flash`。

## 数据布局

```
$DSH_HOME/memories/
├── MEMORY.md                    # 持久手册：按 Task Group 组织的检索层
├── memory_summary.md            # 注入上下文的精炼层，首行必须是 v1
├── raw_memories.md              # Stage 1 的机械合并，按会话 id 升序
├── session_summaries/<slug>.md  # 每个会话一份结构化摘要
├── extensions/ad_hoc/notes/     # 你或模型写的补充笔记
└── index.json                   # 提取缓存、作业记录、合并水位
```

这些文件都是你的。可以随时 `cat`、编辑、进 git、或者整个目录备份迁移。

## 成本与隐私

- **会花 token**：Stage 1 每个会话一次模型调用，Stage 2 每次合并一次。默认只提取消息数 ≥ 4 的会话，每次最多 3 个，攒够 2 个才合并。
- **只在本地写文件**：插件不联网，除了它调用的模型 API。
- **会写进模型上下文**：`memory_summary.md` 每次对话都会被注入，所以它被刻意限制在 `maxInjectChars` 以内。
- **可审计**：所有产出都是可读的 Markdown，你能看到 Agent 到底记住了什么。
- **模型不会被允许直接改手册**：它只能写 ad-hoc 笔记，合并由 Stage 2 统一完成，避免记忆被单轮对话污染。

## 与 Codex 记忆系统的对应关系

本插件的行为规格来自对 Codex 本体的逆向分析（`~/.codex/memories` 的数据形态 + `codex.exe` 内的提示词模板）。对应表：

| Codex | dsh-codex-memories |
| --- | --- |
| `~/.codex/memories/` | `$DSH_HOME/memories/` |
| `MEMORY.md` / `memory_summary.md` / `raw_memories.md` | 同名同格式 |
| `rollout_summaries/*.md` | `session_summaries/*.md` |
| `memories_1.sqlite`（stage1_outputs / jobs / consolidation_progress） | `index.json` |
| Stage 1：`Analyze this rollout and produce JSON ...` | `lib/prompts.js` 的 `PHASE1_TEMPLATE` |
| Phase 2：`Memory Writing Agent: Phase 2 (Consolidation)` | `lib/prompts.js` 的 `PHASE2_TEMPLATE` |
| 使用侧：决策边界 + 5 步快速检索 + 引用格式 | `lib/prompts.js` 的 `USAGE_TEMPLATE` |
| `extensions/ad_hoc/instructions.md` | 同名同内容 |
| rollout 扫描补齐 | `/memory backfill` + 启动时自动扫描 |
| `max_rollouts_per_startup` 等 12 项配置 | 见上表（命名已适配 DSH） |

详细机制与逆向证据见 [docs/mechanism.md](docs/mechanism.md)。

## 已知边界

- Stage 2 让模型一次产出两份完整文档。手册很大时，单次合并可能触及输出上限；此时会保留旧文件并报错，不会写坏。
- 自动提取依赖进程存活：会话空闲窗口内进程退出，则这次提取由下次启动的 `backfill` 补齐。
- 不做语义检索，只有关键词/行级检索（与 Codex 一致）。记忆规模很大时，请靠 `MEMORY.md` 的 `keywords` 路由。

## 参与

欢迎提 issue 和 PR，先看 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。版本变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
