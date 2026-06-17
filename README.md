# 😉 wink-sftp

> 一个配置驱动的命令行工具，通过 SFTP 把本地文件一键部署到远程服务器，并支持在传输前后执行远程命令。

![名称](https://img.shields.io/github/package-json/name/x-wink/wink-sftp?style=for-the-badge)
![版本](https://img.shields.io/github/package-json/v/x-wink/wink-sftp?style=for-the-badge&filename=package.json)
![关键字](https://img.shields.io/github/package-json/keywords/x-wink/wink-sftp?style=for-the-badge)
![许可](https://img.shields.io/github/package-json/license/x-wink/wink-sftp?style=for-the-badge)

![下载量](https://img.shields.io/npm/dt/%40xwink/sftp?style=for-the-badge&logo=npm)
![大小](https://img.shields.io/bundlephobia/minzip/%40xwink/sftp?style=for-the-badge&logo=npm)

![收藏](https://img.shields.io/github/stars/x-wink/wink-sftp?style=flat-square&logo=github)
![问题](https://img.shields.io/github/issues/x-wink/wink-sftp?style=flat-square&logo=github)
![请求](https://img.shields.io/github/issues-pr/x-wink/wink-sftp?style=flat-square&logo=github)

---

## 这是什么

`wink-sftp`（npm 包名 `@xwink/sftp`）是一个零运行时配置的部署 CLI：把本地某个目录（通常是构建产物 `dist/`）通过 SFTP 全量上传到远程服务器，并可在传输前后执行远程命令（停服、解压、重启等）。

适用场景：个人项目 / 小团队把前端或 Node 应用一键发到自己的服务器，纳入 `npm script` 或 CI，无需在服务器上安装任何 agent。

- 一条命令或一个 JSON 配置即可完成部署
- 提供 `--dry-run` 预演与 `--json` 结构化输出，便于脚本与 AI agent 安全调用
- 失败返回非零退出码，可靠地融入 CI

## ✨ 特性

- 🚀 一条命令把本地目录递归部署到远程
- 📄 JSON 配置文件，便于纳入版本管理与多项目复用
- 🪝 传输前后执行远程命令（停服 / 重启 / 解压…）
- 🧹 可选清空远程目录、覆盖已有文件、扁平化目录结构
- 🙈 自动跳过隐藏文件，支持按路径排除
- 🔍 `--dry-run` 预演（不连接、不落地）与 `--json` 机器可读输出
- 🔢 分类退出码，失败可被脚本 / CI 捕获
- 🔒 远程命令参数自动转义防注入、调试日志对密码脱敏、`clear` 危险路径护栏

## 📥 安装

```bash
# 作为项目开发依赖
pnpm add -D @xwink/sftp
npm install -D @xwink/sftp

# 或全局 / 临时使用
npx wink-sftp --help
```

> 需要 Node.js >= 18。

## 🚀 快速开始

最少传入六项即可完成一次部署——本地路径、远程路径、主机、端口、用户名、密码：

```bash
npx wink-sftp -l ./dist -r /apps/myapp -h 192.168.1.10 -p 22 -u root --connect-password 123456
```

> 提示：`-h` 在本工具中表示**远程主机**；查看帮助请用 `--help`。

更推荐把参数写进配置文件（见下），命令里就只剩一个 `-c`。

## 📦 使用配置文件（推荐）

将参数写入 `sftp.json` 并纳入版本管理，部署时只需指定路径：

```bash
npx wink-sftp -c ./sftp.json
```

`sftp.json` 示例：

```json
{
    "local": "./dist",
    "remote": "/apps/myapp",
    "debug": false,
    "connect": {
        "host": "192.168.1.10",
        "port": 22,
        "username": "root",
        "password": "123456"
    },
    "sftpOptions": {
        "excludes": [],
        "flat": false,
        "clear": false,
        "override": false,
        "ignoreHidden": true,
        "beforeRunCommand": "",
        "afterRunCommand": ""
    }
}
```

> - 指定 `-c` 时，配置文件会**整体覆盖**命令行的连接/路径参数；只有 `--json`、`--dry-run`、`--debug` 这类调用级开关仍以命令行为准。
> - 顶层 `debug` 会作为 `sftpOptions.debug` 的默认值。
> - 含密码的配置文件请加入 `.gitignore`，或改用环境变量 / CI 密钥注入，避免提交明文。

### 配置项

| 字段                           | 类型     | 默认    | 说明                                           |
| ------------------------------ | -------- | ------- | ---------------------------------------------- |
| `local`                        | string   | —       | 本地路径（必填）                               |
| `remote`                       | string   | —       | 远程路径（必填）                               |
| `debug`                        | boolean  | `false` | 输出调试日志（走 stderr）                      |
| `connect.host`                 | string   | —       | 远程服务器地址（必填）                         |
| `connect.port`                 | number   | —       | 远程服务器端口（必填）                         |
| `connect.username`             | string   | —       | 用户名（必填）                                 |
| `connect.password`             | string   | —       | 密码（必填，当前仅支持密码登录）               |
| `sftpOptions.excludes`         | string[] | `[]`    | 要排除的本地目录，目前仅支持全字匹配           |
| `sftpOptions.flat`             | boolean  | `false` | 扁平化目录：任意深度的文件都直接传到远程目录下 |
| `sftpOptions.clear`            | boolean  | `false` | 传输前清空远程目录（高危，见安全须知）         |
| `sftpOptions.override`         | boolean  | `false` | 覆盖远程已存在的同名文件                       |
| `sftpOptions.ignoreHidden`     | boolean  | `true`  | 忽略隐藏文件/目录（以 `.` 开头的路径段）       |
| `sftpOptions.mode`             | number   | `0o777` | 远程文件权限 mode                              |
| `sftpOptions.beforeRunCommand` | string   | —       | 传输开始前执行的远程命令                       |
| `sftpOptions.afterRunCommand`  | string   | —       | 传输完成后执行的远程命令                       |

## ⌨️ 命令行选项

命令行参数与配置项一一对应（`--connect-host` ↔ `connect.host`，`--sftp-flat` ↔ `sftpOptions.flat`，以此类推）。

| 选项                            | 对应配置                       | 说明                                           |
| ------------------------------- | ------------------------------ | ---------------------------------------------- |
| `-c, --config <path>`           | —                              | 配置文件路径，会整体覆盖命令行连接/路径参数    |
| `-l, --local <local>`           | `local`                        | 本地路径                                       |
| `-r, --remote <remote>`         | `remote`                       | 远程路径                                       |
| `-h, --connect-host <host>`     | `connect.host`                 | 远程服务器地址                                 |
| `-p, --connect-port <port>`     | `connect.port`                 | 远程服务器端口                                 |
| `-u, --connect-username <user>` | `connect.username`             | 用户名                                         |
| `--connect-password <pwd>`      | `connect.password`             | 密码                                           |
| `-e, --sftp-excludes <paths>`   | `sftpOptions.excludes`         | 排除目录，多个以英文逗号分隔                   |
| `-f, --sftp-flat`               | `sftpOptions.flat`             | 扁平化目录                                     |
| `--sftp-clear`                  | `sftpOptions.clear`            | 传输前清空远程目录（高危）                     |
| `-o, --sftp-override`           | `sftpOptions.override`         | 覆盖已存在文件                                 |
| `-i, --sftp-ignore-hidden`      | `sftpOptions.ignoreHidden`     | 忽略隐藏文件/目录                              |
| `-m, --sftp-mode <mode>`        | `sftpOptions.mode`             | 远程文件 mode（按八进制解析，如 `755`）        |
| `--before-run-command <cmd>`    | `sftpOptions.beforeRunCommand` | 传输前执行的远程命令                           |
| `--after-run-command <cmd>`     | `sftpOptions.afterRunCommand`  | 传输后执行的远程命令                           |
| `--debug`                       | `debug`                        | 输出调试日志（走 stderr）                      |
| `--dry-run`                     | —                              | 预演：打印将执行的动作但不连接、不落地         |
| `--json`                        | —                              | 结构化结果输出到 stdout，便于脚本 / agent 解析 |
| `--help`                        | —                              | 显示帮助                                       |
| `-V, --version`                 | —                              | 显示版本号                                     |

## 🪝 传输前后执行命令

常用于停服 / 重启 / 解压等场景：

```bash
npx wink-sftp -c ./sftp.json \
  --before-run-command "pm2 stop myapp" \
  --after-run-command "pm2 start myapp"
```

> 前/后置命令直接在远程执行，请勿写入不可信内容。拼入远程 shell 的本地文件名与路径已统一转义，可防注入。

## 🔍 预演与机器可读输出

部署前可先用 `--dry-run` 预演，确认将传输的文件、将创建的目录与将执行的远程命令——它**不建立连接、不落地**，适合真跑前自查或交给 AI agent 预检：

```bash
npx wink-sftp -c ./sftp.json --dry-run --json
```

`--json` 把结构化结果打到 **stdout**（人类日志一律走 stderr），因此可直接接 `jq`：

```bash
npx wink-sftp -c ./sftp.json --json | jq '.transferred'
```

结果对象结构：

```jsonc
{
    "ok": true, // 是否全部成功（有文件失败时为 false）
    "dryRun": false, // 是否为预演
    "local": "/abs/dist", // 本地根目录
    "remote": "/apps/app", // 远程根路径
    "transferred": [], // 已传输（预演时为将传输）的远程目标
    "skipped": [], // 已存在且未开启 override 而跳过的目标
    "failed": [], // 传输失败项：[{ target, error }]
    "dirs": [], // 已创建（预演时为将创建）的远程目录
    "commands": [], // 已执行（预演时为将执行）的远程命令
}
```

## 🔢 退出码

便于脚本与 agent 分支判断（成功为 `0`）：

| 退出码 | 含义                                                     |
| ------ | -------------------------------------------------------- |
| `0`    | 成功                                                     |
| `1`    | 通用错误                                                 |
| `2`    | 配置错误（缺字段、配置文件解析失败、`clear` 路径不安全） |
| `3`    | SSH 连接失败 / 超时                                      |
| `4`    | 远程命令执行失败（前/后置命令、`mkdir`、`clear`）        |
| `5`    | 文件传输失败                                             |

## ⚠️ 安全须知

- **`clear` 会执行 `rm -rf` 清空远程目录，属高危操作**。请务必确认 `remote` 指向正确；工具已内置护栏拒绝清空空路径 / `/` 等危险目标，但仍建议先 `--dry-run` 预演。
- 当前仅支持密码登录，SSH 密钥登录在路线图中。
- `--debug` 打印配置时会自动对密码等敏感字段脱敏。
- 建议不要在命令行明文写密码，优先用配置文件（加入 `.gitignore`）或 CI 密钥。

## 🤖 与脚本 / AI Agent 集成

`--json`（机器输出走 stdout、人类日志走 stderr）、`--dry-run`（安全预演）与分类退出码共同保证：调用方能可靠判断成败、并在真正落地前预览动作。推荐流程：先 `--dry-run --json` 让用户/agent 确认，再去掉 `--dry-run` 真跑，最后凭退出码与 `.failed` 判断结果。

## 🗺️ 路线图

当前 `v1.x` 聚焦把「部署」这条线做到可信、好用。后续将推进健壮性加固（并发/重试/密钥登录/审计）、增量传输与多环境配置，并逐步扩展为面向单机全生命周期的「SSH 快捷操作入口」。完整规划见 [docs/ROADMAP.md](./docs/ROADMAP.md) 与 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 🛠️ 本地开发

```bash
pnpm install        # 安装依赖（本仓库使用 pnpm）
pnpm dev            # 以 tsx 直接运行（默认读取 sftp.json）
pnpm test           # 运行 vitest 单测
pnpm run lint       # oxlint 检查并自动修复
pnpm run format     # oxfmt 格式化（4 空格 / 单引号 / 无分号）
pnpm run typecheck  # tsc 类型检查
pnpm run build      # ncc 打包到 dist/
```

> 打包用 [`@vercel/ncc`](https://github.com/vercel/ncc) 输出自包含单文件：`ssh2` 含原生组件，ncc 对原生 addon 友好，能正确处理；这也是不采用 rollup/vite 打包的原因。

## 🎯 主要依赖

- [ssh2](https://github.com/mscdex/ssh2) —— SSH / SFTP 连接与远程执行
- [commander](https://github.com/tj/commander.js) —— 命令行参数解析

## 👨‍🎨 作者

**XWINK**

- Email: 1041367524@qq.com
- Github: [@x-wink](https://github.com/x-wink)
- Homepage: https://xwink.fun

## 🤝 贡献

欢迎 [提交 Issue](https://github.com/x-wink/wink-sftp/issues) 反馈问题或提出建议。提交信息遵循 Conventional Commits。

## 📄 许可

[MIT](https://github.com/x-wink/wink-sftp/blob/main/LICENSE) © XWINK

> 如果这个项目对你有帮助，欢迎点个 ⭐️ 支持一下~
