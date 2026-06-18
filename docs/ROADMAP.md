# 🗺️ 开发路线图

> 本文档规划 `@xwink/sftp` 的迭代方向。MVP（v1.0.x）之后，按「先止血、再加固、后增强、最后扩展」分阶段推进，每个阶段均可独立发布。
>
> 技术栈、分层架构与安全主线见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 进度追踪

> 图例：✅ 已完成　🚧 进行中　⬜ 计划中　🔄 持续更新（贯穿各版本、随命令面扩展）。条目级进度见各 Phase 内的清单复选框。

| Phase   | 版本       | 主题                   | 状态        |
| ------- | ---------- | ---------------------- | ----------- |
| Phase 1 | v1.1       | 稳定与安全加固（止血） | ✅ 已完成   |
| Phase 2 | v1.2       | 健壮性与工程化（加固） | ✅ 已完成   |
| Phase 3 | v1.3       | 功能增强（提效）       | ✅ 已完成   |
| Phase 4 | v2.0       | 能力扩展（编排）       | ✅ 已完成   |
| Phase 5 | v3.0       | 平台化（单机）         | 🚧 进行中   |
| Phase 6 | v4.0       | 规模化与可视化         | ⬜ 计划中   |
| 专项    | 贯穿各版本 | 让 AI Agent 可调用     | 🔄 持续更新 |

> 专项「让 AI Agent 可调用」（详见末尾同名章节）不绑定单一版本：CLI 硬化随 Phase 1 落地、首个 deploy Skill 随 v1.2 交付并随包分发，Skill 集与 `skill install` 自动安装随后续子命令（status/logs/provision…）持续扩充——故状态为持续更新而非一次性完工。

## 长期愿景

工具的终局定位不止于「一次性部署」，而是 **个人开发者与 AI Agent 协作时的「SSH 快捷操作入口」**：agentless、轻量，人类用 TUI、agent 用 JSON。覆盖一个标准栈服务器的**完整生命周期**——`provision`（装配 nginx/redis/mysql/docker/node/jdk/python 等标准栈）→ `deploy`（发应用）→ `status`/`logs`（看运行）→ `edit`/`service`（维护）。**不做**观测性大盘 / 通用配置管理引擎（Ansible 那套），需要时对接它们。

演进分三段：**v1.x–v2.0 先把「部署」这条线做到可信、好用、可编排**，地基（`SshSession` + `guard`）同时是后续支柱的共同底座；**v3.0 在单机上展开完整生命周期**——环境初始化（provision）+ 只读运维 + 守护式配置编辑；**v4.0 规模化与可视化**——多机 inventory、批量执行、TUI 仪表盘、常驻告警。

## 现状定位：v1.0.x = MVP

已具备的最小可用能力：

- 单机 SFTP 全量传输
- JSON 配置文件 / CLI 参数双入口
- 传输前后执行远程命令（`beforeRunCommand` / `afterRunCommand`）
- 目录扁平化、清空远程目录、覆盖控制、路径排除、隐藏文件过滤

MVP 验证了「配置驱动的一键部署」这一核心价值，但尚不足以被信任用于生产 CI——失败可能误报成功、部分文件可能被静默漏传。因此第一阶段的目标不是加功能，而是让 MVP 真正「可信」。

---

## Phase 1 — 稳定与安全加固（v1.1，止血）✅

> 目标：让现有功能在生产 / CI 中可信。本阶段全部来自代码审查，必须最先完成。
>
> **状态：已完成（v1.1.0 已发布）。** 下表 8 项与测试骨架 / CI 均已落地。

| 项                                                        | 类别                | 处理                                                      |
| --------------------------------------------------------- | ------------------- | --------------------------------------------------------- |
| 失败不返回非零退出码                                      | 可靠性              | 所有失败路径统一设置 `process.exitCode = 1`               |
| 本地文件名拼入远程 shell 导致命令注入                     | 安全                | `exec` 参数统一 shell 转义（单引号包裹 + 转义）           |
| `debug` 打印明文密码                                      | 安全                | 日志前对 `password` / 密钥脱敏                            |
| `ignoreHidden` 误判（检查整个绝对路径、匹配任意含点名字） | 正确性              | 改为只对相对路径段做 `startsWith('.')` 判断               |
| 文件列表为空时 `path.extname(files[0])` 崩溃              | 正确性              | 先判空再走 `remoteIsDir`                                  |
| CLI 的 `mode` / `port` 为字符串未解析                     | 正确性              | 入口增加类型解析层（`parseInt(mode, 8)`、`Number(port)`） |
| 缺少机器可读输出                                          | agent 可调用        | `--json` 结构化输出（stdout 专用，人类日志走 stderr）     |
| 缺少预演能力                                              | agent 可调用 / 安全 | `--dry-run` 打印将执行的动作但不落地                      |

