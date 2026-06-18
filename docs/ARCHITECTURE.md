# 🏛️ 架构设计总纲

> 本文档定义 `@xwink/sftp` 的技术栈、分层架构、安全主线与命令面。迭代节奏与阶段划分见 [ROADMAP.md](./ROADMAP.md)。

## 一、愿景与边界

**定位**：个人开发者与 AI Agent 协作时的「SSH 快捷操作入口」——agentless、轻量，人类用 TUI、agent 用 JSON。

**覆盖**：一个标准栈服务器的完整生命周期——`provision`（装配 nginx/redis/mysql/docker/node/jdk/python 等标准栈）→ `deploy`（发应用）→ `status`/`logs`（看运行）→ `edit`/`service`（维护），以及上传/下载、文件浏览、排查、远程执行。

**边界（不做）**：时序数据库 / 观测性大盘、长期指标存储、复杂告警引擎、通用配置管理引擎（任意模块 / 通用资源状态图 / playbook DSL，即 Ansible 那套）。需要时对接它们（推 webhook / 暴露 JSON），而非取代。

> 护城河：环境初始化做成**面向固定栈的策划式 recipes**，而非通用 CM 平台——「多项目栈相同」让有主见的固定菜单成立，这是保持轻量的边界。

## 二、设计原则

1. **会话层为核心**：部署与所有运维能力共用一个通用 SSH 会话抽象，不各自管连接。
2. **纯逻辑与 IO 分离**：扫描、路径映射等纯函数独立可测，不连服务器即可穷举边界。
3. **结果对象 + 类型化错误**：核心返回结构化结果、抛类型化错误；由 CLI 层决定渲染与退出码。
4. **护栏进 core**：危险/写操作的安全保障在核心层，任何调用方（CLI / Skill / 编程 API）都受益。
5. **读写分离**：只读命令默认放行（agent 零风险），写命令一律走确认护栏。
6. **人机双消费**：同一份结构化数据可渲染为 TUI（人）或 JSON（agent）。

## 三、技术栈

| 技术                                                            | 角色                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **TypeScript 6.x**（`strict`、目标 `noUncheckedIndexedAccess`） | 全栈语言                                                                            |
| **ssh2**                                                        | 底层 SSH/SFTP 连接与远程 `exec`                                                     |
| **ssh2-sftp-client**                                            | 上层 SFTP 传输封装（exists / mkdir / fastPut / fastGet）                            |
| **commander**                                                   | 子命令体系 CLI                                                                      |
| **zod**                                                         | 配置 / inventory / stack schema 校验、类型推导、JSON-Schema 生成（单一事实源）      |
| **js-yaml**                                                     | YAML 解析（与 JSON 双格式，统一交 zod 校验）                                        |
| **vitest** + **ssh2 内置 `Server`**                             | 测试；进程内起 SFTP server，免 Docker                                               |
| **p-limit / p-queue + p-retry**                                 | 并发池 + 重试                                                                       |
| **consola** + **picocolors**                                    | 分级日志（人类输出走 stderr）+ 终端着色                                             |
| **ink**                                                         | 监控仪表盘 TUI                                                                      |
| **node-cron / 原生 `setInterval`**                              | 轮询调度                                                                            |
| **原生异步迭代器**                                              | 流式输出（`for await`）                                                             |
| **pnpm**                                                        | 包管理器（`node-linker=hoisted`，利于 ncc 解析 ssh2 原生件）                        |
| **oxlint + oxfmt**                                              | 静态检查 + 代码格式化（取代 eslint/prettier）                                       |
| **tsx**                                                         | 开发期直接运行 TS（取代 ts-node）                                                   |
| **changelogen**                                                 | 版本递增 + CHANGELOG 生成 + GitHub Release（取代 conventional-changelog-cli/bumpp） |

**构建与产物**：CLI 二进制用 ncc 打单文件（原生 addon 友好）；库入口用 tsc 产出 JS + d.ts、ssh2 作普通依赖（bin 打包、lib 不打包），不使用 Babel。`package.json` 的 `main`/`types`/`exports` 指向 tsc 产物、`bin` 指向 ncc 产物、不设 `browser` 字段。`engines.node >= 18`。**发布**由推送 `v*` tag 触发 GitHub Actions：跑门禁后 `npm publish` 经 **OIDC 可信发布**（无 token，自动生成 provenance 供应链溯源；需先在 npmjs.com 配置可信发布者，仓库须公开）。

**为何不用 rollup/vite 打包**：二者基于 rollup，对 ssh2 的原生组件（`cpufeatures.node`）解析易失败（项目早期 rollup 路径正因此报错）；ncc 对原生 addon 友好、自动拷贝原生资产，产出真正自包含的单文件 CLI。vite 仅作为 vitest 的测试基建存在，不用于生产打包。

**关键取舍（含原因）**：

