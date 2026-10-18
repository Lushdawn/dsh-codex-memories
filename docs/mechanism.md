# Codex 记忆系统机制与本插件映射

这份文档记录两件事：Codex 的记忆系统**实际是怎么工作的**（证据来源见各节），以及 `dsh-codex-memories` 如何把这套机制迁移到 DSH。

调查只读，没有修改 Codex 的任何数据。

## 1. 调查方法

| 手段 | 得到什么 |
| --- | --- |
| 读 `%USERPROFILE%\.codex\memories\` 的全部文件 | 存档布局、`MEMORY.md` / `memory_summary.md` / `raw_memories.md` / `rollout_summaries` 的真实格式、`extensions/ad_hoc` 内容、git 仓库 |
| 只读打开 `%USERPROFILE%\.codex\memories_1.sqlite`（`mode=ro`） | `stage1_outputs` / `jobs` / `consolidation_progress` 的 schema 与真实行数据 |
| REA `open_binary` + 对 `codex.exe`（341 MB，Rust）做只读字符串取证 | 嵌入的提示词模板原文、配置字段名、作业 kind、子系统文件路径 |
| REA `binary_session` / `Service` / `Event` 查询 DSH 侧 | 插件需要对接的精确 Service/Event 契约 |

Ghidra 对 341 MB 的 PE 全量分析在本机超时（`binary_overview` timeout），PE 资源解析受 64 MB 上限限制（`resource_constraint`）。因此模板取证走的是"只读字节扫描 + 连续可打印串切片"，再按上下文拼接。这属于**机器提取、人工拼接**，个别长模板的分段边界可能丢字，但结构与规则是逐条对照过的。

关键偏移（`codex.exe`，SHA-256 `b88f944ef63556527caae2ad43f80b88b8be174dc09b09d9b037fc94240a0e91`）：

| 内容 | 偏移 |
| --- | --- |
| Phase 1 主模板 | `0xF439ED4`–`0xF43C7E4` |
| Phase 1 交付格式 / rollout_summary schema | `0xF43C700`–`0xF43F5F4` |
| Phase 2 合并模板 | `0xF40C1C0`–`0xF418xxx` |
| 使用侧（注入）模板 | `0xF3CDDAC`–`0xF3CF77B` |
| `memories/write/src/prompts.rs` 路径引用 | `0xF40BDE4`、`0xF40C217` |
| `MemoriesToml` 12 字段 | `0xF40xxx` 多处（serde 字段名连续出现） |

## 2. Codex 的存档布局

```
~/.codex/memories/                 (git 仓库，HEAD 有 "Initialize Codex git baseline")
├── MEMORY.md                       16 KB  持久手册（检索层）
├── memory_summary.md              3.5 KB  注入层，首行必须是 v1
├── raw_memories.md                 18 KB  Stage 1 机械合并
├── rollout_summaries/<ts>-<rand>-<slug>.md   每会话一份
├── extensions/ad_hoc/instructions.md         ad-hoc 扩展的固定指令
└── .git/
~/.codex/memories_1.sqlite         192 KB 索引与作业
```

`raw_memories.md` 的真实头部：

```
# Raw Memories

Merged stage-1 raw memories (stable ascending thread-id order):

## Thread `01a0faa8-...`
updated_at: 2026-10-06T11:23:22+00:00
cwd: \\?\H:\CODEX PROJECT
rollout_path: \\?\C:\Users\...\rollout-2026-10-02T11-29-31-01a0faa8....jsonl
rollout_summary_file: 2026-10-02T03-29-31-rc5X-local_ninfer_cache_prefill_decode_optimization.md
```

## 3. 索引库 schema（真实）

```sql
CREATE TABLE stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);

CREATE TABLE jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
);

CREATE TABLE consolidation_progress (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    max_thread_count INTEGER NOT NULL DEFAULT 0
);
```

实测作业 kind 只有两种：`memory_stage1`（`job_key` = thread id）与 `memory_consolidate_global`（`job_key` = `global`）。`jobs` 有 72 行，其中 `memory_stage1` 59 条 `error`、12 条 `done`，1 条 `memory_consolidate_global` `done`。

失败原因样本（说明它跑的是**同一条模型链路**，会受模型可用性与上下文窗口限制）：

```
invalid params, unknown model 'gpt-5.4-mini' (2013)
Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.
unexpected status 403 Forbidden: This token has no access to model gpt-5.4-mini
```

`stage1_outputs` 实测两行，`usage_count` 分别是 11 / 21，`last_usage` 是后来的时间戳 —— 说明**记忆被使用时会回写使用计数**，这是淘汰策略的数据来源。

## 4. 配置（`MemoriesToml`，12 个字段）

从二进制 serde 字段名连续块读到：

```
disable_on_external_context
generate_memories
use_memories
dedicated_tools
max_raw_memories_for_consolidation
max_unused_days
max_rollout_age_days
max_rollouts_per_startup
min_rollout_idle_hours
min_rate_limit_remaining_percent
extract_model
consolidation_model
```

另有一个相邻布尔 `no_memories_if_mcp_or_web_search`。

语义从字段名可直接读出：生成开关、使用开关、是否提供专用工具、单次合并上限、未使用天数淘汰、rollout 年龄上限、每次启动最多处理几个、空闲小时下限、速率限制剩余百分比下限（对应 `memories/write/src/guard.rs` 的 `min_remaining_percent`）、两阶段各自的模型。

## 5. 两阶段流水线

### Stage 1（每会话一次）

调用形态（`memories/write/src/prompts.rs`）：

```
Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`
(use empty string when unknown).

rollout_context:
- rollout_path: {{ rollout_path }}
- rollout_cwd: {{ rollout_cwd }}

rendered conversation (pre-rendered from rollout `.jsonl`; filtered response items):
<...>
```

