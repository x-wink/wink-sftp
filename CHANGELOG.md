# 更新日志

## v1.0.0

`@xwink/ops`（CLI `winkops`）首个版本：面向个人开发者与 AI Agent 的 agentless「SSH 快捷操作入口」，覆盖单机服务器的完整生命周期。

### 能力

- **部署**：单机 / 多机 SFTP 传输，增量（size+mtime）、`.winkignore`、扁平化、清空、覆盖控制、失败重试 + 并发池、文件级备份/回滚；`pull` 下载、`ls` 浏览。
- **运维**：`status`（资源快照）、`logs`（tail/grep，`--follow`）、`ps`、`exec`（`--stream`）只读原语；`service`（systemd/pm2/docker）、`edit`（守护式改配置）写操作（须 `--yes`，记审计）。
- **环境初始化**：`provision` 按声明式 `stack` 收敛单机——`nodejs`/`jdk`/`python`/`docker` + `nginx`/`redis`/`mysql`（install + verify），守护式 `configure` 下发配置文件；`--dry-run` 出 diff、`--yes` 执行、secret 脱敏。
- **配置**：JSON/YAML、多环境深合并（`--env`）、`${ENV_VAR}` secrets 注入。
- **接口**：所有命令 `--json` 结构化输出 + 退出码；稳定编程式 API（`@xwink/ops` 库入口）；随包 Skill（`deploy`/`pull`/`ops`/`provision`）供 Claude Code 调用。
