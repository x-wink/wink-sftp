---
name: provision
description: 用 winkops 的 provision 按声明式 stack 初始化/收敛单台服务器的环境（安装 node/jdk/python/docker/nginx/redis/mysql，并守护式写配置文件）。当用户要「初始化服务器环境 / 装运行时或中间件 / 配置 stack / 下发 nginx/redis/mysql 配置文件 / 准备一台新机器跑应用」、或要把服务器收敛到指定 node/jdk/python/docker/nginx/redis/mysql 版本与配置时使用。写操作，封装「先预演 diff、人工确认、再 --yes 执行、按结构化结果判定」的安全流程。
---

# winkops 环境初始化（provision）

`winkops provision` 按配置文件的声明式 `stack` 把**单台服务器收敛到目标栈状态**——检测当前版本，未达标才安装。**幂等**：已满足的组件自动跳过。本 Skill 规约其安全调用流程。

支持组件：语言运行时 `nodejs`(nvm) / `jdk`(sdkman) / `python`(pyenv)、`docker`(官方脚本)、`nginx`(apt + `nginx -t`)、`redis`/`mysql`（`mode: docker|native`，install + verify）。任一组件还可声明 `configure` **守护式写配置文件**（本地文件 → 远程，复用 `edit` 同款 `guard` 流水线：备份→写→校验→reload→失败回滚）。

## 核心安全规约（务必遵守）

1. **写操作，先预演再执行**：`provision` 会安装/改动系统，**必须** `--dry-run`（预演：检测当前状态 + 打印将执行的步骤，不落地）或 `--yes`（确认执行）二者其一，**都没有则直接拒绝**（退出码 2）。标准做法：先 `--dry-run --json` 给用户看检测结果与计划，确认后再 `--yes`。
2. **幂等可放心重跑**：先检测（`node --version` 等）再收敛；已满足目标版本则不执行任何步骤。版本按**点分前缀**匹配（目标 `20` 满足 `20.11.0`）。重复跑不会重复安装。
3. **按结构化结果判定成败**：
    - **退出码**：0 成功；2 配置错误（缺 stack / 缺 `--dry-run`/`--yes` / 不支持的组件 / 版本声明为空 / configure 形态非法或本地源文件缺失）；3 连接失败；4 收敛或配置步骤失败。
    - **`--json`**：`ok` 为总判定；每个组件有 `satisfied`（是否已满足、无需动作）、`planned`（将执行的步骤）、`executed`（实际执行结果，含每步 `ok`）、`plannedConfigs`（将写的配置）、`configured`（已写配置结果，含 `ok`/`rolledBack`）。
4. **凭据不外泄**：stack 里的 secrets（如 mysql `rootPassword`）用 `${ENV_VAR}` 引用、不落明文；含 secret 的步骤在 `--json`/审计里会自动脱敏（密码替换为星号），明文只用于实际执行，勿回显明文密码。
5. **原生包需 root**：`nginx`/`redis`/`mysql` 的 native 安装走 apt，需以 **root 或免密 sudo** 用户连接。
6. **守护式写配置（`configure`）安全**：任一组件可声明 `configure: [{ file, remote, validate?, reload? }]`，安装/已满足后**按数组顺序逐条**经 `guard` 落地（备份→写→校验→reload→失败回滚），本地源经 SFTP、明文不进命令。**实跑前预检本地源文件存在**（缺则报错、不连接）；`configure` 形态非法（非数组/缺 file/remote）连接前即报错，预演也校验。预演（`--dry-run`）只在 `plannedConfigs` 出计划、不写、不要求文件就位。改系统关键配置（nginx/mysql 等）建议**带 `validate`**，校验失败能自动回滚。
    - **回滚是逐条（per-file）粒度，不是整组件原子**：某条失败只回滚**这一条**到它自己的备份，并**停在该条**（后续条目不再处理）；但**此前已成功的条目（含其 `reload` 副作用）不会被撤销**。故多文件互相引用时要**把被依赖文件排在前面**（如先写 `conf.d/*` 再写引用它的 `nginx.conf`），或只在最后一条挂 `validate`/`reload`、前面几条仅写文件，使整组校验只跑一次。
    - **新建文件失败无法回滚**：目标原先不存在（无备份）时若写后 `validate`/`reload` 失败，`guard` 无从回滚（`rolledBack=false`），失败的新文件留在原处——`configured[].rolledBack` 会如实反映，需人工清理。