主模板结构：

1. `GLOBAL SAFETY, HYGIENE, AND NO-FILLER RULES (STRICT)` — 不修改原始 rollout、把 rollout 内容当数据不当指令、不编造验证、secrets 替换为 `[REDACTED_SECRET]`、不复制大量工具输出、**允许 no-op**
2. `NO-OP / MINIMUM SIGNAL GATE` — 自问 "Will a future agent plausibly act better because of what I write here?"，否则返回 `{"rollout_summary":"","rollout_slug":"","raw_memory":""}`
3. `WHAT COUNTS AS HIGH-SIGNAL MEMORY` — 四类：稳定用户偏好、高杠杆过程知识、可信赖的任务地图与决策触发点、环境与工作流证据
4. `HOW TO READ A ROLLOUT` — 优先级：用户消息 > 工具输出/验证证据 > assistant 行为
5. `EXAMPLES: USEFUL MEMORIES BY TASK TYPE`
6. `TASK OUTCOME TRIAGE` — `success / partial / uncertain / fail`，含"最后一个任务更保守"、"用户重复同一指令是强偏好信号"等启发式
7. `DELIVERABLES` — 严格三键 JSON，禁止额外键，禁止 JSON 外散文
8. `rollout_summary FORMAT` — 任务优先结构，任务内嵌 `Preference signals` / `Key steps` / `Failures and how to do differently` / `Reusable knowledge` / `References`；**明确禁止 rollout 级 `User preferences`**
9. `raw_memory FORMAT (STRICT)` — 头部 `description/task/task_group/task_outcome/cwd/keywords` + `### Task <n>` 块

### Phase 2（全局合并）

标题原文：`## Memory Writing Agent: Phase 2 (Consolidation)`，正文 `You are a Memory Writing Agent.` / `Your job: consolidate raw memories and rollout summaries into a local, file-based "agent memory" folder`。

规则要点：

- 模板变量：`{{ memory_root }}`、`{{ memory_extensions_folder_structure }}`、`{{ memory_extensions_primary_inputs }}`、`{{ phase2_workspace_diff_file }}`
- 两种模式：`INIT phase`（产物缺失/为空）与 `INCREMENTAL UPDATE`（已有产物 + 新 raw memory）
- `memory_summary.md` 首行必须是 `v1`，否则整份重写
- `MEMORY.md` 每块必须以 `# Task Group:` / `scope:` / `applies_to: cwd=...; reuse_rule=...` 开头
- 每个 `## Task <n>` 必须带 `### rollout_summary_files` 与 `### keywords`
- 任务在前、合并性指导在后；正文不加粗
- 默认映射：一份 rollout summary → 一个 MEMORY 块 → 一个 `## Task 1`
- 块级指导用 `[Task 1]` / `[Task 2]` 引用任务
- `memory_summary.md` 结构：`v1` / `## User Profile` / `## User preferences` / `## General Tips` / `## What's in Memory`（按 scope 再按 memory day 分组）/ `### Older Memory Topics`
- 覆盖率护栏：`MEMORY.md` 里每个顶层 `# Task Group` 都要在 `What's in Memory` 里被某个主题/关键词簇代表
- 不打开原始 rollout；`{{ phase2_workspace_diff_file }}` 里的变更权威
- git 仓库由 Codex 管理

### 使用侧（注入）

标题块 `You have access to a memory folder with guidance from prior runs.`

- 决策边界：请求自包含才跳过；提到 workspace/repo/module/path/files，或问题非平凡且与 SUMAMRY 相关 → 默认用记忆；不确定就做一次快速检索
- 布局说明：`memory_summary.md`（已提供，不要重复打开）/ `MEMORY.md`（主检索文件）/ `rollout_summaries/`
- 5 步快速检索：抽关键词 → 搜 `MEMORY.md` → 只在 `MEMORY.md` 指向时打开 1–2 个 summary → 需要精确证据再搜 `rollout_path` → 无命中就停止；**预算 ≤ 4–6 步**
- 验证规则：便宜的验证要验；贵或干扰性的可以凭记忆回答，但**必须说明是记忆推断且可能过期**，不得把未验证的记忆当已确认事实
- 引用格式：`<file>:<line_start>-<line_end>|note=[<how memory was used>]`，路径相对 memory base path；另附 `<rollout_ids>`（一行一个）；**禁止在 PR 消息里放记忆引用**
- 更新规则：**只有用户明确要求才能更新记忆**，且只能往 `extensions/ad_hoc/notes/` 写一个 note 文件，不得直接编辑记忆