- **SFTP 层**：传输用 ssh2-sftp-client 封装（省去自写 exists/mkdir 等易错代码），远程 `exec` 用 ssh2 直连。
- **模块体系**：CJS（ssh2 为 CJS，CLI 场景无需 ESM）。
- **采集模型**：agentless（纯 SSH 解析、零安装），可对接已有 exporter；不自建 remote agent。
- **运行模型**：on-demand 快照 + 前台 TUI 为主，daemon 常驻告警为可选。
- **包名**：保留 `@xwink/sftp`（umbrella 命名待运维支柱成熟后评估）。
- **provision**：策划式固定栈 recipes（非通用 CM）；Ubuntu/Debian 优先；语言运行时用版本管理器（nvm/sdkman/pyenv）；mysql/redis 的 Docker / 原生形态由 stack 的 `mode` 决定。

## 四、分层架构

```
src/
  index.ts            # bin 入口：只负责 CLI → core 接线
  cli/
    program.ts        # commander 子命令定义
    options.ts        # CLI → config 映射 + 类型解析（mode/port）
    render.ts         # 人类输出 vs --json 输出
  core/
    session.ts        # SshSession：连接 / keepalive / exec / 流式 / sftp（共同底座）
    deployer.ts       # SftpDeployer：部署编排（基于 session）
    scanner.ts        # 本地扫描（纯函数）
    pathmap.ts        # 本地→远程路径映射 + remoteIsDir 判定（纯函数）
    transfer.ts       # 上传/下载：并发池 + 重试
    remote.ts         # 远程操作：mkdir / exists / clear / exec（统一转义）
    exec.ts           # 安全执行：run()（收集）+ stream()（异步迭代器）
    guard.ts          # 守护式变更原语（备份→校验→原子→回滚）
    monitor/
      collectors/     # cpu/mem/disk/load/net…：远程命令 → 指标
      model.ts        # 归一化指标类型
    process/          # 服务/进程管理（systemd/pm2/docker）
    provision/
      recipe.ts       # Recipe 契约（detect/install/configure/verify/maintain）
      recipes/        # nginx/redis/mysql/docker/nodejs/jdk/python 各组件配方
      stack.ts        # stack 定义 → 收敛计划
  config/
    schema.ts         # zod schema + 类型 + 默认值（单一事实源）
    resolve.ts        # 合并文件 + CLI、校验
    inventory.ts      # 多主机清单 + 分组
  output/
    tui.ts json.ts notifier.ts   # 多 sink
  logger.ts           # 分级日志 + json sink
  audit.ts            # 写操作本地审计日志（何时/哪台/动作/结果）
  errors.ts           # 类型化错误（ConfigError/ConnectionError/TransferError/RemoteCommandError）
```

## 五、核心抽象

- **`SshSession`**：可实例化（非单例），各自持有 `Client` / 配置 / logger，支持并发与多机；部署、监控、`exec`、`logs` 共用。
- **`exec`**：`run()` 收集后返回结构化结果（区分 stdout/stderr/退出码，参数统一转义）；`SshSession.stream()` 以回调（`onStdout`/`onStderr`）实时吐数据块、返回 `StreamHandle`（`done` 在 exit resolve 退出码、`close()` 主动终止），支撑 `tail -f`（`logs --follow`）、`exec --stream` 等长流，不靠退出码判定结束。
- **结果模型**：核心返回 `DeployResult { transferred, skipped, failed[], commands[], dryRun }` 等结构化对象；监控返回归一化指标。CLI 层据此渲染与定退出码。
- **错误模型**：类型化错误 + `cause` 链。

## 六、安全主线（贯穿全局）

**守护式远程变更原语**：`edit`（改 nginx 等）、`clear`、`service restart` 等所有写操作共用一条流水线——

```
备份 → 校验（如 nginx -t）→ 原子替换 → reload → 失败自动回滚到备份
```

一处实现、处处复用。配套：

- **读 / 写分离**：只读默认放行；写操作需 `--yes` / 确认。
- **危险路径校验**：`clear` 等校验 `remote` 非空、非 `/`、非根级。
- **命令转义单点收口**：所有拼进远程 shell 的路径只经 `remote.ts` 一个出口转义。
- **凭据安全**：配置以 `${ENV_VAR}` 引用 secrets，值从环境变量 / `.env` / stdin 注入，不落明文；日志一律脱敏。
- **操作审计**：所有写操作本地追加审计记录（何时 / 哪台 / 动作 / 结果），覆盖 agent 自动调用场景。
- **回滚边界**：部署/配置回滚为**文件级**（目录或文件快照还原），不回滚钩子副作用（服务重启、数据库变更）。

## 七、命令面

| 子命令            | 读/写 | 说明                                                                                                          |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `provision`       | 写    | 按 stack 定义收敛服务器栈（已交付全组件 install+verify；守护式 configure 精修待做；写须 `--dry-run`/`--yes`） |
| `deploy` / `push` | 写    | 部署 / 上传（无子命令时默认 `deploy`，向后兼容）                                                              |
| `pull` / `get`    | 写    | 下载（fastGet）                                                                                               |
| `ls` / `browse`   | 读    | 远程文件浏览                                                                                                  |
| `exec`            | 读/写 | 远程执行（run / stream）                                                                                      |
| `status`          | 读    | 资源/健康快照                                                                                                 |
| `logs`            | 读    | 日志流式 tail + grep                                                                                          |
| `ps` / `service`  | 写    | 进程/服务管理                                                                                                 |
| `edit`            | 写    | 守护式远程配置编辑                                                                                            |

