# 贡献指南

感谢你愿意为 `@xwink/sftp`（`wink-sftp`）出力！本项目用中文协作，提交信息、CLI 文案与文档均用中文。

## 开发环境

仓库使用 **pnpm**（`.npmrc` 设 `node-linker=hoisted`，便于 ncc 打包 ssh2 原生件）。需要 Node ≥ 18（开发与 CI 主矩阵为 Node 22/24，pnpm 11 需 22+）。

```bash
pnpm install
pnpm dev            # tsx 直接跑 src/index.ts -c sftp.json（无需构建）
```

## 常用命令

```bash
pnpm test           # vitest 单元测试
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # oxlint --fix（lint:check 不修复，用于 CI）
pnpm run format     # oxfmt .（format:check 用于 CI）
pnpm run build      # tsc -emitDeclarationOnly && ncc build → dist/
```

提 PR 前请确保本地通过：`pnpm run lint:check && pnpm run format:check && pnpm run typecheck && pnpm test`。

## 代码规范

- **Lint**：oxlint（`.oxlintrc.json`，correctness=error；`consistent-type-imports`——类型必须 `import type`）。
- **Format**：oxfmt（`.oxfmtrc.json`）：4 空格、单引号、无分号、行宽 120、`endOfLine: lf`。
- TypeScript 6 strict，`moduleResolution: bundler`。
- 行为变更必须配套单元测试；纯模块（`scanner` / `pathmap` / `exec` / `pool` / `retry` / `audit`）优先以纯函数形式编写并测试。
- 所有拼入远程 shell 的路径/文件名必须经 `shellQuote`，绝不裸插值。

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，由 CI 的 `commitlint` job 校验，CHANGELOG 由 changelogen 生成。常用类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci`。

```
feat(core): 传输与建目录引入并发池

正文用中文说明动机与影响。破坏性/行为变更请在正文醒目标注。
```

> 本仓库**不附加任何署名**（不加 `Co-Authored-By`、`Generated with` 等）。

## 分支与 PR

1. 从 `main` 切出特性分支（如 `feat/key-login`）。
2. 小步提交，保持每个 commit 可独立通过 CI 门禁。
3. PR 描述清楚动机、改动点、测试方式；涉及行为变更请说明迁移影响。
4. CI（`.github/workflows/ci.yml`）会跑 lint/format/typecheck/test/build + Node 18 运行时下限冒烟 + commitlint，全绿方可合并。

## 发布

维护者用 `pnpm run release`（changelogen 改版本/CHANGELOG/commit/tag/push）；推送 `v*` tag 触发 `release.yml`，经 npm **OIDC 可信发布**（无 token，自动 provenance）。普通贡献者无需关心发布。

## 路线图

迭代方向见 [docs/ROADMAP.md](./docs/ROADMAP.md)，目标架构与安全主线见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。认领工作前建议先开 Issue 对齐。
