# 🗺️ 开发路线图

> 本文档规划 `@xwink/ops`（CLI `winkops`）的方向：先讲定位与现状能力，再列前瞻路线。
> 技术栈、分层架构与安全主线见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 定位与愿景

`winkops` 是 **个人开发者与 AI Agent 协作时的「SSH 快捷操作入口」**：agentless、轻量，人类用命令行、agent 用 `--json`。覆盖一台标准栈服务器的**完整生命周期**——`provision`（装配 nginx/redis/mysql/docker/node/jdk/python 等标准栈）→ `deploy`（发应用）→ `status`/`logs`（看运行）→ `edit`/`service`（维护）。

**边界（不做）**：不做观测性大盘，也不做通用配置管理引擎（Ansible 那套）；provision 面向固定栈的策划式 recipe，需要更复杂的编排时对接专业工具。

## 现状能力（v1.0）

单机全生命周期已打通，各命令均有结构化结果（`--json`）+ 退出码，写操作有 dry-run 预演与护栏。

**地基**

- `SshSession`（`open`/`exec`/`stream` 流式/`sftp` 缓存/`close`）+ `withSession`：所有命令的共同 SSH 底座，也是稳定的编程式 API（`@xwink/ops` 库入口 `lib.ts`）。
- `guard` 守护式变更原语：备份 → 应用 → 校验 → reload → 失败回滚，不抛错收进 `GuardResult`，是 `edit`、provision `configure`、部署回滚的共同流水线。

**部署（deploy/pull/ls）**

- 单机 / 多机（`hosts`，continue/`--fail-fast`，受限并发）SFTP 传输；增量（size+mtime）、`.winkignore`、扁平化、清空、覆盖控制、隐藏过滤。
- 失败重试 + 并发池；文件级备份/回滚（`--sftp-backup` 自动回滚、`--rollback` 手动恢复）。
- 双向：`pull` 下载（递归镜像）、`ls` 远程浏览。
- 配置：JSON/YAML、多环境深合并（`--env`）、`${ENV_VAR}` secrets 注入（不落明文）。

**运维原语（ops）**

- 只读：`status`（agentless 资源快照）、`logs`（tail + grep，`--follow` 流式）、`ps`（进程快照）、`exec`（远程执行，`--stream` 实时直出）。
- 写（须确认）：`service`（systemd/pm2/docker，写动作须 `--yes` + 审计）、`edit`（守护式改配置，复用 `guard`）。

**环境初始化（provision）**

- 按声明式 `stack` 把单机收敛到目标栈：`nodejs`(nvm)/`jdk`(sdkman)/`python`(pyenv)/`docker` + `nginx`/`redis`/`mysql`（install + verify，redis/mysql 支持 `mode: docker|native`）。
- recipe 以纯函数描述（detect/parse/converge），幂等；`--dry-run` 出 diff、`--yes` 才执行；含 secret 的命令/输出统一脱敏。
- 守护式 `configure`：组件可声明本地配置文件 → 远程，经 `guard` 落地（备份→写→校验→reload→失败回滚）。

**工程化**：oxlint/oxfmt + pnpm + TS 6；CI 门禁（lint/format/typecheck/test/build/e2e/commitlint，Node 22/24 + Node 18 冒烟）；覆盖率门槛；推 tag 经 OIDC 可信发布 npm（自动 provenance）。

## 前瞻路线 — 规模化与可视化 ⬜

从「单机」扩展到「多机舰队」与「可视化 / 告警」：

- **多主机 inventory**：配置从单 host 升级为主机清单 + 分组（极简版 Ansible inventory，zod 承载），统一现有的主机数组与分组。
- **多机 / 分组批量**：`provision` / `status` / `logs` 跨主机批量执行并聚合（沿用现有失败策略与并发上限）。
- **ink TUI 仪表盘**：归一化指标的可视化（人类侧）；agent 侧继续走 `--json`。
- **daemon 常驻 + notifier 告警**：持续监控与阈值告警，webhook 推送（钉钉/飞书，仅推送不做告警引擎）；daemon 与 notifier 一起落地。

## 让 AI Agent 可调用 🔄

> 决策：**主推 Skill + 护栏做进 CLI**，面向 Claude Code / Claude 生态，暂不引入 MCP。

`winkops` 本质是 CLI，agent 本就擅长经 shell 调用。关键不在「用什么协议封装」，而在「agent 能否可靠判断成败、且不会误删生产」——这属于工具自身能力，做进 CLI 本身：退出码 / 注入转义 / `--json` / `--dry-run` + 危险操作 `--yes` 护栏。

**Skill** 承载使用流程与安全规约（真跑前先 `--dry-run --json` 给用户确认；`clear` 等危险操作须人工确认才加 `--yes`；凭退出码与 `--json.failed` 判断结果）。现状 Skill 集：

- `deploy`（部署：增量 / `.winkignore` / 多环境 / YAML / secrets）
- `pull`（远程只读：`pull` 下载 + `ls` 浏览）
- `ops`（运维原语：`exec`/`status`/`logs`/`ps` 诊断 + `service`/`edit` 维护）
- `provision`（环境初始化，按 stack 收敛）

Skill 随 npm 包分发（`package.json#files` 含 `.claude/skills`）。现状：用户从 `node_modules/@xwink/ops/.claude/skills/` 拷贝到自己项目的 `.claude/skills/`。规划：`winkops skill install [name]` 自动安装，免去手动拷贝。

**不用 MCP**：MCP 收益主要在跨平台与代码级护栏；护栏既已做进 CLI（任何调用方都安全），MCP 优势被削弱。待出现跨平台 agent 需求时，可基于 `SshSession` 编程式 API 低成本封装。

## 设计原则

- **能力先于规模**：先把单机全生命周期做透，多机舰队与 TUI/告警等放后续。
- **安全做进 core**：危险/写操作的护栏、转义、审计在核心层统一实现，任何调用方都受益。
- **结构化优先**：每个命令返回结构化结果 + 退出码，human 走 stderr、机器走 `--json` stdout。
- **测试护航**：纯模块单测 + SSH mock + 进程内 e2e；无测试的行为变更不接受。
