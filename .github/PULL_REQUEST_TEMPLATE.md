<!-- 标题请遵循 Conventional Commits，如 feat(core): xxx / fix: xxx -->

## 动机

<!-- 这个 PR 解决什么问题？关联的 Issue（如 Closes #1） -->

## 改动点

<!-- 简述主要变更；涉及 CLI 选项时，确认已同步更新 Commander .option / index.ts 映射 / core.ts 接口 -->

## 行为变更

<!-- 有无破坏性 / 行为变更？如有，说明迁移影响（会在 CHANGELOG 醒目标注） -->

- [ ] 无行为变更
- [ ] 有行为变更（已在上方说明）

## 自检清单

- [ ] 已加/更新单元测试
- [ ] 本地通过 `pnpm run lint:check && pnpm run format:check && pnpm run typecheck && pnpm test`
- [ ] 提交信息符合 Conventional Commits，且未附加任何署名
- [ ] 远程 shell 拼接均经 `shellQuote`（如涉及）