`--json` 与 `--dry-run` 是 agent 可靠判断成败、安全预演的前提，与本阶段修复同属「CLI 硬化」。

**测试护航**：抽出 `scanner` / `pathmap` / `exec` 纯模块时，同步建立 vitest 骨架与 GitHub Actions CI——无测试的行为变更与重构不可接受，测试与本阶段同步落地以锁住修复、护住重构。

**根因收口**：注入与日志泄露本质都在 `exec()` 这一层。将 `exec` 重构为「参数转义 + 区分 stderr 与失败码（stderr 不等于失败，以退出码为准）+ 结构化返回」的可信底座，后续阶段均依赖它。

**版本策略**：以上修复会改变部分现有行为（隐藏文件判定收窄、stderr 不再算失败、失败返回非零退出码等）。这些本质是 bug 修复、旧行为本就有误，因此作为 **v1.1 minor 直接修正**，不另起 major；但需在 CHANGELOG 中以「⚠️ 行为变更」醒目标注，提示用户升级后验证。

---

## Phase 2 — 健壮性与工程化（v1.2，加固）✅

> 目标：扛得住真实规模（数百文件）与真实网络（抖动 / 超时）。
>
> **状态：已完成（v1.2.0 已发布）。** 含并发池、失败重试、前置命令次序、flat 覆盖告警与进度日志、SSH 密钥登录、写操作审计、deploy Skill、SSH mock 测试与覆盖率门槛、贡献者文档。

健壮性：

- [x] **并发上限**：传输与建目录加并发池（`pool.ts` 的 `mapPool`，默认 5，`--sftp-concurrency` 可调），避免超出 SSH 服务端 `MaxSessions` 限制。
- [x] **`beforeRunCommand` 在 `scan()` 之前执行**：让构建产物能被纳入传输列表。
- [x] **flat 模式同名覆盖告警**：不同子目录同名文件相互覆盖时给出提示（`findFlatCollisions`，计入 `DeployResult.warnings`，dry-run 也会预警）。
- [x] **失败重试**：单文件传输失败自动重试 N 次（`retry.ts` 的 `withRetry`，默认 2 次、线性退避，`--sftp-retries` 可调）。
- [x] **进度反馈与分级日志**：以分级日志替换裸 `console`，传输时输出 `[x/total]` 进度（走 stderr，不污染 `--json` stdout）。

安全：

- [x] **SSH 密钥登录**：补 `privateKey` / `passphrase` / `agent`，允许密码留空（`resolveConfig` 校验密码或密钥二选一，CLI `--connect-private-key` 传文件路径）。明文密码不适合 CI，密钥登录是生产部署刚需。
- [x] **操作审计日志**：实跑部署在本地追加审计记录（`audit.ts`，默认 `~/.wink-sftp/audit.log`，`--audit-log` 改路径、`--no-audit` 关闭）——何时 / 哪台 / 什么动作 / 结果；写入失败降级为 debug 不中断主流程。（`edit`·`service`·`provision` 等写操作随后续命令接入。）

Agent 协作：

- [x] **deploy Skill**：交付首个 Skill（`.claude/skills/deploy/SKILL.md`），承载「先预演 → 人工确认 → 真跑 → 按退出码/`ok`/`failed[]` 判定」的部署流程与安全规约（详见末尾「让 AI Agent 可调用」）。

工程化（面向开源社区推广）：

- [x] **工具链现代化**：oxlint/oxfmt 取代 eslint/prettier；pnpm + TypeScript 6 + tsx；changelogen 取代 conventional-changelog-cli；移除 husky/lint-staged，提交信息改由 CI 的 commitlint job 校验。代码风格：4 空格 / 单引号 / 无分号、`import type` 显式。
- [x] **CI / 发布**：lint + format + typecheck + test + build 作为门禁（Node 22/24）+ Node 18 运行时下限冒烟；推送 `v*` tag 触发自动发布 npm，经 OIDC 可信发布（无 token，自动 provenance 供应链溯源）。待补：状态徽章。
- [x] **测试覆盖完善**：加本地 SSH/SFTP mock（`test/deploy.mock.test.ts`）端到端覆盖 override / clear / 重试 / 前置命令次序 / 审计；补 logger / errors / exec 错误路径用例；`@vitest/coverage-v8` 建立覆盖率门槛（CI 跑 `test:coverage`，stmts≥90 / branch≥85 / func≥85 / lines≥90）。
- [x] **贡献者体验**：`CONTRIBUTING.md`、Issue/PR 模板（`.github/`）、`LICENSE`（MIT）文件。

