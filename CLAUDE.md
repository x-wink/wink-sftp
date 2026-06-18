# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 协作规则（必须遵守）

- 全程使用中文回复。
- 不要主动提交（`git commit`），仅在用户明确要求时才提交。
- 提交信息中不附加任何署名（不加 `Co-Authored-By`、`Generated with` 等）。
- **发版前必须更新 README 使用说明与相关文档**（README 选项/配置表/示例、`docs/ROADMAP.md`、`docs/ARCHITECTURE.md`、`CLAUDE.md`），确保文档与新功能同步，不留过时描述。

## Planning docs

- `docs/ROADMAP.md` — phased iteration plan (v1.1 止血 → v2.0 编排 → v3.0 运维支柱) and the locked product decisions.
- `docs/ARCHITECTURE.md` — target tech stack, layered architecture, the guarded-mutation safety mainline, and the command surface. Consult before structural changes.

Long-term vision: evolve from a one-shot deploy CLI into an agentless "SSH 快捷操作入口" for solo devs and AI agents, covering a standard-stack server's full lifecycle — provision (install/configure nginx/redis/mysql/docker/node/jdk/python via curated recipes) → deploy → status/logs → edit/service. Current code is still the MVP described below.

## Overview

`@xwink/sftp` (`wink-sftp`) is a CLI that deploys a local directory to a remote server over SFTP, with optional before/after remote commands. Published to npm as a single `wink-sftp` binary (ncc bundle).

Source is modular under `src/`:

- `index.ts` — Commander CLI layer：子命令体系（默认 `deploy` / `pull` / `ls`），flags → config，渲染结果（human 或 `--json`），定退出码。
- `lib.ts` — **库入口（编程式 API）**：不解析 argv，re-export `SshSession`/`withSession`、`run`/`runMany`/`runAuto`/`pull`/`ls`/`rollback`、`guard` 及全部结果/错误类型。`package.json` `main`/`types`/`exports` 指向它（ncc 单独打 `dist/lib`），`bin` 仍指 CLI 单文件 `dist/index.js`。
- `core.ts` — orchestration：`planDeploy`（dry-run）、`deploy`、`run`（单机）、`runMany`/`runAuto`（多机）、`rollback`、`pull`、`ls`；返回结构化 `DeployResult` / `MultiDeployResult` / `RollbackResult` / `PullResult` / `LsResult`。连接经 `withSession`（`session.ts`）。
- `session.ts` — `SshSession`（`open`/`exec`/`sftp` 缓存/`close`/`raw`）+ `withSession`：通用 SSH 会话抽象，部署/下载/浏览/guard 的共同底座，也是编程式 API。
- `guard.ts` — 守护式变更原语：`guard`（备份→应用→校验→reload→失败回滚，不抛错、收进 `GuardResult`）+ `backupRemote`/`restoreRemote`/`existsRemote`，依赖结构化 `ExecCapable`（`SshSession` 天然满足，便于 stub 测试）。
- `config.ts` — 配置加载与解析：zod schema（单一事实源）、JSON/YAML 双格式 `loadConfigFile`、`${ENV_VAR}` secrets 插值（`interpolateSecrets` + `.env`）、多环境 `deepMerge` 选择、多机 `hosts`、`resolveConfig`。
- `scanner.ts` — pure local FS scan + `.winksftpignore`（`loadIgnorePatterns`，gitignore 风格 glob）。
- `pathmap.ts` — pure path helpers (`resolveLocal` / `linuxPath` / `remoteIsDir` / `buildRemoteTarget` / `buildRemoteDir`).
- `exec.ts` — `shellQuote` (POSIX escaping) + `execCommand` (structured result).
- `pool.ts` — `mapPool` (受限并发 + 保序返回) 与 `DEFAULT_CONCURRENCY`，传输/建目录共用。
- `retry.ts` — `withRetry` (线性退避重试) 与 `DEFAULT_RETRIES`，单文件传输失败重试。
- `audit.ts` — 写操作审计：`appendAudit` / `formatAuditLine` / `defaultAuditPath`（`~/.wink-sftp/audit.log`）。
- `logger.ts` — leveled logging (human → stderr, `--json` → stdout) + `redact` (secret masking).
- `errors.ts` — typed errors carrying exit codes.

Unit tests live in `test/` (vitest)：纯模块逐一覆盖，`config.test.ts` 测 YAML/zod/secrets/多环境/深合并，`deploy.mock.test.ts` 与 `pull-ls.mock.test.ts` 用 `vi.mock('ssh2')` 桩测 `deploy`/`pull`/`ls` 编排（override/clear/重试/审计/增量/下载）。覆盖率门槛见 `vitest.config.ts`（CI 跑 `test:coverage`，排除 `index.ts`）。

