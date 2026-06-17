# 😉 wink-sftp

> 一个配置驱动的命令行工具，通过 SFTP 将本地文件一键部署到远程服务器，并支持在传输前后执行远程命令。

<!-- 通用 -->

![名称](https://img.shields.io/github/package-json/name/x-wink/wink-sftp?style=for-the-badge)
![版本](https://img.shields.io/github/package-json/v/x-wink/wink-sftp?style=for-the-badge&filename=package.json)
![关键字](https://img.shields.io/github/package-json/keywords/x-wink/wink-sftp?style=for-the-badge)
![许可](https://img.shields.io/github/package-json/license/x-wink/wink-sftp?style=for-the-badge)

<!-- NPM 包专用 -->

![下载量](https://img.shields.io/npm/dt/%40xwink/sftp?style=for-the-badge&logo=npm)
![大小](https://img.shields.io/bundlephobia/minzip/%40xwink/sftp?style=for-the-badge&logo=npm)

<!-- GITHUB 信息 -->

![收藏](https://img.shields.io/github/stars/x-wink/wink-sftp?style=flat-square&logo=github)
![借鉴](https://img.shields.io/github/forks/x-wink/wink-sftp?style=flat-square&logo=github)
![问题](https://img.shields.io/github/issues/x-wink/wink-sftp?style=flat-square&logo=github)
![请求](https://img.shields.io/github/issues-pr/x-wink/wink-sftp?style=flat-square&logo=github)

## ✨ 特性

- 🚀 一条命令把本地目录递归部署到远程服务器
- 📄 支持 JSON 配置文件，便于纳入版本管理与多项目复用
- 🪝 传输前后可执行远程命令（如停服、重启、清理）
- 🧹 可选清空远程目录、覆盖已有文件、扁平化目录结构
- 🙈 自动跳过隐藏文件夹，支持按路径排除
- 📦 零运行时配置，`npx` 即可使用

## 📥 安装

```bash
# npm
npm install --save-dev @xwink/sftp

# pnpm
pnpm add --save-dev @xwink/sftp
```

也可全局或临时使用：

```bash
npx wink-sftp --help
```

## 🚀 快速开始

最少传入以下六项即可完成一次部署（本地路径、远程路径、主机、端口、用户名、密码）：

```bash
npx wink-sftp -l ./dist -r /apps/myapp -h 192.168.1.10 -p 22 -u root -pwd 123456
```

## 📦 使用配置文件（推荐）

将参数写入配置文件，纳入项目版本管理，部署时只需指定路径：

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

> 指定 `-c` 时，配置文件会**覆盖**命令行参数。
> 顶层 `debug` 会作为 `sftpOptions.debug` 的默认值。
> 建议将含密码的配置文件加入 `.gitignore`，或通过 CI 密钥注入，避免提交明文密码。

### 配置项说明

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `local` | string | — | 本地路径（必填） |
| `remote` | string | — | 远程路径（必填） |
| `debug` | boolean | `false` | 输出调试日志 |
| `connect.host` | string | — | 远程服务器地址（必填） |
| `connect.port` | number | — | 远程服务器端口（必填） |
| `connect.username` | string | — | 用户名（必填） |
| `connect.password` | string | — | 密码（必填，暂仅支持密码登录） |
| `sftpOptions.excludes` | string[] | `[]` | 要排除的本地目录，目前仅支持全字匹配 |
| `sftpOptions.flat` | boolean | `false` | 扁平化目录：任意深度的文件都直接传到远程目录下 |
| `sftpOptions.clear` | boolean | `false` | 传输开始前清空远程目录（危险，见下方注意事项） |
| `sftpOptions.override` | boolean | `false` | 覆盖远程已存在的同名文件 |
| `sftpOptions.ignoreHidden` | boolean | `true` | 忽略隐藏文件夹 |
| `sftpOptions.mode` | number | `0o777` | 远程文件权限 mode |
| `sftpOptions.beforeRunCommand` | string | — | 传输开始前执行的远程命令 |
| `sftpOptions.afterRunCommand` | string | — | 传输完成后执行的远程命令 |

## ⌨️ 命令行参数

| 参数 | 对应配置 | 说明 |
| --- | --- | --- |
| `-c, --config <path>` | — | 指定配置文件路径，会覆盖命令行参数 |
| `-l, --local <local>` | `local` | 本地路径 |
| `-r, --remote <remote>` | `remote` | 远程路径 |
| `-h, --connect-host <host>` | `connect.host` | 远程服务器地址 |
| `-p, --connect-port <port>` | `connect.port` | 远程服务器端口 |
| `-u, --connect-username <user>` | `connect.username` | 用户名 |
| `-pwd, --connect-password <pwd>` | `connect.password` | 密码 |
| `--debug` | `debug` | 输出调试日志 |
| `-e, --sftp-excludes <paths>` | `sftpOptions.excludes` | 排除目录，多个以英文逗号分隔 |
| `-f, --sftp-flat` | `sftpOptions.flat` | 扁平化目录 |
| `-cls, --sftp-clear` | `sftpOptions.clear` | 传输前清空远程目录 |
| `-o, --sftp-override` | `sftpOptions.override` | 覆盖已存在文件 |
| `-i, --sftp-ignore-hidden` | `sftpOptions.ignoreHidden` | 忽略隐藏文件夹 |
| `-m, --sftp-mode <mode>` | `sftpOptions.mode` | 远程文件 mode |
| `-brc, --before-run-command <command>` | `sftpOptions.beforeRunCommand` | 传输前执行的命令 |
| `-arc, --after-run-command <command>` | `sftpOptions.afterRunCommand` | 传输后执行的命令 |

## 🪝 传输前后执行命令

可在传输前后执行远程命令，常用于停服 / 重启 / 解压等场景：

```bash
npx wink-sftp -c ./sftp.json \
  -brc "pm2 stop myapp" \
  -arc "pm2 start myapp"
```

## ⚠️ 注意事项

- **`clear` 会执行 `rm -rf` 清空远程目录，属高危操作，请务必确认 `remote` 指向正确再开启。**
- 当前仅支持密码登录，密钥登录在路线图中（见下）。
- `beforeRunCommand` / `afterRunCommand` 直接在远程执行，请勿写入不可信内容。
- 部分边界场景（隐藏文件判定、空目录、退出码等）正在按路线图逐步加固，详见 [ROADMAP.md](./ROADMAP.md)。

## 🗺️ 路线图

当前 v1.0.x 为 MVP，后续将分阶段推进稳定性加固、增量传输、SSH 密钥登录、多环境配置，以及面向 AI Agent 的 Skill 调用等能力。完整规划见 [ROADMAP.md](./ROADMAP.md)。

## 🛠️ 本地开发

```bash
npm run dev        # 以 ts-node 直接运行（默认读取 sftp.json）
npm run lint       # ESLint 检查并自动修复
npm run prettier   # 格式化
npm run build      # 使用 ncc 打包到 dist/
```

> 打包说明：`ssh2` 含原生依赖，使用 `@vercel/ncc` 可正常打包；若改用 `rollup` 需以 `npm` 安装依赖，否则会因 `cpufeatures.node` 解析失败而报错。

## 🎯 依赖

- [ssh2](https://github.com/mscdex/ssh2) —— 建立 SSH / SFTP 连接
- [commander](https://github.com/tj/commander.js) —— 命令行参数解析

## 👨‍🎨 作者

**XWINK**

- Email: 1041367524@qq.com
- Github: [@x-wink](https://github.com/x-wink)
- Homepage: https://xwink.fun

## 🤝 贡献

欢迎随时 [提交 Issue](https://github.com/x-wink/wink-sftp/issues) 反馈问题或提出功能建议。

## 📄 许可

[MIT](https://github.com/x-wink/wink-sftp/blob/main/LICENSE) © XWINK

> 如果这个项目对你有帮助，欢迎点个 ⭐️ 支持一下~
