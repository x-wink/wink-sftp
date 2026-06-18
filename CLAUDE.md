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
- `core.ts` — orchestration：`planDeploy`（dry-run）、`deploy`、`run`、`pull`、`ls`，通用连接运行器 `withConnection`；返回结构化 `DeployResult` / `PullResult` / `LsResult`。
- `config.ts` — 配置加载与解析：zod schema（单一事实源）、JSON/YAML 双格式 `loadConfigFile`、`${ENV_VAR}` secrets 插值（`interpolateSecrets` + `.env`）、多环境 `deepMerge` 选择、`resolveConfig`。
- `scanner.ts` — pure local FS scan + `.winksftpignore`（`loadIgnorePatterns`，gitignore 风格 glob）。
- `pathmap.ts` — pure path helpers (`resolveLocal` / `linuxPath` / `remoteIsDir` / `buildRemoteTarget` / `buildRemoteDir`).
- `exec.ts` — `shellQuote` (POSIX escaping) + `execCommand` (structured result).
- `pool.ts` — `mapPool` (受限并发 + 保序返回) 与 `DEFAULT_CONCURRENCY`，传输/建目录共用。
- `retry.ts` — `withRetry` (线性退避重试) 与 `DEFAULT_RETRIES`，单文件传输失败重试。
- `audit.ts` — 写操作审计：`appendAudit` / `formatAuditLine` / `defaultAuditPath`（`~/.wink-sftp/audit.log`）。
- `logger.ts` — leveled logging (human → stderr, `--json` → stdout) + `redact` (secret masking).
- `errors.ts` — typed errors carrying exit codes.

Unit tests live in `test/` (vitest)：纯模块逐一覆盖，`config.test.ts` 测 YAML/zod/secrets/多环境，`deploy.mock.test.ts` 与 `pull-ls.mock.test.ts` 用 `vi.mock('ssh2')` 桩端到端测 `deploy`/`pull`/`ls` 编排（override/clear/重试/审计/增量/下载）。覆盖率门槛见 `vitest.config.ts`（CI 跑 `test:coverage`，排除 `index.ts`）。

## Commands

```bash
pnpm dev            # tsx src/index.ts -c sftp.json（无需构建）
pnpm test           # vitest
pnpm run test:coverage  # vitest + v8 覆盖率门槛（CI 跑此项）
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # oxlint --fix（lint:check 不修复，用于 CI）
pnpm run format     # oxfmt .（format:check 用于 CI）
pnpm run build      # tsc -emitDeclarationOnly && ncc build → dist/
pnpm run release    # build + changelogen --release --push（改版本/CHANGELOG/commit/tag/push）；发布与 GitHub Release 由 tag 触发 CI 完成
```

仓库使用 **pnpm**（`.npmrc` 设 `node-linker=hoisted`，利于 ncc 打包 ssh2 原生件）。构建已不再需要 `--openssl-legacy-provider`。

## Architecture

`run(options)` 解析配置后，分两路：`--dry-run` 走 `planDeploy`（纯本地计算、不连接），否则经 `withConnection` 新建一个**每次独立的** `ssh2.Client` 跑 `deploy`。`pull` / `ls` 同样复用 `withConnection`。三者分别返回 `DeployResult` / `PullResult` / `LsResult`，由 CLI 层渲染并据此定退出码。

编辑时须注意：

- **`execCommand` 仅以退出码判失败**（stderr 非空 ≠ 失败），失败抛类型化 `RemoteCommandError`。
- **所有拼入远程 shell 的路径/文件名必须经 `shellQuote`**（防注入），切勿裸插值。
- **`clear`**（`rm -rf ${remote}/*`）由 `assertSafeClearTarget` 护栏校验（拒绝空路径 / `/`）。
- **路径**：本地用 `resolveLocal`（相对 cwd）；远程一律 POSIX，用 `linuxPath` 构造，绝不用裸 `path.join`（`pull` 镜像用 `path.posix.relative`）。`remoteIsDir` / `buildRemoteTarget` 为纯函数且对空列表安全。
- **`ignoreHidden`** 只对相对 `local` 的路径段做 `startsWith('.')` 判定；`.winksftpignore` / `sftpOptions.ignore` 走 `ignore` 包的 gitignore 匹配。
- **增量**（`sftpOptions.incremental`）优先于 `override`：`sftp.stat` 取远程 size+mtime，未变更则跳过。
- **配置**：所有加载/校验/合并在 `config.ts`。zod 校验**文件**配置（编程式 `RunOption` 由 TS 保证）；`${ENV_VAR}` 在 zod 校验前注入（环境变量优先于 `.env`），缺变量抛 `ConfigError`；多环境经 `--env` + `deepMerge`。只读命令（`ls`）以 `resolveConfig(opts, { requireLocal: false })` 跳过 `local` 必填校验。
- **退出码**：config 2 / connection 3 / remote-command 4 / transfer 5 / 通用 1。
- 登录方式：密码或密钥（`connect.privateKey` / `passphrase` / `agent`）二选一，`resolveConfig` 校验至少其一；CLI `--connect-private-key` 传文件路径，由 `index.ts` 读为内容。

## CLI ↔ config mapping

`src/index.ts` 把 Commander 的扁平选项映射成嵌套的 `RunOption`/`SftpOption`（`--connect-host` → `connect.host`，`--sftp-flat` → `sftpOptions.flat`）。连接与公共开关由 `addConnectionOptions` 给各子命令复用，`buildBase` 统一构造 connect/调用级开关。`mode` 按八进制、`port` 按数值解析；`--json`/`--dry-run`/`--debug`/`--env` 是调用级开关（叠加在 `-c` 配置文件之上）。审计同属调用级覆盖：CLI `--no-audit`（`options.audit === false`）与 `--audit-log` 优先于配置文件的 `audit`/`auditLog`。新增选项时须同时更新：Commander 的 `.option(...)`、`buildBase`/各 action 映射、`core.ts` 的接口、`config.ts` 的 zod schema。

> commander 15 不允许多字符短 flag：password / clear / before / after 均为长 flag（`--connect-password` / `--sftp-clear` / `--before-run-command` / `--after-run-command`）；`-h` 用作 host，帮助走 `--help`。

## Conventions

- **Lint**：oxlint（`.oxlintrc.json`，correctness=error；启用 `consistent-type-imports`——type 必须 `import type`）。**Format**：oxfmt（`.oxfmtrc.json`）：4 空格、单引号、无分号、行宽 120。
- TypeScript 6 strict，`moduleResolution: bundler`。包管理器 pnpm。
- 无 husky/lint-staged；提交信息由 CI 的 `commitlint` job 校验。遵循 Conventional Commits，CHANGELOG 由 changelogen 生成。提交信息、CLI 文案与文档均用中文。
- **CI**（`.github/workflows/ci.yml`）：lint/format/typecheck/test/build 跑 Node 22/24（pnpm 11 需 22+）+ Node 18 运行时下限冒烟 + commitlint。**发布**（`release.yml`）：推送 `v*` tag 触发，`npm publish` 经 **OIDC 可信发布**（无 token，自动生成 provenance；需先在 npmjs.com 为本包配置 GitHub Actions 可信发布者，仓库须公开）。