`dev/e2e/`（`pnpm run e2e`，CI 一步）是**真**端到端：`server.ts` 进程内起一个 ssh2 SSH/SFTP 服务端（透传真实 fs + `/bin/sh` exec，仅测试用、不鉴权），`run.ts` spawn 真实 CLI 跑 deploy/pull/ls/密钥/密码/增量/忽略/多环境/备份/多机/回滚/失败退出码并断言。它覆盖 `vi.mock` 桩**绕不到的 commander 子命令参数解析**——正因如此 mock 测试漏掉过「子命令与根命令同名选项被 commander 归到父命令」的 bug。测试服务端/客户端密钥用 `node:crypto` 生成 **RSA PKCS1 PEM**（`generateTestKey`）——ssh2 的 `utils.generateKeyPairSync('ed25519')` 偶发产出它自己无法解析的 OpenSSH 私钥，会让 e2e 随机失败。

## Commands

```bash
pnpm dev            # tsx src/index.ts -c sftp.json（无需构建）
pnpm test           # vitest
pnpm run test:coverage  # vitest + v8 覆盖率门槛（CI 跑此项）
pnpm run e2e         # 端到端：进程内 ssh2 测试服务端 + spawn 真实 CLI（无需 Docker/系统 sshd）
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # oxlint --fix（lint:check 不修复，用于 CI）
pnpm run format     # oxfmt .（format:check 用于 CI）
pnpm run build      # tsc -emitDeclarationOnly + ncc 打两份：CLI → dist/index.js、库入口 → dist/lib/index.js
pnpm run release    # build + changelogen --release + git push（改版本/CHANGELOG/commit/打 tag，仅推 main，**不推 tag**）
pnpm run release:tag # 待 main 完整门禁绿后再推 tag（git push --follow-tags），由 tag 触发发布与 GitHub Release
```

**发布流程（必须分两步，先门禁后发版）**：① `pnpm run release` 本地改版本/CHANGELOG/提交/打 tag 并**只推 main**；② 等 `ci.yml`（lint/format/typecheck/test/build/e2e/commitlint，Node 22/24 + Node 18 冒烟）**全部绿**后，**先用 `/code-review` 审查待发版内容**（自上个稳定 tag 以来的 diff），问题修完、门禁重新绿了，再 `pnpm run release:tag` 推送 tag 触发 `release.yml` 发布 npm + GitHub Release。**绝不在 main 门禁通过前推 tag**——否则可能发布出门禁未过的版本；**也绝不跳过发布前 code-review**——`@xwink/sftp` 发到 npm 不可逆，机器门禁拦不住逻辑/设计问题，这是发布前最后一道闸。门禁没过的处理：真实失败就 fix-forward、把 tag 移到修复后的绿提交（`git tag -f` 后显式 `git push origin v<x>`）再发；flaky 则 `gh run rerun <id> --failed` 重跑、tag 不动直接发。

仓库使用 **pnpm**（`.npmrc` 设 `node-linker=hoisted`，利于 ncc 打包 ssh2 原生件）。构建已不再需要 `--openssl-legacy-provider`。

## Architecture

`run(options)` 解析配置后，分两路：`--dry-run` 走 `planDeploy`（纯本地计算、不连接），否则经 `withConnection` 新建一个**每次独立的** `ssh2.Client` 跑 `deploy`。`pull` / `ls` 同样复用 `withConnection`。三者分别返回 `DeployResult` / `PullResult` / `LsResult`，由 CLI 层渲染并据此定退出码。

编辑时须注意：

- **`execCommand` 仅以退出码判失败**（stderr 非空 ≠ 失败），失败抛类型化 `RemoteCommandError`。
- **所有拼入远程 shell 的路径/文件名必须经 `shellQuote`**（防注入），切勿裸插值。
- **`clear`**（`rm -rf ${remote}/*`）由 `assertSafeClearTarget` 护栏校验（拒绝空路径 / `/`）。
- **路径**：本地用 `resolveLocal`（相对 cwd）；远程一律 POSIX，用 `linuxPath` 构造，绝不用裸 `path.join`（`pull` 镜像用 `path.posix.relative`）。`remoteIsDir` / `buildRemoteTarget` 为纯函数且对空列表安全。
- **`ignoreHidden`** 只对相对 `local` 的路径段做 `startsWith('.')` 判定；`.winksftpignore` / `sftpOptions.ignore` 走 `ignore` 包的 gitignore 匹配。
- **增量**（`sftpOptions.incremental`）优先于 `override`：`sftp.stat` 取远程 size+mtime；上传后 `setRemoteMtime`（`sftp.utimes`）把远程 mtime 对齐为本地 mtime，`isUnchanged` 以 size 相同且 mtime **相等**判未变更（不依赖远程时钟）。存在性检查（override 跳过）也用 `statRemote`（不再用 exec shell `stat`）。
- **配置**：所有加载/校验/合并在 `config.ts`。zod 校验**文件**配置（编程式 `RunOption` 由 TS 保证；数值字段用 `z.coerce.number` 兼容 `${ENV_VAR}` 注入的字符串）；`${ENV_VAR}` 在 zod 校验前注入（环境变量优先于 `.env`），缺变量抛 `ConfigError`。**合并优先级（高→低）**：调用级开关 ＞ 显式参数 ＞ 选中环境覆盖 ＞ 文件 ＞ 默认；即文件为基底，`--env` 环境覆盖叠加其上，命令行/编程式**显式字段**（`pickConfigFields`：connect/local/remote/sftpOptions/environments）再 `deepMerge` 覆盖，undefined 不覆盖。只读命令（`ls`）以 `resolveConfig(opts, { requireLocal: false })` 跳过 `local` 必填校验。
- **文件级备份/回滚**（`sftpOptions.backup` / `--sftp-backup`）：部署前对**已存在**的远程目标 `backupRemote`（`cp -a` 到 `${remote}.wink-bak.<ts>`）；任一文件失败则 `restoreRemote` 回滚（`rm -rf` + `mv`），**回滚后不执行 afterRunCommand**；成功保留快照。`rollback`（`--rollback`）在父目录按 `${base}.wink-bak.` 前缀找时间戳最大者还原。回滚仅文件级，不撤销钩子副作用。
- **多机**（`hosts` 数组 / `--hosts`）：`runMany` 每台一个独立 `SshSession`；continue（默认，`mapPool` 受限并发跑完汇总）/ `failFast`（顺序、首台失败即停）。连接/配置错误按主机捕获进 `HostDeployResult.error`，不互相影响。`runAuto` 据 `hosts` 是否非空分派单机/多机；`run`/`runMany` 都用 `collectHosts`（options.hosts 优先，否则配置文件 hosts）。
- **退出码**：config 2 / connection 3 / remote-command 4 / transfer 5 / 通用 1。
- 登录方式：密码或密钥（`connect.privateKey` / `passphrase` / `agent`）二选一，`resolveConfig` 校验至少其一；CLI `--connect-private-key` 传文件路径，由 `index.ts` 读为内容。