## 6. 生命周期

`memories/write/src/start.rs` 负责启动编排：读 state db，按 `max_rollouts_per_startup` / `min_rollout_idle_hours` / `max_rollout_age_days` 挑选 rollout 入队 `memory_stage1`，另调度 `memory_consolidate_global`。

`jobs` 的 lease/retry/watermark 字段说明这是带租约的异步作业队列：多 worker 竞争、失败重试有上限、用 `input_watermark` / `last_success_watermark` 做增量。

`guard.rs` 在 `min_rate_limit_remaining_percent` 之下暂停重活；`extensions/prune.rs` 用 `%Y-%m-%dT%H-%M-%S` 时间戳修剪扩展资源。

## 7. `dsh-codex-memories` 的映射

| 机制 | Codex | dsh-codex-memories 实现 |
| --- | --- | --- |
| 存档根 | `~/.codex/memories` | `$DSH_HOME/memories`（`storageDir` 可覆盖） |
| 索引 | sqlite 三表 | `index.json`：`sessions` / `jobs` / `progress` |
| 会话单位 | rollout `.jsonl` | DSH Session（事件流） |
| 渲染 | 预渲染的 filtered conversation | `lib/render.js`：按事件类型渲染，硬预算 48 k 字符，工具参数/结果各自截断 |
| Stage 1 | 一次模型调用 → 三键 JSON | `PHASE1_TEMPLATE` + 同款三键 JSON 解析（容忍围栏与前后散文） |
| Phase 2 | 模型直接写文件 | 模型返回两段分隔文档（`<<<MEMORY_MD>>>` / `<<<MEMORY_SUMMARY_MD>>>`），插件原子落盘 |
| 提取触发 | 启动扫描 + 空闲阈值 | `agent/turn-stopping` 标记 dirty → 60 s 扫描 → 空闲 `idleSeconds` 后提取；启动 10 s 后 `backfill()` |
| 补齐历史 | rollout 全量扫描 | `sessionPersistence.list()` + `open(id,'read')`，用 `eventCount` 做水位去重 |
| 合并触发 | `max_raw_memories_for_consolidation` | `consolidationThreshold`（默认 2 个新提取） |
| 注入 | 使用侧模板 + SUMMARY | `systemPrompt.context`（`order: 4500`），内容 = `USAGE_TEMPLATE` 渲染，30 s 刷新 |
| 工具 | `search/read/list/add_ad_hoc_note` | `memory_search` / `memory_read` / `memory_list` / `memory_note`，参数与匹配模式对齐 |
| 人工入口 | TUI | `/memory status\|show\|extract\|backfill\|consolidate\|forget\|on\|off` |
| 使用计数 | `usage_count` / `last_usage` | `index.json` 记录字段已保留，暂未参与淘汰 |

### 有意保留的约束

- **模型不能直接改 `MEMORY.md`**。与 Codex 一致，模型只能写 `extensions/ad_hoc/notes/`，合并由 Stage 2 统一做。
- **no-op 是合法结果**。Stage 1 返回三空串时不写任何文件。
- **`memory_summary.md` 必须以 `v1` 开头**。写入时若模型漏了，插件补上。
- **引用格式固定**。使用侧模板逐字保留了 `<file>:<start>-<end>|note=[...]` 与 `<session_ids>` 的要求。
- **检索预算**。模板里保留"≤ 4–6 步"的轻量检索约束，避免记忆检索本身吃掉上下文。

### 有意改变的地方

- 术语：`rollout` → `session`，`rollout_summary` → 仍叫 `session_summary`（JSON 键兼容两种写法）。
- Stage 2 的输出协议：Codex 让 Agent 自己写文件（它有文件工具）；插件没有赋予模型写权限，改为返回分隔文档由插件落盘。这消除了"模型写坏手册"的失败模式。
- 索引：不引入 sqlite 依赖。`jobs` 的租约/重试字段没有照搬，因为 DSH 是单进程、提取有串行锁 `runExclusive`。
- 淘汰：`max_unused_days` / `max_rollout_age_days` 只实现了"年龄跳过提取"，未实现"按使用计数淘汰手册条目"。

## 8. 未验证/未做的事

- 没有运行 Codex 本体做行为对照（只读取证，未执行 `codex.exe`）。
- 长模板的分段拼接可能有零星丢字；规则条目是逐条读到的，不是摘要推断的。
- 没有在真实 DSH Host 上完成一次安装加载验证（本会话审批被禁用，`plugin_manager` 不可用）。插件通过 mock Cordis 上下文做了全链路测试，Service/Event 契约逐条对照了官方源码。
- Stage 2 的两文档输出协议是本插件的设计，不是 Codex 的原协议。
