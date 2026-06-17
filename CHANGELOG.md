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