---

## Phase 3 — 功能增强（v1.3，提效）✅

> 目标：从「能传」到「好用」，补齐部署工具标配能力。

- [x] **双向传输 `pull` / 下载**：`fastGet` 下载（目录递归镜像 + 受限并发/重试），新增 `ls` 远程目录浏览；CLI 升级为子命令体系，`deploy` 仍为默认命令向后兼容（`core.ts` 抽出通用 `withConnection`）。
- [x] **增量传输**：`sftpOptions.incremental` / `--sftp-incremental`，按 size + mtime 比对远程文件（`sftp.stat`），只传变更文件、优先于 `override`。（远程 hash 比对暂未做，按需再加。）
- [x] **`.winksftpignore`**：gitignore 风格忽略文件（`ignore` 包，含目录剪枝），补充全字匹配的 `excludes`；亦支持 `sftpOptions.ignore` 内联规则，二者合并。
- [x] **多环境配置**：配置文件 `environments` 映射 + `--env <name>` 选中后深合并到基础配置之上（`deepMerge`）。
- [x] **配置格式 JSON + YAML**：按扩展名识别 `.json/.yaml/.yml`（js-yaml），统一由 zod schema 校验（`config.ts` 单一事实源）。
- [x] **secrets 环境变量引用**：配置中以 `${ENV_VAR}` 引用，校验前从环境变量（优先）/ `.env` 注入，缺变量报错、不落明文。（stdin 注入暂未做。）

---

## Phase 4 — 能力扩展（v2.0，编排）✅

> 目标：从「单机部署脚本」升级为「部署编排工具」，并沉淀 `guard` / `SshSession` 两个支柱共用的地基件。
>
> **状态：已完成。** 四项全部落地、各有单测 + e2e 守护。

- [x] **`guard` 守护式变更原语**（`src/guard.ts`）：「备份 → 应用 → 校验 → reload → 失败回滚」通用流水线（`guard` + `backupRemote`/`restoreRemote`/`existsRemote`），不抛错、把成败收进 `GuardResult`。它是 `edit`、provision `configure`、部署回滚的共同底座，作为独立地基件成形。
- [x] **多服务器并行部署**（`runMany` / `runAuto`）：`hosts` 主机数组，一次发布多台并按主机聚合 `MultiDeployResult`。**失败策略**：默认 continue（受限并发跑完再汇总）/ `--fail-fast`（顺序、首台失败即停）；`--host-concurrency` 控主机并发。CLI `--hosts` 或配置文件 `hosts`。（完整 inventory 分组在 Phase 6。）
- [x] **回滚 / 备份（仅文件级）**：`--sftp-backup` 部署前对已存在目标 `cp -a` 快照，任一文件失败**自动回滚**（回滚后不执行 afterRunCommand）；`--rollback` 手动恢复到最近快照。**边界**：仅回滚文件，**不回滚钩子副作用**（服务重启、数据库变更等）。
- [x] **稳定的编程式 API**（`src/lib.ts` 库入口）：导出 `SshSession`（`open`/`exec`/`sftp`/`close`）+ `withSession`、`run`/`runMany`/`runAuto`/`pull`/`ls`/`rollback`、`guard` 及全部结果/错误类型，供 Node 脚本集成；`package.json` `main`/`types`/`exports` 指向库入口、`bin` 仍为 CLI 单文件。

> 按需：生命周期钩子泛化（`preScan`/`preUpload`/`postUpload`/`onError`）——现有 before/after 已够用，待真实需求出现再做。多机的完整 inventory/分组留待 Phase 6。

---

## Phase 5（v3.0）— 平台化（单机）🚧