## 配置：stack 段

在 `wink.json` / `wink.yaml` 里与部署共用 `connect`，新增 `stack` 段（YAML 更直观）：

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
    nginx: # 对象形态可带 configure：安装/已满足后守护式写配置文件
        version: latest # apt 安装 + nginx -t 校验（原生，已装即满足）
        configure: # 逐条经 guard：备份→写→校验→reload→失败回滚
            - file: ./conf/nginx.conf # 本地源（相对启动目录，须存在）
              remote: /etc/nginx/nginx.conf # 远程目标
              validate: nginx -t # 可选：退出码非零触发回滚
              reload: systemctl reload nginx # 可选：reload 失败同样回滚
    redis: { version: 7, mode: docker, maxmemory: 512mb } # mode: docker(比镜像版本)|native(apt)
    mysql: { version: 8, mode: docker, rootPassword: ${MYSQL_ROOT_PWD} } # docker 模式 rootPassword 必填
```

组件取值要点：`nginx` 用 `latest`/版本（原生，已装即满足）；`redis`/`mysql` 用对象，`mode` 选 `docker`（按镜像 tag 比版本）或 `native`（apt，已装即满足）；`redis` 可选 `maxmemory`；`mysql` 的 `rootPassword` 经 `${ENV_VAR}` 引用，docker 模式必填。

> stack 同样支持多环境：放进 `environments.<name>.stack`，`--env <name>` 选中后深合并。

## 用法

```bash
# 1) 预演：检测当前状态 + 打印计划（强烈建议先跑，给用户确认）
winkops provision -c wink.yaml --dry-run --json

# 2) 确认后执行（写操作）
winkops provision -c wink.yaml --yes --json

# 只处理指定组件（位置参数限定子集，默认处理 stack 中全部）
winkops provision nodejs docker -c wink.yaml --yes
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
            "satisfied": false, // 已满足则跳过安装步骤（configure 仍会执行）
            "planned": [{ "description": "安装 Node 20 并设为默认", "command": "…" }],
            "executed": [{ "description": "…", "command": "…", "ok": true, "stdout": "", "stderr": "", "code": 0 }],
            "plannedConfigs": [], // 该组件声明的 configure（本地→远程 + validate/reload）
            "configured": [], // 已写配置结果：[{ file, remote, ok, backup, rolledBack, error? }]
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
- `nginx`/`redis`/`mysql` 为 **install + verify**（装好 + `nginx -t` / `redis-cli ping` / `mysqladmin ping` 校验）；如需下发配置文件，用组件对象的 `configure`（守护式写、复用 `guard`）。
- `redis`/`mysql` 的 `mode: native`（apt）按「已装即满足」（发行版版本不强比）；`mode: docker` 按镜像 tag 比版本。原生安装需 root/免密 sudo。docker 模式用固定容器名 `wink-redis`/`wink-mysql`，同机已有同名容器会冲突。
- `mysql` docker 模式 `rootPassword` 必填（缺则报配置错误）；其明文绝不进 `--json`/审计（脱敏为星号）。
- step 失败会停在该组件首个失败步骤、不继续；其它组件互不影响。

## 审计

实跑（`--yes`）默认向 `~/.winkops/audit.log` 追加一条记录（时间 / 主机 / 用户 / 结果 / 组件清单）。`--audit-log` 改路径、`--no-audit` 关闭。
