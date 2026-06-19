---
name: pull
description: 用 winkops 从远程服务器下载文件/目录到本地（pull），或列出/浏览远程目录内容（ls）。当用户要「从服务器拉取 / 下载远程文件」、「把远程 dist 拉到本地」、「看看服务器某目录下有什么 / 列出远程目录」、或在部署前后核对远程文件时使用。只读/下载类操作，不修改远程。
---

# winkops 远程下载与浏览

`winkops` 的两个**远程只读 / 下载**子命令：

- `pull` — 把远程文件或目录下载到本地（`fastGet`，目录递归镜像 + 受限并发/重试）。
- `ls` — 列出远程目录内容（纯只读，不下载、不修改）。

二者都不改远程文件，相对部署（`deploy`，见 `deploy` Skill）是安全的读侧操作，无需 `--dry-run`。

## 核心规约

1. **结构化判定成败**，不要只看有无输出：
    - **退出码**：0 成功；2 配置错误；3 连接失败；5 下载失败（`pull`）；`ls` 失败为通用码 1（目录不存在等则按错误类型，常见为传输 5）。
    - **`--json`**：`ok` 为总判定；`pull` 的 `failed[]` 列出失败项，`ls` 的 `entries[]` 为目录项。
2. **凭据不外泄**：优先密钥登录（`--connect-private-key`），debug 已对 `password`/`passphrase`/`privateKey` 脱敏，勿回显明文。
3. **登录与配置同 deploy**：支持 `-c wink.json`（JSON/YAML）、`${ENV_VAR}` secrets、多环境 `--env <name>`；连接也可用纯 CLI 参数（`-h`/`-p`/`-u`/`--connect-password` 或 `--connect-private-key`）。

## pull — 下载

把 `remote`（文件或目录）下载到本地 `local`；远程是目录时递归镜像到本地。

```bash
# 配置文件方式（local=本地目标，remote=远程源）
winkops pull -c wink.json --json

# 纯 CLI 方式
winkops pull -r /var/www/app -l ./backup \
  -h 1.2.3.4 -p 22 -u root --connect-private-key ~/.ssh/id_ed25519 --json
```

可选：`--sftp-concurrency <n>`（下载并发上限，默认 5）、`--sftp-retries <n>`（单文件失败重试，默认 2）。

`--json` 结果（`PullResult`）：

```jsonc
{
    "ok": true,
    "local": "/abs/backup", // 本地根目录（绝对路径）
    "remote": "/var/www/app", // 远程源
    "downloaded": ["/abs/backup/index.html"], // 已下载的本地文件
    "failed": [], // [{ target, error }]
    "dirs": ["/abs/backup"], // 已创建的本地目录
}
```

## ls — 浏览远程目录

```bash
# remote 可作位置参数，也可用 -r；不带 -c 时直接给连接参数
winkops ls /var/www/app -h 1.2.3.4 -u root --connect-password '***' --json
winkops ls -c wink.json -r /var/log --json
```

`--json` 结果（`LsResult`）：

```jsonc
{
    "ok": true,
    "remote": "/var/www/app",
    "entries": [
        { "name": "index.html", "type": "file", "size": 1024, "mtime": 1718700000 },
        { "name": "assets", "type": "dir", "size": 4096, "mtime": 1718700000 },
    ],
}
```

`type` 取值：`file` / `dir` / `link` / `other`；`mtime` 为秒级时间戳。

## 标准协作流程

1. 确认目标（host、远程路径、登录方式；`pull` 还需本地目标 `local`）。
2. 需要时先 `ls` 核对远程目录内容，再决定 `pull` 哪个路径。
3. 执行（带 `--json`），用退出码 + `ok` 判定；`pull` 失败时把 `failed[]` 的 `error` 反馈给用户。