> 目标：在通用 `SshSession` 层上把工具从「部署」展开为「SSH 快捷操作入口」，覆盖单机的环境初始化、只读运维与守护式配置编辑。CLI 升级为子命令体系（`deploy` 向后兼容，无子命令时默认 deploy）。provision 与只读运维原语并行推进——二者依赖同一地基（`SshSession` + `guard`），不互相阻塞。
>
> **进度（按「先只读原语跑顺，再守护式写」的次序分批）**：
>
> - ✅ **已交付（首批）**：`exec`（远程执行）、`status`（agentless 资源快照）、`logs`（tail + grep）只读原语 + `edit`（守护式配置编辑，复用 `guard`）。各有 fixture/mock 单测 + e2e（真 `/bin/sh`）。
> - ⬜ **待做**：`provision`（环境初始化，主打，见下）、`ps`/`service`（进程/服务管理）、`logs --follow` 流式。

### 环境初始化（单机 provision）— 主打

`provision` 按声明式 stack 定义（`--stack <name>`，与部署 `--env` 正交）把单台服务器**收敛**到目标栈状态，覆盖装配 / 配置 / 维护。边界：面向固定栈的策划式 recipes，非通用 CM 引擎。

```yaml
stack:
    nodejs: '20' # 版本管理器（nvm）
    jdk: '17' # sdkman
    python: '3.11' # pyenv
    nginx: latest # 官方源 + 守护式配置
    docker: true # 官方安装脚本
    redis: { version: 7, mode: docker, maxmemory: 512mb }
    mysql: { version: 8, mode: native, rootPassword: '${MYSQL_ROOT_PWD}' } # mode: docker|native
```

- **Recipe 契约**：每个组件实现 `detect / install / configure / verify / maintain`，**自带幂等**（detect → converge），不建通用状态引擎。
- **架构复用**：`configure` 即 Phase 4 的 `guard` 守护式变更；坐在 `SshSession` + `exec` 之上。
- **取舍**：Ubuntu/Debian 优先；语言运行时用版本管理器（nvm/sdkman/pyenv）；mysql/redis 形态由 `mode` 决定。
- **`--dry-run` 出 diff、`--yes` 才执行**；secrets 以 `${ENV_VAR}` 引用、不落明文。

### 只读运维原语 — agent 诊断

| 子命令           | 读/写 | 状态 | 说明                                            |
| ---------------- | ----- | ---- | ----------------------------------------------- |
| `status`         | 读    | ✅   | 资源/健康快照（CPU/内存/磁盘/负载），`--json`   |
| `logs`           | 读    | ✅   | `tail -n` 末 N 行 + grep（`--follow` 流式待做） |
| `ls` / `browse`  | 读    | ✅   | 远程文件浏览（v1.3 已交付）                     |
| `exec`           | 读/写 | ✅   | 远程执行，`run()` 收集（`stream()` 流式待做）   |
| `ps` / `service` | 读/写 | ⬜   | 进程查看与服务管理（systemd/pm2/docker）        |

- **采集 agentless**：纯 SSH 解析 `top`/`free`/`df`/`/proc`，零安装；跨发行版差异由归一化层吸收。
- **排查 = 可组合的只读原语**：不做 `diagnose` 黑盒；输出可靠的结构化「事实」，由 agent 组合推理得「判断」。

### `edit` — 守护式配置编辑 ✅

复用 `guard`：备份 → 写入新内容 → 校验（`--validate`，如 `nginx -t`）→ reload（`--reload`）→ 失败回滚。

- **已定**「编辑主体」模型：**本地文件提供新内容**（`--file`，agent/脚本直接给出目标内容，最确定、可重放）；交互式 `$EDITOR` 拉取-编辑模型按需再加。
- collector 解析以**纯函数 + fixture 单测**保证跨发行版正确性（`parseLoadavg`/`parseMeminfo`/`parseDf`）；集成只断言连通性。

> 上线次序：先只读原语（`status`/`logs`/`ls`）跑顺人机协作，再开放守护式写（`edit`/`service`）。

---

## Phase 6（v4.0）— 规模化与可视化⬜

> 目标：从「单机」扩展到「多机舰队」与「可视化 / 告警」。

- **多主机 inventory**：配置从单 host 升级为主机清单 + 分组（极简版 Ansible inventory，zod 承载），统一 Phase 4 的主机数组与本阶段分组。
- **多机 / 分组批量**：`provision` / `status` / `logs` 跨主机批量执行并聚合（沿用 Phase 4 的失败策略与并发上限）。
- **ink TUI 仪表盘**：归一化指标的可视化（人类侧）；agent 侧继续走 `--json`。
- **daemon 常驻 + notifier 告警**：持续监控与阈值告警，webhook 推送（钉钉/飞书，仅推送不做告警引擎）。daemon 与 notifier 绑定，在本阶段一起落地。