## CLI ↔ config mapping

`src/index.ts` 把 Commander 的扁平选项映射成嵌套的 `RunOption`/`SftpOption`（`--connect-host` → `connect.host`，`--sftp-flat` → `sftpOptions.flat`）。连接与公共开关由 `addConnectionOptions` 给各子命令复用，`buildBase` 统一构造 connect/调用级开关。**`deploy` 必须是 `program.command('deploy', { isDefault: true })` 独立子命令，绝不能把这些选项挂在 `program` 根命令上**——否则连接选项与 `pull`/`ls` 子命令同名，commander 会把同名选项归到父命令，导致子命令实际收到 `undefined`（`vi.mock` 桩绕过 commander，测不出，靠 `pnpm run e2e` 守护）。`isDefault` 保证无子命令时 `wink-sftp -c x.json` 仍走 deploy（向后兼容）。`mode` 按八进制、`port` 按数值解析；`--json`/`--dry-run`/`--debug`/`--env` 是调用级开关。配置不再「整体覆盖」：`-c` 文件为基底，显式 CLI 字段 `deepMerge` 覆盖其上（见上「配置」合并优先级），故 `-c sftp.json --remote /x` 只改 `remote`。审计同属调用级覆盖：CLI `--no-audit`（`options.audit === false`）与 `--audit-log` 优先于配置文件的 `audit`/`auditLog`。三个 action 的错误处理统一收口在 `execute()`（配置构造放进其回调，私钥读取等异常一并兜底）。新增选项时须同时更新：Commander 的 `.option(...)`、`buildBase`/各 action 映射、`core.ts` 的接口、`config.ts` 的 zod schema。

> commander 15 不允许多字符短 flag：password / clear / before / after 均为长 flag（`--connect-password` / `--sftp-clear` / `--before-run-command` / `--after-run-command`）；`-h` 用作 host，帮助走 `--help`。

## Conventions

- **Lint**：oxlint（`.oxlintrc.json`，correctness=error；启用 `consistent-type-imports`——type 必须 `import type`）。**Format**：oxfmt（`.oxfmtrc.json`）：4 空格、单引号、无分号、行宽 120。**oxfmt 不止格式化代码，也校验 Markdown**（`format:check` 会扫 `.md`，如表格列对齐）——改文档后照样要过 `pnpm run format`。
- TypeScript 6 strict，`moduleResolution: bundler`。包管理器 pnpm。
- 无 husky/lint-staged；提交信息由 CI 的 `commitlint` job 校验。遵循 Conventional Commits，**type 用标准常用集**（`.commitlintrc` 的 `type-enum`：`build/chore/ci/docs/feat/fix/perf/refactor/revert/style/test`，即 `@commitlint/config-conventional` 默认；放宽了中文 subject 与 header 长度）。CHANGELOG 由 changelogen 生成。提交信息、CLI 文案与文档均用中文。
- **CI**（`.github/workflows/ci.yml`）：lint/format/typecheck/test/build 跑 Node 22/24（pnpm 11 需 22+）+ Node 18 运行时下限冒烟 + commitlint。**发布**（`release.yml`）：推送 `v*` tag 触发，`npm publish` 经 **OIDC 可信发布**（无 token，自动生成 provenance；需先在 npmjs.com 为本包配置 GitHub Actions 可信发布者，仓库须公开）。
