---
name: deploy
description: 用 winkops 把本地目录通过 SFTP 部署到远程服务器。当用户要「部署 / 发布 / 上传到服务器」、「把 dist 传到远程」、配置 wink.json、或排查 winkops 部署结果时使用。封装「先预演、人工确认、再真跑、按结构化结果判定成败」的安全流程。
---

# winkops 部署

`winkops` 是一个把本地目录经 SFTP 全量传输到远程服务器的 CLI，支持传输前后执行远程命令。本 Skill 规约其**安全调用流程**，供人机协作与 agent 调用。

## 核心安全规约（务必遵守）

1. **真跑前先预演**：任何实跑前先执行 `--dry-run --json`，把「将传输的文件 / 将建的目录 / 将执行的命令 / 告警」展示给用户确认。预演不建立连接、不落地。
2. **危险操作需明确确认**：`--sftp-clear`（清空远程目录，等价 `rm -rf <remote>/*`）必须经用户明确同意才使用。核心层有 `assertSafeClearTarget` 护栏拒绝空路径 / `/`，但**护栏不替代确认**。
3. **按结构化结果判定成败**，不要只看是否有输出：
    - **退出码**：0 成功；2 配置错误；3 连接失败；4 远程命令失败；5 文件传输失败；1 通用错误。
    - **`--json` 结果**：`ok` 为总判定，`failed[]` 列出失败文件，`warnings[]` 列出非致命告警（如 flat 同名覆盖）。
4. **凭据不外泄**：debug 日志已对 `password` / `passphrase` / `privateKey` 脱敏；勿在对话或日志里回显明文密码。优先用密钥登录（`--connect-private-key`），明文密码不适合 CI。

> 下载与浏览远程目录（`pull` / `ls`）不在本 Skill，见 `pull` Skill。

## 两种调用方式

### A. 配置文件（推荐）

写一个 `wink.json`（也支持 `.yaml/.yml`，按扩展名识别），用 `-c` 指定：

```jsonc
{
    "connect": { "host": "1.2.3.4", "port": 22, "username": "root", "password": "${SSH_PWD}" },
    // 凭据可用 ${ENV_VAR} 引用，校验前从环境变量（优先）或同目录 .env 注入，缺变量报错、不落明文
    // 或密钥登录：把 password 换成 "privateKey": "<私钥内容>", 可选 "passphrase": "***"
    "local": "dist",
    "remote": "/var/www/app",
    "sftpOptions": {
        "clear": false, // 传输前清空远程目录（危险，默认 false）
        "override": true, // 覆盖已存在文件（默认 false 会跳过）
        "incremental": false, // 增量：按 size+mtime 比对远程，只传变更文件，优先于 override
        "flat": false, // 扁平化：所有文件直接落到 remote 下（默认 false）
        "ignoreHidden": true, // 忽略点开头的隐藏文件/目录（默认 true）
        "excludes": ["node_modules"], // 全字匹配排除
        "ignore": ["*.log", "tmp/"], // gitignore 风格内联忽略，与 .winkignore 合并
        "mode": "0o755", // 远程文件权限（八进制）
        "concurrency": 5, // 并发上限（默认 5），避免打满 SSH MaxSessions
        "retries": 2, // 单文件传输失败重试次数（默认 2）
        "beforeRunCommand": "npm run build", // 在扫描前执行，产物会被纳入传输
        "afterRunCommand": "pm2 restart app",
    },
    // 多环境：environments 下按名覆盖基础配置，--env <name> 选中后深合并
    "environments": {
        "prod": { "connect": { "host": "10.0.0.1" }, "remote": "/var/www/prod" },
    },
}
```

```bash
winkops -c wink.json --dry-run --json          # 1) 预演，给用户确认
winkops -c wink.json --json                    # 2) 确认后真跑
winkops -c wink.json --env prod --dry-run --json  # 选中 prod 环境（覆盖叠加在基础配置之上）
```

> **`.winkignore`**：在 `local` 根放一个 gitignore 风格的忽略文件，自动生效（含目录整体剪枝），与 `sftpOptions.ignore` 合并。
>
> **配置合并优先级（高→低）**：调用级开关 ＞ 显式 CLI 字段 ＞ 选中环境覆盖 ＞ 配置文件 ＞ 默认值；即 `-c` 文件为基底，`--env` 叠加其上，显式 CLI 字段再覆盖（`undefined` 不覆盖）。

### B. 纯命令行参数

```bash
winkops -l dist -r /var/www/app \
  -h 1.2.3.4 -p 22 -u root --connect-password '***' \
  --dry-run --json
```

> 注意：commander 15 不支持多字符短 flag，password/clear/before/after 等只有长 flag：
> `--connect-password` / `--connect-private-key` / `--connect-passphrase` / `--sftp-clear` /
> `--sftp-incremental` / `--sftp-concurrency` / `--sftp-retries` / `--before-run-command` / `--after-run-command` /
> `--env <name>`（选多环境）/ `--audit-log <path>` / `--no-audit`。
> `-h` 是 host，帮助用 `--help`。

## 标准协作流程

1. 收集/确认目标（host、远程路径、本地目录、登录方式）。
2. 跑 `--dry-run --json`，向用户复述：将传 N 个文件、建哪些目录、执行哪些命令、有无 `warnings`。
3. 如涉及 `--sftp-clear` 或其他破坏性动作，**显式征得同意**。
4. 用户确认后真跑（带 `--json`），用退出码 + `ok` + `failed[]` 判定结果并回报。
5. 失败时：依退出码定位（连接 / 远程命令 / 传输），把 `failed[]` 的 `error` 反馈给用户。

## 审计

实跑默认向 `~/.winkops/audit.log` 追加一条记录（时间 / 主机 / 用户 / 结果 / 计数）。可用 `--audit-log <path>` 改路径、`--no-audit` 关闭。排查「谁在何时改了哪台机器」可查此文件。
