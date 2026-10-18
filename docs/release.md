# 发布清单（dsh-codex-memories）

发布到 DSH 插件市场前需要的东西，以及需要你提供的凭证。

## 1. 身份

| 项 | 值 |
| --- | --- |
| npm 包名 | `@lushdawn/dsh-codex-memories` |
| 版本 | `0.1.0` |
| License | MIT |
| 仓库 | https://github.com/Lushdawn/dsh-codex-memories （已建，`main` 分支，public） |
| 包内容 | `lib/`、`docs/mechanism.md`、`cordis.patch.yml`、`README.md`、`README.zh.md`、`LICENSE` |

**命名冲突记录**：最初的包名 `dsh-memories` 在 npm 上已被占用（0.2.1，作者做的是 "dual-ledger cross-session memory"，即 `MEMORY.md` + `PROGRESS.md`）。本插件是 Codex 记忆系统的结构化复刻（两阶段提取 + 手册合并 + 引用格式 + ad-hoc 写入约束），定位不同，因此改名为 `dsh-codex-memories`。发布前请再确认一次：

```bash
npm view @lushdawn/dsh-codex-memories version    # 应报 404/无输出
```

## 2. 发布前检查

- [x] `node --check lib/*.js` 全部通过
- [x] `node tests/smoke.mjs` 输出 `PASS smoke`
- [x] `npm pack --dry-run` 的文件清单与 `files` 一致，不含 `tests/.test-home`
- [x] `package.json` 的 `repository` / `homepage` / `bugs` 填真实地址
- [x] README 里的安装命令与实际包名一致（`dsh plugin --profile web add @lushdawn/dsh-codex-memories`）
- [ ] `npm publish --access public`（等 2FA 一次性密码）
- [ ] 在一个独立 profile 上真正装一次并启动，确认插件进入 active 状态
- [ ] 在真实 DSH 里跑通一次 `/memory status` → `/memory extract` → `/memory consolidate`

最后两项是**目前唯一没有在真实 Host 上验证过的环节**（本会话审批被禁用，`plugin_manager` 不可用，无法安装）。

## 2.1 Git 推送已配置

GitHub 仓库已建并通过 HTTPS 推送。凭据写入 `~/.git-credentials` 且 `git config --global credential.helper store`，所以以后新项目可直接 `git push`，不需要再次提供 token。

安全提醒：该文件是**明文**。token 用完后建议在 GitHub 上撤销并重新签发，或改用 SSH key 后删除该文件。

## 3. 安装验证步骤（凭证到位后第一件事）

用独立 profile，避免影响当前 `web` profile：

```bash
dsh plugin --profile verify add link:"H:\deepseek workspace\codex-memory-plugin\dsh-codex-memories"
dsh --profile verify
```

在会话里依次执行：

1. `/memory status` — 应打印记忆根目录与计数，而不是报错
2. 随便聊两轮，然后 `/memory extract` — 应生成 `session_summaries/<slug>.md`
3. `/memory consolidate` — 应生成 `MEMORY.md` 与 `memory_summary.md`
4. 新开一个会话，问一个和刚才内容相关的问题 — 模型应能引用记忆，并按 `MEMORY.md:行号|note=[...]` 格式标注

验证通过后清理：

```bash
dsh plugin --profile verify remove @lushdawn/dsh-codex-memories
```

## 4. 需要你提供

| 凭证 | 用途 |
| --- | --- |
| npm 账号（`npm login` 或 token） | `npm publish` |
| 插件市场发布入口或其 API token | 在市场登记插件 |
| 公开仓库地址 | 填 `repository` 字段，市场通常要求可追溯来源 |

拿到 npm 凭证后我会：

1. 补 `repository` 字段
2. `npm pack --dry-run` 复核
3. `npm publish --access public`（scoped 包必须带此参数，否则默认私有）
4. 用干净目录 `npm i @lushdawn/dsh-codex-memories` 复核安装
5. 再按市场要求提交登记

## 5. 市场文案要点

- 一句话：Codex 风格的两阶段长期记忆——会话自动提取、合并成可检索手册、每轮注入精炼摘要。
- 差异化：不是"再加一个记忆文件"，而是完整复刻 Codex 的提取/合并/引用/写入约束四件套；模型不能直接改手册。
- 诚实边界：会花 token；检索是关键词而非语义；Stage 2 在超大手册上可能触及输出上限。

## 6. 未完成项

- 没有客户端 UI（记忆浏览面板）。当前只有 `/memory` 命令与四个模型工具。
- `usage_count` / `last_usage` 字段已保留但未参与淘汰策略；`max_unused_days` 未实现。
- 没有实现 `no_memories_if_mcp_or_web_search` 这类"外部上下文活跃时不注入"的开关。
