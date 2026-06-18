---
name: ops
description: 用 wink-sftp 的运维原语对远程服务器做诊断与维护——exec 远程执行、status 资源快照、logs 看日志、ps 进程快照、service 服务管理、edit 守护式改配置。当用户要「看服务器状态/负载/磁盘」、「查日志」、「看进程」、「重启/启停服务」、「远程执行命令」、「改远程配置文件并校验/重载」时使用。读类安全直接跑；写类（service 写动作 / edit）须确认。
---

# wink-sftp 运维原语（exec / status / logs / ps / service / edit）

把 `wink-sftp` 从「部署」展开为「SSH 快捷操作入口」的一组运维子命令。连接与配置同部署：`-c sftp.json`（JSON/YAML、`${ENV_VAR}` secrets、多环境 `--env`）或纯 CLI 连接参数（`-h`/`-p`/`-u`/`--connect-password` 或 `--connect-private-key`）；都支持 `--json`。

> 部署见 `deploy` Skill；下载/浏览见 `pull` Skill；环境初始化见 `provision` Skill。

## 核心安全规约

1. **读写分离**：`status`/`logs`/`ps` 与 `exec`/`service` 的只读 `status` 动作是只读的，可直接跑；**写操作须确认**——`service` 的 `start`/`stop`/`restart`/`reload` 必须 `--yes`，`edit` 改远程文件前应向用户确认。
2. **按结构化结果判定**，别只看输出：
    - 退出码：0 成功；2 配置错误；3 连接失败；4 远程命令/服务/编辑失败；`status`/`logs`/`ps` 失败为通用码 1；`exec` **透传远程命令退出码**。
    - `--json`：`ok` 为总判定；诊断原语「命令失败」也作 `ok:false` 的结构化结果返回（不报错），便于据实判断。
3. **凭据不外泄**：优先密钥登录，debug 已对 `password`/`passphrase`/`privateKey` 脱敏，勿回显明文。

## exec — 远程执行（读/写）

执行一条远程命令，收集 `stdout`/`stderr`/`code`；**进程退出码 = 远程命令退出码**（便于脚本分支）。退出码非零时 `ok:false` 但不报错。

```bash
wink-sftp exec 'systemctl is-active nginx' -c sftp.json --json
```

## status — 资源/健康快照（只读，agentless）

纯 SSH 解析 `hostname`/`/proc/loadavg`/`nproc`/`/proc/meminfo`/`df`，归一化为 `{host,load,cpuCores,memory,disks}`。**best-effort**：采集不到的字段为 `null`，整体仍 `ok:true`（针对 Linux）。

```bash
wink-sftp status -c sftp.json --json
```

## logs — 看日志（只读）

`tail -n <lines>`（默认 200）+ 可选 `--grep <pattern>` 过滤；路径与模式自动转义防注入。

```bash
wink-sftp logs /var/log/nginx/error.log -n 100 --grep timeout -c sftp.json --json
```

## ps — 进程快照（只读）

一次 `ps -A` 采集并结构化为 `{pid,ppid,user,cpu,mem,rssKb,command}` 列表；`--grep <pattern>` 在**客户端**按命令行子串过滤（避免 grep 进程自身入列）。

```bash
wink-sftp ps --grep node -c sftp.json --json
```

## service — 服务管理（status 只读 / 其余写）

`status`（只读放行）/ `start`·`stop`·`restart`·`reload`（写，**须 `--yes`**，并记本地审计）。`--manager systemd`（默认）`|pm2|docker`；docker **不支持 `reload`**。命令退出码非零作 `ok:false` 不报错。

```bash
wink-sftp service nginx status -c sftp.json --json            # 只读，直接跑
wink-sftp service nginx restart --yes -c sftp.json --json     # 写，需 --yes
wink-sftp service redis restart --manager docker --yes -c sftp.json --json
```

## edit — 守护式配置编辑（写）

用本地 `--file` 内容**原子替换**远程文件，复用 `guard` 流水线：**备份 → 替换 → `--validate` 校验 → `--reload` → 任一步失败自动回滚到备份**。返回 `{ok,target,backup,rolledBack,error}`。边界：文件级回滚，不撤销 reload 等副作用。

```bash
wink-sftp edit /etc/nginx/nginx.conf --file ./nginx.conf \
  --validate 'nginx -t' --reload 'systemctl reload nginx' -c sftp.json --json
```

## 标准协作流程

1. **诊断（读）**：用 `status` 看负载/内存/磁盘、`ps` 看进程、`logs` 看日志、`exec` 跑只读探查命令，组合这些**结构化事实**判断问题（工具不做 `diagnose` 黑盒）。
2. **维护（写）**：需要改动时——`service ... --yes` 重启服务、`edit` 改配置。写前向用户复述将做什么、征得同意；`edit` 尽量带 `--validate`/`--reload`，失败会自动回滚。
3. 用退出码 + `ok` 判定结果；失败时把 `stderr`/`error`/`code` 反馈给用户。

## 审计

写操作（`service` 写动作、`edit`）默认向 `~/.wink-sftp/audit.log` 追加一条记录。`--audit-log` 改路径、`--no-audit` 关闭。