**输出纪律**：`--json` 机器输出只走 **stdout**；人类日志/进度/debug 走 **stderr**。保证 `wink-sftp ... --json | jq` 成立，也是 agent 可靠解析的基础。

**退出码**：成功 0；配置错误 / 连接失败 / 执行失败用不同非零码，便于脚本与 agent 分支。

**配置维度**：`--env <name>` 选择部署环境（连接 + 路径）；`--stack <name>` 选择服务器栈定义。二者正交。

## 八、与 AI Agent 协作

- **协议**：主推 Skill + 护栏做进 CLI，面向 Claude / Claude Code 生态，不引入 MCP（理由见 [ROADMAP.md](./ROADMAP.md)）。
- **分工**：工具提供可靠的结构化「事实」（status/logs/ps 只读原语），agent 负责组合推理得「判断」；不做 `diagnose` 黑盒。
- **闭环**：监控数据（JSON）驱动 agent 决策 → agent 调用 deploy/exec/edit（走护栏）→ 再观测。人类（TUI）与 agent（JSON）驱动同一个运维面。

## 九、环境初始化（Provision）支柱

provision 坐在 `SshSession` + `exec` + 守护式变更原语之上的一层 **recipes**。

**Recipe 契约**（每个组件一个，自带幂等）：

```ts
interface Recipe {
    detect(session): InstalledState // 已装？版本？—— 幂等前提
    install(session, spec): Result // 收敛到目标版本
    configure(session, spec): Result // 复用守护式变更：备份→校验→原子→reload→回滚
    verify(session): Health // nginx -t / redis ping / mysqladmin ping
    // maintain（升级/备份/重启）：复用 guard + service
}
```

**已实现形态（全组件，install + verify）**：为最大化可测性，recipe 以**纯函数**落地为 `detect(options)`（按组件选项产出检测命令，redis/mysql 据 `mode` 返回 native/docker 检测）+ `parse`（解析输出为 `{installed,version}`）+ `converge(desired, state, options)`（产出幂等步骤，已满足则空步骤）——`install` 与 `verify`（`nginx -t` / `redis-cli ping` / `mysqladmin ping`）都是 `converge` 产出的步骤。含 secret 的步骤用 `PlanStep.display` 给脱敏命令，编排器对外（--json/审计）只暴露 display、绝不泄漏明文。`configure`（守护式写配置文件，复用 `guard`）/`maintain` 留作精修批。编排器只跑「检测→收敛→预演或执行」，写操作须 `--dry-run` 或 `--yes`。

**声明式 stack 定义**（跨项目复用的价值所在）：

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

`wink-sftp provision --stack prod` 将服务器**收敛**到此状态；`--dry-run` 出 diff，`--yes` 才执行。

**关键设计决策**：

- **边界**：策划式固定栈 recipes，非通用 CM 引擎；新组件手写 recipe。
- **幂等**：每个 recipe 自带 `detect → converge`，不建通用状态引擎。
- **目标发行版**：Ubuntu/Debian（apt 系）优先，跨发行版抽象后续再加。
- **语言运行时**：版本管理器（nvm / sdkman / pyenv），支持版本锁定与多版本共存，绕开跨发行版包烦恼。
- **有状态服务**：mysql/redis 的 Docker 容器与宿主机原生两条路径，由 stack 的 `mode` 决定。
- **安全**：`configure` 即守护式变更；secrets 以 `${ENV_VAR}` 引用、从环境变量/stdin 取，stack 文件不落明文。

## 十、阶段与架构落地映射

| 阶段            | 架构落地重点                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase 1（v1.1） | 抽出 `scanner` / `pathmap` / `exec` 纯模块 + 类化；护栏 / 转义 / 退出码 / `--json` / `--dry-run`；vitest 骨架 + CI |
| Phase 2（v1.2） | `SshSession` 成形、流式 `exec`、并发池、密钥登录、`audit`、测试覆盖完善、deploy Skill                              |
| Phase 3（v1.3） | `transfer` 支持下载、`ls`；增量、JSON+YAML、多环境、secrets                                                        |
| Phase 4（v2.0） | `guard` 守护式变更原语、多机（主机数组）、文件级回滚、`SshSession` 编程式 API                                      |
| Phase 5（v3.0） | 单机 provision（recipes + stack 定义）+ 只读运维原语（status/logs/ps）+ `edit`                                     |
| Phase 6（v4.0） | inventory + 多机批量 + monitor/`model` + ink TUI + daemon + notifier                                               |

**实现次序**：Phase 1 先抽出 `scanner` / `pathmap` / `exec` 三个纯模块并类化、配齐测试，使核心可测；`SshSession` 在 Phase 2 成形；`guard` 在 Phase 4 成形，供 `edit` / provision / 回滚复用。
