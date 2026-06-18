## v2.0.0

[compare changes](https://github.com/x-wink/wink-sftp/compare/v1.3.2...v2.0.0)

### 🚀 Enhancements

- 新增 SshSession 编程式 API、guard 守护式变更原语与库入口 ([6c1f013](https://github.com/x-wink/wink-sftp/commit/6c1f013))
- 部署文件级备份与失败自动回滚 ([2415097](https://github.com/x-wink/wink-sftp/commit/2415097))
- 多机并行部署（hosts 数组 + 失败策略 + 主机并发） ([5523faa](https://github.com/x-wink/wink-sftp/commit/5523faa))
- 新增手动回滚命令 --rollback（恢复到最近快照） ([db06081](https://github.com/x-wink/wink-sftp/commit/db06081))

### 📖 Documentation

- CLAUDE.md 补充 oxfmt 校验 Markdown 与 commitlint 标准 type 约定 ([5c43147](https://github.com/x-wink/wink-sftp/commit/5c43147))
- 同步 v2.0 编排能力（多机/备份回滚/编程式 API）至 README/ROADMAP/CLAUDE ([4a8ec57](https://github.com/x-wink/wink-sftp/commit/4a8ec57))

### 🏡 Chore

- Commitlint type-enum 改用标准常用类型，格式化 ROADMAP 表格 ([20eb29e](https://github.com/x-wink/wink-sftp/commit/20eb29e))

### ✅ Tests

- **e2e:** 增多机+文件级备份场景，测试服务端改用 RSA PKCS1 密钥消除偶发失败 ([bdbec03](https://github.com/x-wink/wink-sftp/commit/bdbec03))

### 🤖 CI

- 升级 GitHub Actions 至 v6（checkout/setup-node/pnpm），消除 Node 20 弃用告警 ([9ca611a](https://github.com/x-wink/wink-sftp/commit/9ca611a))

### ❤️ Contributors

- Xwink <1041367524@qq.com>

## v1.3.2

[compare changes](https://github.com/x-wink/wink-sftp/compare/v1.3.1...v1.3.2)

### 📖 Documentation

- Skill 补齐至 v1.3.1 并按子命令拆分 deploy/pull ([12f6359](https://github.com/x-wink/wink-sftp/commit/12f6359))

### ❤️ Contributors

- Xwink <1041367524@qq.com>

## v1.3.1

[compare changes](https://github.com/x-wink/wink-sftp/compare/v1.3.0...v1.3.1)

### 🩹 Fixes

- **cli:** 修复子命令连接选项失效与忽略目录残留，新增端到端测试 ([62443ef](https://github.com/x-wink/wink-sftp/commit/62443ef))

### 💅 Refactors

- **core:** 重命名增量分支局部变量避免遮蔽外层 remote ([55fc72f](https://github.com/x-wink/wink-sftp/commit/55fc72f))

### ❤️ Contributors

- Xwink <1041367524@qq.com>

## v1.3.0

[compare changes](https://github.com/x-wink/wink-sftp/compare/v1.2.0...v1.3.0)

### 🚀 Enhancements

- **config:** Zod 校验 + JSON/YAML 双格式配置加载 ([0039e42](https://github.com/x-wink/wink-sftp/commit/0039e42))
- **config:** 支持 ${ENV_VAR} secrets 引用与 .env 注入 ([a9a76e0](https://github.com/x-wink/wink-sftp/commit/a9a76e0))
- **config:** 多环境配置 --env 与深合并 ([c05052e](https://github.com/x-wink/wink-sftp/commit/c05052e))
- **scanner:** 支持 .winksftpignore（gitignore 风格 glob 忽略） ([941e2a9](https://github.com/x-wink/wink-sftp/commit/941e2a9))
- **deploy:** 增量传输（size+mtime 比对） ([17faab2](https://github.com/x-wink/wink-sftp/commit/17faab2))
- **cli:** 新增 pull 下载与 ls 远程浏览子命令 ([063dd4d](https://github.com/x-wink/wink-sftp/commit/063dd4d))

### 🩹 Fixes

- 处理代码审查发现并统一配置深度合并 ([33c0450](https://github.com/x-wink/wink-sftp/commit/33c0450))

### 📖 Documentation

- 同步 v1.3 提效能力文档 ([733792d](https://github.com/x-wink/wink-sftp/commit/733792d))

### ❤️ Contributors

- Xwink <1041367524@qq.com>

## v1.2.0

[compare changes](https://github.com/x-wink/wink-sftp/compare/v1.1.0...v1.2.0)

### 🚀 Enhancements

- **core:** 传输与建目录引入并发池 ([7d7a66c](https://github.com/x-wink/wink-sftp/commit/7d7a66c))
- **core:** 单文件传输失败自动重试 ([da56c27](https://github.com/x-wink/wink-sftp/commit/da56c27))
- **core:** Flat 同名覆盖告警与传输进度日志 ([fb492b6](https://github.com/x-wink/wink-sftp/commit/fb492b6))
- **core:** 支持 SSH 密钥登录 ([9b7fc89](https://github.com/x-wink/wink-sftp/commit/9b7fc89))
- **core:** 写操作审计日志 ([0b4e749](https://github.com/x-wink/wink-sftp/commit/0b4e749))
- **skill:** 新增 deploy Skill ([e8f9617](https://github.com/x-wink/wink-sftp/commit/e8f9617))
- **skill:** Deploy Skill 随 npm 包发布并补文档 ([8cdb2fc](https://github.com/x-wink/wink-sftp/commit/8cdb2fc))

### 🩹 Fixes

- **core:** BeforeRunCommand 在扫描前执行 ([36daaa4](https://github.com/x-wink/wink-sftp/commit/36daaa4))
- **core:** 审计开关以调用级优先于配置文件 ([87eb513](https://github.com/x-wink/wink-sftp/commit/87eb513))

### 📖 Documentation

- 路线图增加进度追踪 ([d5708ac](https://github.com/x-wink/wink-sftp/commit/d5708ac))
- 补充 LICENSE 与贡献者文档 ([95ad18d](https://github.com/x-wink/wink-sftp/commit/95ad18d))
- 标记 Phase 2 全部条目落地待发布 ([3d0332e](https://github.com/x-wink/wink-sftp/commit/3d0332e))
- 增加发版前更新文档的协作约定 ([2abee9b](https://github.com/x-wink/wink-sftp/commit/2abee9b))

### 🏡 Chore

- 规范 package.json repository 字段 ([e30c26d](https://github.com/x-wink/wink-sftp/commit/e30c26d))

### ✅ Tests

- 补 SSH/SFTP mock 与覆盖率门槛 ([8c9d2fd](https://github.com/x-wink/wink-sftp/commit/8c9d2fd))

### ❤️ Contributors

- 向文可 <1041367524@qq.com>
- Xwink <1041367524@qq.com>

## v1.1.0

[compare changes](https://github.com/x-wink/wink-sftp/compare/v1.0.4...v1.1.0)

> ⚠️ 本次包含安全与正确性修复，会改变若干既有行为；升级后请验证你的部署流程。

### ⚠️ 破坏性变更

- **失败现在返回非零退出码**：配置错误(2)/连接失败(3)/远程命令失败(4)/文件传输失败(5)，便于 CI 与脚本判断成败（旧版始终返回 0，可能把失败误报为成功）。
- **远程命令的 stderr 不再判为失败**：仅以退出码为准（旧版只要 stderr 有输出就报错，会把正常的告警误判为失败）。
- **`ignoreHidden` 判定收窄**：只对 `local` 之下的相对路径段做「以 `.` 开头」判断；旧版检查整个绝对路径且匹配任意含点名字，会在项目路径含 `.`（如 `/Users/me/my.app`）时误跳整棵目录树。
- **CLI 短 flag 调整**：因升级 commander 15（不再支持多字符短 flag），移除 `-pwd` / `-cls` / `-brc` / `-arc`，改用长 flag `--connect-password` / `--sftp-clear` / `--before-run-command` / `--after-run-command`；`-h` 用作 host，查看帮助改用 `--help`。

### 🚀 新增

- **`--dry-run`**：预演模式，打印将执行的动作但不建立连接、不落地。
- **`--json`**：结构化结果输出到 stdout（人类日志走 stderr），便于脚本与 AI agent 解析。

### 🩹 修复

- 本地文件列表为空时不再因 `path.extname(files[0])` 崩溃。
- CLI 的 `--connect-port` / `--sftp-mode` 现按数值 / 八进制解析（旧版作为字符串透传）。

### 🔒 安全

- 远程 shell 命令注入修复：所有拼入远程 shell 的路径 / 文件名统一单引号转义。
- debug 日志脱敏：打印配置时对 `password` / `passphrase` 等敏感字段打码。
- `clear` 路径护栏：拒绝清空空路径 / `/` 等危险目标。

### 🏡 工程化与工具链

- 抽出 `scanner` / `pathmap` / `exec` 纯模块；引入 vitest 单测与 GitHub Actions CI。
- oxlint/oxfmt 取代 eslint/prettier（4 空格 / 单引号 / 无分号、`import type` 显式）；pnpm + TypeScript 6 + tsx。
- changelogen 取代 conventional-changelog-cli 与 bumpp（版本递增 / CHANGELOG / GitHub Release 一条龙）；移除 husky/lint-staged（提交信息改由 CI commitlint 校验）。
- 推送 `v*` tag 经 OIDC 可信发布到 npm（自动 provenance 溯源），并据 CHANGELOG 创建 GitHub Release。

## <small>1.0.4 (2024-01-03)</small>

- feat: 新增传输前后执行命令 ([6d7c24d](https://github.com/x-wink/wink-sftp/commit/6d7c24d))
- conf: release script ([98a41a9](https://github.com/x-wink/wink-sftp/commit/98a41a9))

## <small>1.0.3 (2023-12-13)</small>

- doc: update package.json ([5543152](https://github.com/x-wink/wink-sftp/commit/5543152))
- doc: update readme ([8d02617](https://github.com/x-wink/wink-sftp/commit/8d02617))
- doc: update readme ([6d83307](https://github.com/x-wink/wink-sftp/commit/6d83307))
- perf: 使用配置文件时将顶层debug字段值作为sftpOptions的debug字段默认值 ([ae7f0f0](https://github.com/x-wink/wink-sftp/commit/ae7f0f0))
- fix: 修复本地目录中没文件夹远程文件夹又不存在时不自动创建远程目录的问题 ([c342c4a](https://github.com/x-wink/wink-sftp/commit/c342c4a))
- chore: sync template updates ([2f2a293](https://github.com/x-wink/wink-sftp/commit/2f2a293))
- conf: publish files ([31b61a2](https://github.com/x-wink/wink-sftp/commit/31b61a2))

## [1.0.2](https://github.com/x-wink/wink-sftp/compare/v1.0.1...v1.0.2) (2023-08-22)

### Features

- 新增配置`ignoreHidden`是否忽略隐藏文件夹，默认`true` ([1b2eb68](https://github.com/x-wink/wink-sftp/commit/1b2eb6806cd116c1326a184d8a1e2250b9928354))

## [1.0.1](https://github.com/x-wink/wink-sftp/compare/v1.0.0...v1.0.1) (2023-05-29)

### Features

- 新增`文件mode`选项`-m --ftp-mode`，默认`0o777` ([f58958f](https://github.com/x-wink/wink-sftp/commit/f58958fac4525bf2d54da2276715ded1a289c716))

# [1.0.0](https://github.com/x-wink/wink-sftp/compare/v0.0.1...v1.0.0) (2023-05-26)

### Features

- SFTP 命令行工具 ([ad3d8f7](https://github.com/x-wink/wink-sftp/commit/ad3d8f734195266b2cc4077b539f8bda53057e73))
