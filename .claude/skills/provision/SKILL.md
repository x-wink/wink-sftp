---
name: provision
description: 用 wink-sftp 的 provision 按声明式 stack 初始化/收敛单台服务器的环境（安装 node/jdk/python/docker）。当用户要「初始化服务器环境 / 装运行时 / 配置 stack / 准备一台新机器跑应用」、或要把服务器收敛到指定 node/jdk/python/docker 版本时使用。写操作，封装「先预演 diff、人工确认、再 --yes 执行、按结构化结果判定」的安全流程。
---

# wink-sftp 环境初始化（provision）

`wink-sftp provision` 按配置文件的声明式 `stack` 把**单台服务器收敛到目标栈状态**——检测当前版本，未达标才安装。**幂等**：已满足的组件自动跳过。本 Skill 规约其安全调用流程。

本批支持语言运行时 + Docker：`nodejs`(nvm) / `jdk`(sdkman) / `python`(pyenv) / `docker`(官方脚本)；`nginx`/`redis`/`mysql` 等需守护式配置的组件下批推进（届时复用 `edit` 同款 `guard` 流水线，见 `ops` Skill）。

## 核心安全规约（务必遵守）

1. **写操作，先预演再执行**：`provision` 会安装/改动系统，**必须** `--dry-run`（预演：检测当前状态 + 打印将执行的步骤，不落地）或 `--yes`（确认执行）二者其一，**都没有则直接拒绝**（退出码 2）。标准做法：先 `--dry-run --json` 给用户看检测结果与计划，确认后再 `--yes`。
2. **幂等可放心重跑**：先检测（`node --version` 等）再收敛；已满足目标版本则不执行任何步骤。版本按**点分前缀**匹配（目标 `20` 满足 `20.11.0`）。重复跑不会重复安装。
3. **按结构化结果判定成败**：
    - **退出码**：0 成功；2 配置错误（缺 stack / 缺 `--dry-run`/`--yes` / 不支持的组件 / 版本声明为空）；3 连接失败；4 收敛步骤失败。
    - **`--json`**：`ok` 为总判定；每个组件有 `satisfied`（是否已满足、无需动作）、`planned`（将执行的步骤）、`executed`（实际执行结果，含每步 `ok`）。
4. **凭据不外泄**：stack 里的 secrets 用 `${ENV_VAR}` 引用、不落明文；debug 已脱敏，勿回显明文密码。

## 配置：stack 段

在 `sftp.json` / `sftp.yaml` 里与部署共用 `connect`，新增 `stack` 段（YAML 更直观）：

```yaml
connect:
    host: 1.2.3.4
    port: 22
    username: root
    password: ${SSH_PWD} # 或密钥登录：privateKey / passphrase
stack:
    nodejs: '20' # 经 nvm 安装并设为默认；版本号
    python: '3.11.9' # 经 pyenv 安装并设为全局；建议用完整补丁号
    jdk: '17.0.9-tem' # 经 sdkman 安装；用 sdkman 候选标识（如 17-tem / 17.0.9-tem）
    docker: true # 官方脚本安装；false 则跳过该组件（不比版本）
```

> stack 同样支持多环境：放进 `environments.<name>.stack`，`--env <name>` 选中后深合并。

## 用法

```bash
# 1) 预演：检测当前状态 + 打印计划（强烈建议先跑，给用户确认）
wink-sftp provision -c sftp.yaml --dry-run --json

# 2) 确认后执行（写操作）
wink-sftp provision -c sftp.yaml --yes --json

# 只处理指定组件（位置参数限定子集，默认处理 stack 中全部）
wink-sftp provision nodejs docker -c sftp.yaml --yes
```

可选：`--audit-log <path>` 改审计路径、`--no-audit` 关闭审计。

`--json` 结果（`ProvisionResult`）：

```jsonc
{
    "ok": true,
    "dryRun": false,
    "components": [
        {
            "component": "nodejs",
            "desired": "20",
            "detected": { "installed": true, "version": "18.19.0" }, // 收敛前检测
            "satisfied": false, // 已满足则跳过，无步骤
            "planned": [{ "description": "安装 Node 20 并设为默认", "command": "…" }],
            "executed": [{ "description": "…", "command": "…", "ok": true, "stdout": "", "stderr": "", "code": 0 }],
            "ok": true,
        },
        {
            "component": "docker",
            "desired": "true",
            "detected": { "installed": true, "version": "24.0.7" },
            "satisfied": true, // 已装即满足（docker 只判是否安装、不比版本）
            "planned": [],
            "executed": [],
            "ok": true,
        },
    ],
}
```

## 标准协作流程

1. 确认目标（host、登录方式、要收敛的 stack 组件与版本）。
2. 跑 `--dry-run --json`，向用户复述：每个组件**当前检测到的版本** vs **目标**、哪些 `satisfied`（无需动作）、未满足的将执行哪些 `planned` 步骤。
3. 用户确认后 `--yes --json` 执行，用退出码 + `ok` 判定；失败时把对应组件 `executed` 里第一个 `ok:false` 步骤的 `stderr`/`code` 反馈给用户。
4. 可随时重跑——幂等，已满足组件会跳过。

## 边界与已知约束

- 面向固定栈的**策划式 recipes**（Ubuntu/Debian 优先），不是通用配置管理引擎（非 Ansible）。
- `jdk` 用 sdkman 候选标识；老式 Java 8 的 `1.8.0_x` 编号已归一为 `8.0.x`，故 `jdk: '8'` 能命中已装版本。
- `python` 建议用完整补丁号（如 `3.11.9`），传给 `pyenv install -s`。
- `docker` 是布尔开关组件：声明 `true`/`false`，**不比版本**（已装即满足）。
- step 失败会停在该组件首个失败步骤、不继续；其它组件互不影响。

## 审计

实跑（`--yes`）默认向 `~/.wink-sftp/audit.log` 追加一条记录（时间 / 主机 / 用户 / 结果 / 组件清单）。`--audit-log` 改路径、`--no-audit` 关闭。