---

## 专项：让 AI Agent 可调用 🔄

> 决策：**主推 Skill + 护栏做进 CLI**，面向 Claude Code / Claude 生态，暂不引入 MCP。
>
> **状态：持续更新。** 地基（CLI 硬化）随 Phase 1 完成、首个 deploy Skill 随 v1.2 交付并随包分发；Skill 集与 `skill install` 自动安装随后续子命令扩充，不绑定单一版本。

`wink-sftp` 本质是 CLI，agent 本就擅长经由 shell 调用。关键不在「用什么协议封装」，而在「agent 调用时能否可靠判断成败、且不会误删生产」——这属于工具自身能力，做进 CLI 本身。

**基础：CLI 硬化**（即 Phase 1 的退出码 / 注入修复 / `--json` / `--dry-run` + 危险操作 `--yes` 护栏）让 agent 能可靠判断成败、安全预演——这是 agent 可调用的前提。

**接口：Skill**（仓库内随版本管理）承载使用流程与安全规约：真跑前先 `--dry-run --json` 给用户确认；`clear` 等危险操作必须人工确认才加 `--yes`；凭退出码与 `--json.failed` 判断结果。首个 deploy Skill 在 v1.2 交付；覆盖范围随子命令扩展（status/logs/provision…）从「部署」放宽到「SSH 运维入口」，可按需拆分为多个 skill。

```
.claude/skills/<name>/
├── SKILL.md            # 触发场景、配置 schema、安全规约
└── scripts/            # 可选：固化 dry-run → 确认 → 真跑 流程
```

**现状 Skill 集**：`deploy`（部署，覆盖增量 / `.winksftpignore` / 多环境 / YAML / secrets）+ `pull`（远程只读：`pull` 下载 + `ls` 浏览）。随子命令（status/logs/provision…）继续扩充。

**分发给最终用户**：Skill 既供本仓库贡献者使用，也随 npm 包发布（`package.json#files` 含 `.claude/skills`）。**现状**：用户从 `node_modules/@xwink/sftp/.claude/skills/` 手动拷贝到自己项目的 `.claude/skills/`，README 给出指引。**规划**：在 Phase 5 子命令体系内提供 `wink-sftp skill install [name]`，自动把随包 Skill 落到用户项目 `.claude/skills/`（或 `~/.claude/skills/`），免去手动拷贝；与 status/logs/provision 等子命令一并扩展可安装的 Skill 集。

**不用 MCP**：MCP 收益主要在跨平台与代码级护栏；护栏既已做进 CLI（任何调用方都安全），MCP 优势被削弱。待出现跨平台 agent 需求时，可基于 `SshSession` 编程式 API 低成本封装。

---

## 路线图一览

```
✅ v1.1  止血    安全/正确性 6 项 + --json/--dry-run + 测试骨架/CI    → 可信（CI / agent 可用）
✅ v1.2  加固    并发 / 重试 / 密钥登录 / 审计 / 测试完善 / deploy Skill → 抗规模、可生产、可协作
✅ v1.3  提效    pull 下载 / ls / 增量 / ignore / 多环境 / JSON+YAML / secrets → 好用
✅ v2.0  扩展    guard 原语 / 多机 / 文件级回滚 / 编程 API（SshSession）  → 编排工具
🚧 v3.0  平台    ✅ exec/status/logs/edit 运维原语 ｜ ⬜ provision/ps/service → 单机全生命周期
⬜ v4.0  规模    inventory / 多机批量 / ink TUI / daemon + notifier      → 多机舰队 + 可视化
```

**贯穿原则**：

- **稳定优先**：按 Phase 顺序推进，先止血再扩展；Phase 1 是硬门槛，测试骨架与 CI 与之同步落地。
- **能力先于规模**：v3.0 先把单机全生命周期（含 provision）做透，多机舰队与 TUI/告警等规模化、可视化放 v4.0。
- **行为变更随 minor 发布**：Phase 1 的行为修正作为 v1.1 minor，在 CHANGELOG 醒目标注，不另起 major。
- **面向开源社区**：测试覆盖、CI、贡献文档为重点投入项。
- **安全做进 core**：危险/写操作的护栏、转义、审计在核心层统一实现，任何调用方都受益。
