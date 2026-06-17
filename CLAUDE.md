# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 协作规则（必须遵守）

- 全程使用中文回复。
- 不要主动提交（`git commit`），仅在用户明确要求时才提交。
- 提交信息中不附加任何署名（不加 `Co-Authored-By`、`Generated with` 等）。

## Planning docs

- `ROADMAP.md` — phased iteration plan (v1.1 止血 → v2.0 编排 → v3.0 运维支柱) and the locked product decisions.
- `ARCHITECTURE.md` — target tech stack, layered architecture, the guarded-mutation safety mainline, and the command surface. Consult before structural changes.

Long-term vision: evolve from a one-shot deploy CLI into an agentless "SSH 快捷操作入口" for solo devs and AI agents, covering a standard-stack server's full lifecycle — provision (install/configure nginx/redis/mysql/docker/node/jdk/python via curated recipes) → deploy → status/logs → edit/service. Current code is still the MVP described below.

## Overview

`@xwink/sftp` (`wink-sftp`) is a CLI tool that deploys local files to a remote server over SFTP. It is published to npm and exposes a single `wink-sftp` binary. The codebase is two TypeScript files; all logic lives in `src/core.ts`, and `src/index.ts` is only the Commander argument layer.

## Commands

```bash
# Run locally against a config file (uses ts-node, no build)
npm run dev                  # == ts-node src/index.ts -c sftp.json

# Lint (auto-fix) and format
npm run lint
npm run prettier

# Build the publishable bundle into dist/ (ncc-based, single index.js)
npm run build

# Release: build + bump version + git tag/push + npm publish
npm run release
```

There is no test suite. To exercise the tool manually, create an `sftp.json` (see README for the schema) and run `npm run dev`, or invoke the CLI directly: `ts-node src/index.ts -l ./dist -r /apps/myapp -h HOST -p 22 -u root -pwd PASS`.

Note: `npm run build` sets `NODE_OPTIONS=--openssl-legacy-provider` using Windows `set` syntax — on macOS/Linux prefix the env var manually (`NODE_OPTIONS=--openssl-legacy-provider tsc -emitDeclarationOnly && ncc build ...`).

## Architecture

The full execution flow lives in `src/core.ts` and runs against a single module-level `ssh2` `Client` instance:

1. **`run(options)`** — entry point. Resolves config, opens the SSH connection, and wires up `ready`/`error`/`timeout`/`close` handlers. On `ready` it calls `sftp()` then tears the connection down.
2. **`resolveConfig(options)`** — merges CLI options with an optional JSON config file (`-c`). When a config file is given it **replaces** CLI args entirely (the file wins). Validates that `connect.{host,port,username,password}`, `local`, and `remote` are all present, throwing otherwise. The top-level `debug` flag becomes the default for `sftpOptions.debug`.
3. **`scan(dir, ignoreHidden, excludes)`** — recursively walks the local `local` directory, returning `{ dirs, files }` as absolute paths. Honors `excludes` (full-path match) and `ignoreHidden` (skips any path segment containing `.`).
4. **`sftp(local, remote, options)`** — the transfer core. Scans files, runs `beforeRunCommand`, optionally clears the remote dir (`clear`), recreates the directory tree via remote `mkdir -p` (unless `flat`), then `fastPut`s each file. `override` controls whether existing remote files (detected with a remote `stat`) are overwritten. Finally runs `afterRunCommand`.
5. **`exec(command, debug)`** — promisified `client.exec`; rejects on non-zero exit code or any stderr output. Used for all remote shell operations (`mkdir`, `rm`, `stat`, and the user's before/after commands).

Key behaviors to keep in mind when editing:
- **Remote-is-dir heuristic** (`remoteIsDir`): the remote path is treated as a directory if there are >1 files, or the single file has an extension while `remote` does not. This drives whether per-file target paths are built.
- **Path handling**: local paths use `resolvePath` (relative to `process.cwd()`); remote paths must always be POSIX, built with `linuxPath` which forces `/` separators. Never use raw `path.join` for remote targets.
- `clear` issues `rm -rf ${remote}/*` on the remote — destructive; guard any changes here carefully.
- Key-based SSH auth is not yet supported (see the `TODO` in `resolveConfig`); only password auth works.

## CLI ↔ config mapping

`src/index.ts` flattens Commander's flat options into the nested `RunOption`/`SftpOption` shape that `core.ts` expects (e.g. `--connect-host` → `connect.host`, `--sftp-flat` → `sftpOptions.flat`). When adding an option you must update both the Commander `.option(...)` declarations and this mapping object, plus the `SftpOption`/`RunOption` interfaces in `core.ts`.

## Conventions

- ESLint extends `@xwink` (shared config); Prettier enforced. Husky + lint-staged run lint/prettier on commit.
- Commits follow Conventional Commits (commitlint + `@commitlint/config-conventional`); `CHANGELOG.md` is generated from history. Commit/CLI messages and docs are written in Chinese.
