import fs from 'node:fs'
import { withSession } from './session'
import type { SshSession } from './session'
import { resolveConfig } from './config'
import { Logger } from './logger'
import { recordAudit } from './audit'
import { execStructured } from './ops'
import { shellQuote } from './exec'
import { guard } from './guard'
import { resolveLocal } from './pathmap'
import { ConfigError, TransferError } from './errors'
import type { RunOption, StackValue, StackSpec } from './core'

/**
 * 环境初始化（单机 provision）：按声明式 `stack` 把服务器**收敛**到目标栈状态。
 *
 * 设计与 `service` 一致——recipe 用**纯函数**（检测命令字符串 + `parse` 解析 + `converge` 规划）描述，
 * 编排器只负责「执行检测 → 算收敛步骤 → 预演或执行」，便于 fixture 单测、e2e 只验证编排/连通。
 *
 * 已交付 recipe：语言运行时 + docker（node/jdk/python/docker）+ nginx/redis/mysql（install + verify，
 * redis/mysql 支持 `mode: docker|native`、关键参数 maxmemory/rootPassword 安装时设）。
 *
 * 守护式**写配置文件**：任一组件可在 stack 对象里声明 `configure`（本地文件 → 远程，附可选 `validate`/`reload`），
 * 安装/已满足后逐条经 {@link guard} 落地（备份→写→校验→reload→失败回滚），与 `edit` 同一流水线。本地源经 SFTP
 * 传输、明文不进命令，天然不泄漏。边界：面向固定栈的策划式 recipes（Ubuntu/Debian 优先），非通用 CM 引擎。
 *
 * 安全：编排器对外（--json / 审计）暴露前，按组件选项里的 secret 值（如 mysql rootPassword）**统一脱敏**
 * 命令与 stdout/stderr（默认安全，不靠各 recipe 记得脱敏）。原生包安装需以 root（或免密 sudo）用户连接。
 */

/** 组件当前安装状态（由 recipe 的 `parse` 从检测输出归一化）。 */
export interface DetectState {
    /** 是否已安装（检测到版本）。 */
    installed: boolean
    /** 检测到的版本（未安装为 null）。 */
    version: string | null
}

/** 组件的附加选项（stack 对象形态的非 version 字段，如 redis/mysql 的 `mode`/`maxmemory`/`rootPassword`）。 */
export type ComponentOptions = Record<string, unknown>

/** 一条守护式配置写入声明（stack 组件对象的 `configure` 数组项）：本地文件 → 远程，附校验/reload。 */
export interface ConfigSpec {
    /** 本地源文件（相对启动目录），其内容原子替换远程文件。 */
    file: string
    /** 远程目标文件路径。 */
    remote: string
    /** 可选校验命令（如 `nginx -t`），退出码非零触发回滚。 */
    validate?: string
    /** 可选 reload 命令（如 `systemctl reload nginx`），失败同样回滚。 */
    reload?: string
}

/** 一条配置写入的结果（即 {@link guard} 结果 + 本地/远程定位）。 */
export interface ConfigResult {
    /** 本地源文件。 */
    file: string
    /** 远程目标文件。 */
    remote: string
    /** 是否成功（写入 + 校验 + reload 全过）。 */
    ok: boolean
    /** 备份路径（目标原先存在才有）。 */
    backup: string | null
    /** 失败后是否已回滚到备份。 */
    rolledBack: boolean
    /** 失败原因（ok=false 时有；已按 secret 脱敏）。 */
    error?: string
}

/**
 * 从组件选项解析 `configure` 声明（守护式写配置文件）。缺省为空数组；形态非法则抛 {@link ConfigError}。
 * 纯函数，便于 fixture 单测，也供编排器预检本地源文件存在。
 */
export const parseConfigs = (options: ComponentOptions): ConfigSpec[] => {
    const raw = options.configure
    if (raw === undefined) return []
    if (!Array.isArray(raw)) {
        throw new ConfigError('configure 必须是数组（每项 { file, remote, validate?, reload? }）')
    }
    return raw.map((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new ConfigError(`configure[${i}] 必须是对象（{ file, remote, validate?, reload? }）`)
        }
        const o = item as Record<string, unknown>
        if (typeof o.file !== 'string' || !o.file.trim())
            throw new ConfigError(`configure[${i}] 缺少 file（本地源文件）`)
        if (typeof o.remote !== 'string' || !o.remote.trim()) {
            throw new ConfigError(`configure[${i}] 缺少 remote（远程目标）`)
        }
        const spec: ConfigSpec = { file: o.file, remote: o.remote }
        if (o.validate !== undefined) {
            if (typeof o.validate !== 'string') throw new ConfigError(`configure[${i}].validate 必须是字符串`)
            spec.validate = o.validate
        }
        if (o.reload !== undefined) {
            if (typeof o.reload !== 'string') throw new ConfigError(`configure[${i}].reload 必须是字符串`)
            spec.reload = o.reload
        }
        return spec
    })
}

/** 一个收敛步骤：人类描述 + 实际远程命令。 */
export interface PlanStep {
    description: string
    /** 实际执行的远程命令（可含明文 secret；对外暴露前由编排层按 secret 值统一脱敏）。 */
    command: string
}

/** 已执行步骤的结果：在 {@link PlanStep} 基础上带执行产物（退出码非零即 `ok=false`）。 */
export interface StepResult extends PlanStep {
    ok: boolean
    stdout: string
    stderr: string
    code: number
}

/** recipe 的收敛规划结果。 */
export interface ConvergePlan {
    /** 当前状态是否已满足目标（满足则 `steps` 为空，体现幂等）。 */
    satisfied: boolean
    /** 为达成目标需执行的步骤（已满足则为空）。 */
    steps: PlanStep[]
}

/**
 * 组件 recipe 契约：以**纯函数**描述「如何检测 / 如何收敛」，不触碰会话。
 * - `detect`：一次远程执行的命令（输出交 {@link parse}），均以 `|| true` 兜底退出码 0。
 * - `parse`：把检测输出解析为 {@link DetectState}（纯函数，fixture 单测）。
 * - `converge`：给定目标版本与检测状态，产出收敛 {@link PlanStep}（纯函数；已满足则空步骤）。
 */
export interface Recipe {
    /** 组件名（stack 键）。 */
    component: string
    /** 按组件选项产出检测命令（多数组件版本/选项无关；redis/mysql 据 `mode` 返回 native/docker 检测）。 */
    detect(options: ComponentOptions): string
    /** 解析检测输出为安装状态。 */
    parse(output: string): DetectState
    /** 给定目标版本（`normalizeDesired` 归一化）、检测状态与组件选项产出收敛步骤（已满足则空步骤）。 */
    converge(desired: string, state: DetectState, options: ComponentOptions): ConvergePlan
}

/**
 * 版本是否满足目标：取两侧的首个「数字.数字…」段做**点分前缀匹配**。
 * 目标 `20` 满足检测到的 `20.11.0`；`3.11` 满足 `3.11.5`；`17.0.9-tem` 满足 `17.0.9`。
 * 目标无数字段（如布尔组件的 `true`）一律返回 false——此类组件由各自 `converge` 自行判定。
 */
/** 取字符串中首个「数字.数字…」段（剥离 vendor 后缀等非数字部分）；无则空串。 */
const numericVersion = (v: string): string => v.match(/\d+(?:\.\d+)*/)?.[0] ?? ''

export const versionSatisfies = (desired: string, detected: string | null): boolean => {
    if (!detected) return false
    const want = numericVersion(desired).split('.').filter(Boolean)
    const have = numericVersion(detected).split('.')
    if (!want.length) return false
    return want.every((part, i) => part === have[i])
}

/**
 * 把 stack 声明值归一化为目标版本字符串：
 * - `false` → null（组件关闭，跳过）
 * - `true` → `'true'`（布尔开关组件，如 docker）
 * - 字符串/数字 → 其字符串形式
 * - 对象 → 取 `version` 字段（缺失则报错）
 */
export const normalizeDesired = (component: string, value: StackValue): string | null => {
    if (value === false) return null
    if (value === true) return 'true'
    if (typeof value === 'string' || typeof value === 'number') {
        const s = String(value).trim()
        if (!s) throw new ConfigError(`组件 ${component} 的版本声明为空`)
        return s
    }
    if (value && typeof value === 'object') {
        const v = (value as Record<string, unknown>).version
        if (v === undefined) throw new ConfigError(`组件 ${component} 缺少 version 字段`)
        return String(v)
    }
    throw new ConfigError(`组件 ${component} 的声明值非法：${JSON.stringify(value)}`)
}

/** 检测到版本号的通用解析：按正则取首个捕获组为版本；无匹配视为未安装。 */
const parseVersion = (output: string, re: RegExp): DetectState => {
    const m = output.match(re)
    return m ? { installed: true, version: m[1] } : { installed: false, version: null }
}

/** 选项里值视为 secret 的字段名（脱敏用）。 */
const SECRET_KEY_RE = /pass|secret|token|pwd|credential/i

/** 从组件选项收集 secret 明文值（键名命中 {@link SECRET_KEY_RE} 的字符串/数字值）。 */
const collectSecrets = (options: ComponentOptions): string[] =>
    Object.entries(options)
        .filter(([k, v]) => SECRET_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number'))
        .map(([, v]) => String(v))
        .filter(Boolean)

/** 把文本中出现的所有 secret 明文替换为 `***`——默认安全：命令/输出统一脱敏，不靠各 recipe 记得脱敏。 */
const scrubSecrets = (text: string, secrets: string[]): string => secrets.reduce((t, s) => t.split(s).join('***'), text)

/** nvm 安装脚本（固定版本，避免随上游 HEAD 漂移）。 */
const NVM_INSTALLER = 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh'

/** Node.js（经 nvm 版本管理）。 */
const nodejs: Recipe = {
    component: 'nodejs',
    detect: () =>
        'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; node --version 2>/dev/null || true',
    parse: (out) => parseVersion(out, /v(\d+\.\d+\.\d+)/),
    converge: (desired, state) => {
        if (state.installed && versionSatisfies(desired, state.version)) return { satisfied: true, steps: [] }
        const v = shellQuote(desired)
        return {
            satisfied: false,
            steps: [
                {
                    description: '安装 nvm（如未安装）',
                    command: `export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] || curl -o- ${NVM_INSTALLER} | bash`,
                },
                {
                    description: `安装 Node ${desired} 并设为默认`,
                    command: `export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh"; nvm install ${v} && nvm alias default ${v}`,
                },
            ],
        }
    },
}

/** JDK（经 sdkman 版本管理；version 用 sdkman 候选标识，如 `17.0.9-tem`）。 */
const jdk: Recipe = {
    component: 'jdk',
    // 取含 version 的那一行（用 grep 过滤掉 `Picked up JAVA_TOOL_OPTIONS` 等噪声首行）
    detect: () =>
        'export SDKMAN_DIR="${SDKMAN_DIR:-$HOME/.sdkman}"; [ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ] && . "$SDKMAN_DIR/bin/sdkman-init.sh"; java -version 2>&1 | grep -i version | head -n 1 || true',
    // java -version 形如 `openjdk version "17.0.9" 2023-...` 或老式 `java version "1.8.0_292"`。
    // 归一：旧 1.X 编号的 X 才是真实大版本（`1.8.0_292` → `8.0.292`），下划线补丁位转点——
    // 否则 `jdk: '8'` 永远命中不了已装的 Java 8（'8' 比到首段 '1'），破坏幂等。
    parse: (out) => {
        const m = out.match(/version "(\d[\d._]*)"/)
        if (!m) return { installed: false, version: null }
        let v = m[1].replace(/_/g, '.')
        if (v.startsWith('1.')) v = v.slice(2)
        return { installed: true, version: v }
    },
    converge: (desired, state) => {
        if (state.installed && versionSatisfies(desired, state.version)) return { satisfied: true, steps: [] }
        const v = shellQuote(desired)
        return {
            satisfied: false,
            steps: [
                {
                    description: '安装 sdkman（如未安装）',
                    command: `[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] || curl -s "https://get.sdkman.io" | bash`,
                },
                {
                    description: `安装 JDK ${desired}`,
                    command: `export SDKMAN_DIR="$HOME/.sdkman"; . "$SDKMAN_DIR/bin/sdkman-init.sh"; sdk install java ${v}`,
                },
            ],
        }
    },
}

/** Python（经 pyenv 版本管理；version 建议用完整补丁号，如 `3.11.9`）。 */
const python: Recipe = {
    component: 'python',
    detect: () =>
        'export PYENV_ROOT="${PYENV_ROOT:-$HOME/.pyenv}"; export PATH="$PYENV_ROOT/bin:$PATH"; command -v pyenv >/dev/null 2>&1 && eval "$(pyenv init - 2>/dev/null)"; python --version 2>&1 || true',
    parse: (out) => parseVersion(out, /Python (\d+\.\d+\.\d+)/),
    converge: (desired, state) => {
        if (state.installed && versionSatisfies(desired, state.version)) return { satisfied: true, steps: [] }
        const v = shellQuote(desired)
        return {
            satisfied: false,
            steps: [
                {
                    description: '安装 pyenv（如未安装）',
                    command: `[ -d "$HOME/.pyenv" ] || curl -fsSL https://pyenv.run | bash`,
                },
                {
                    description: `安装 Python ${desired} 并设为全局`,
                    command: `export PYENV_ROOT="$HOME/.pyenv"; export PATH="$PYENV_ROOT/bin:$PATH"; eval "$(pyenv init -)"; pyenv install -s ${v} && pyenv global ${v}`,
                },
            ],
        }
    },
}

/** Docker（官方安装脚本；布尔开关组件，只判是否已安装、不比版本）。 */
const docker: Recipe = {
    component: 'docker',
    detect: () => 'docker --version 2>/dev/null || true',
    parse: (out) => parseVersion(out, /Docker version (\d+\.\d+\.\d+)/),
    converge: (_desired, state) => {
        if (state.installed) return { satisfied: true, steps: [] }
        return {
            satisfied: false,
            steps: [
                {
                    description: '安装 Docker（官方脚本）',
                    command: `command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh`,
                },
            ],
        }
    },
}

/** nginx（原生 apt 安装；版本由发行版决定，已装即满足）。 */
const nginx: Recipe = {
    component: 'nginx',
    detect: () => 'nginx -v 2>&1 || true', // "nginx version: nginx/1.24.0" 走 stderr
    parse: (out) => parseVersion(out, /nginx\/(\d+\.\d+\.\d+)/),
    converge: (_desired, state) => {
        if (state.installed) return { satisfied: true, steps: [] }
        return {
            satisfied: false,
            steps: [
                { description: '安装 nginx（apt）', command: 'apt-get update && apt-get install -y nginx' },
                { description: '校验 nginx 配置（nginx -t）', command: 'nginx -t' },
            ],
        }
    },
}

/** redis 固定容器名（docker 模式）。 */
const REDIS_CONTAINER = 'wink-redis'
/** redis（mode: native(默认) | docker；docker 按镜像 tag 比版本、native 已装即满足；可选 maxmemory）。 */
const redis: Recipe = {
    component: 'redis',
    detect: (o = {}) =>
        o.mode === 'docker'
            ? `docker exec ${REDIS_CONTAINER} redis-server --version 2>/dev/null || true`
            : 'redis-server --version 2>/dev/null || true',
    parse: (out) => parseVersion(out, /v=(\d+\.\d+\.\d+)/), // "Redis server v=7.0.11 ..."
    converge: (desired, state, o = {}) => {
        const isDocker = o.mode === 'docker'
        if (isDocker ? versionSatisfies(desired, state.version) : state.installed) {
            return { satisfied: true, steps: [] }
        }
        const maxmemory = o.maxmemory !== undefined ? String(o.maxmemory) : null
        if (isDocker) {
            const mm = maxmemory ? ` --maxmemory ${shellQuote(maxmemory)}` : ''
            return {
                satisfied: false,
                steps: [
                    {
                        description: `启动 redis:${desired} 容器（${REDIS_CONTAINER}）`,
                        command: `docker run -d --name ${REDIS_CONTAINER} --restart unless-stopped -p 6379:6379 redis:${shellQuote(desired)}${mm}`,
                    },
                    {
                        description: '校验 redis 可达（redis-cli ping）',
                        command: `docker exec ${REDIS_CONTAINER} redis-cli ping`,
                    },
                ],
            }
        }
        const steps: PlanStep[] = [
            { description: '安装 redis（apt）', command: 'apt-get update && apt-get install -y redis-server' },
        ]
        if (maxmemory) {
            steps.push({
                description: `设置 maxmemory=${maxmemory}（运行时生效；持久化请用组件 configure 写 redis.conf）`,
                command: `redis-cli config set maxmemory ${shellQuote(maxmemory)}`,
            })
        }
        steps.push({ description: '校验 redis 可达（redis-cli ping）', command: 'redis-cli ping' })
        return { satisfied: false, steps }
    },
}

/** mysql 固定容器名（docker 模式）。 */
const MYSQL_CONTAINER = 'wink-mysql'
/** mysql（mode: native(默认) | docker；rootPassword 经 ${ENV_VAR} 引用，docker 模式必填；含 secret 步骤脱敏）。 */
const mysql: Recipe = {
    component: 'mysql',
    detect: (o = {}) =>
        o.mode === 'docker'
            ? `docker exec ${MYSQL_CONTAINER} mysqld --version 2>/dev/null || true`
            : 'mysqld --version 2>/dev/null || mysql --version 2>/dev/null || true',
    parse: (out) => parseVersion(out, /Ver (\d+\.\d+\.\d+)/), // "mysqld  Ver 8.0.35 for Linux ..."
    converge: (desired, state, o = {}) => {
        const isDocker = o.mode === 'docker'
        if (isDocker ? versionSatisfies(desired, state.version) : state.installed) {
            return { satisfied: true, steps: [] }
        }
        const rootPassword = o.rootPassword !== undefined ? String(o.rootPassword) : null
        if (isDocker) {
            if (!rootPassword) {
                throw new ConfigError('mysql（docker 模式）需 rootPassword（建议用 ${ENV_VAR} 引用，不落明文）')
            }
            // 命令含明文密码，由编排层按 secret 值统一脱敏后才对外暴露（--json/审计）
            return {
                satisfied: false,
                steps: [
                    {
                        description: `启动 mysql:${desired} 容器（${MYSQL_CONTAINER}）`,
                        command: `docker run -d --name ${MYSQL_CONTAINER} --restart unless-stopped -p 3306:3306 -e MYSQL_ROOT_PASSWORD=${shellQuote(rootPassword)} mysql:${shellQuote(desired)}`,
                    },
                    {
                        description: '校验 mysql 可达（mysqladmin ping）',
                        command: `docker exec ${MYSQL_CONTAINER} mysqladmin ping`,
                    },
                ],
            }
        }
        const steps: PlanStep[] = [
            {
                description: '安装 mysql（apt，非交互）',
                command:
                    'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server',
            },
        ]
        if (rootPassword) {
            steps.push({
                description: '设置 root 密码',
                command: `mysqladmin -u root password ${shellQuote(rootPassword)}`,
            })
        }
        steps.push({ description: '校验 mysql 可达（mysqladmin ping）', command: 'mysqladmin ping' })
        return { satisfied: false, steps }
    },
}

/** 受支持的组件 recipe 注册表（语言运行时 + docker + nginx/redis/mysql）。 */
export const RECIPES: Record<string, Recipe> = { nodejs, jdk, python, docker, nginx, redis, mysql }

/** 单个组件的收敛结果。 */
export interface ComponentResult {
    /** 组件名。 */
    component: string
    /** 目标版本（布尔组件为 `'true'`）。 */
    desired: string
    /** 收敛前检测到的状态。 */
    detected: DetectState
    /** 收敛前是否已满足目标（满足则无需执行步骤，体现幂等）。 */
    satisfied: boolean
    /** 计划执行的步骤（预演与实跑都会给出，便于可见）。 */
    planned: PlanStep[]
    /** 已执行步骤的结果（预演为空）。 */
    executed: StepResult[]
    /** 计划写入的守护式配置（预演与实跑都给出，便于可见）。 */
    plannedConfigs: ConfigSpec[]
    /** 已写入配置的结果（预演为空；逐条经 {@link guard} 落地）。 */
    configured: ConfigResult[]
    /** 该组件是否成功（已满足/安装成功，且所有 configure 写入成功）。 */
    ok: boolean
}

/** provision 聚合结果。 */
export interface ProvisionResult {
    /** 是否所有组件都成功。 */
    ok: boolean
    /** 是否为预演（仅检测 + 出计划，不执行）。 */
    dryRun: boolean
    /** 各组件收敛结果。 */
    components: ComponentResult[]
}

/** 从 stack 选出要处理的组件（可用 `only` 限定子集）；校验组件均受支持、声明值合法，并带出对象形态的附加选项。 */
const selectComponents = (
    stack: StackSpec,
    only?: string[]
): { component: string; desired: string; options: ComponentOptions }[] => {
    const names = only && only.length ? only : Object.keys(stack)
    const out: { component: string; desired: string; options: ComponentOptions }[] = []
    for (const name of names) {
        if (!(name in stack)) throw new ConfigError(`stack 中未声明组件：${name}`)
        if (!RECIPES[name]) {
            throw new ConfigError(`不支持的组件：${name}（支持 ${Object.keys(RECIPES).join('/')}）`)
        }
        const value = stack[name]
        const desired = normalizeDesired(name, value)
        if (desired === null) continue // 显式关闭（false）：跳过
        // 对象形态的非 version 字段作为附加选项（如 redis/mysql 的 mode/maxmemory/rootPassword）
        const options: ComponentOptions =
            value && typeof value === 'object' && !Array.isArray(value) ? (value as ComponentOptions) : {}
        out.push({ component: name, desired, options })
    }
    return out
}

/** 对单个组件执行检测 + 收敛（预演只检测出计划；实跑顺序执行步骤、首个失败即停）。 */
const provisionOne = async (
    session: SshSession,
    recipe: Recipe,
    desired: string,
    options: ComponentOptions,
    dryRun: boolean
): Promise<ComponentResult> => {
    const probe = await execStructured(session, recipe.detect(options))
    const detected = recipe.parse(probe.stdout)
    const plan = recipe.converge(desired, detected, options)
    // 按选项里的 secret 明文值统一脱敏：命令与 stdout/stderr 对外（--json/审计）暴露前都过一遍，默认安全
    const secrets = collectSecrets(options)
    const configs = parseConfigs(options)
    const base: ComponentResult = {
        component: recipe.component,
        desired,
        detected,
        satisfied: plan.satisfied,
        planned: plan.steps.map((s) => ({ description: s.description, command: scrubSecrets(s.command, secrets) })),
        plannedConfigs: configs,
        executed: [],
        configured: [],
        ok: true,
    }
    if (dryRun) return base
    const executed: ComponentResult['executed'] = []
    let ok = true
    // 未满足才跑安装步骤；已满足（installed）则跳过安装、但仍可能要推新配置（见下）
    if (!plan.satisfied) {
        for (const step of plan.steps) {
            // 顺序执行：后续步骤依赖前序（如先装再校验）；执行真实 command，记录前脱敏
            // eslint-disable-next-line no-await-in-loop
            const r = await execStructured(session, step.command)
            const stepOk = r.code === 0
            executed.push({
                description: step.description,
                command: scrubSecrets(step.command, secrets),
                stdout: scrubSecrets(r.stdout, secrets),
                stderr: scrubSecrets(r.stderr, secrets),
                code: r.code,
                ok: stepOk,
            })
            if (!stepOk) {
                ok = false
                break // 步骤失败则停止该组件，避免在半成品上继续
            }
        }
    }
    // 守护式写配置：安装成功（或已满足）后才推配置；逐条经 guard（备份→写→校验→reload→失败回滚）。
    // 与安装状态无关——已装的服务也常要推新配置；任一文件失败即停（该文件已自动回滚到备份）。
    const configured: ConfigResult[] = []
    if (ok && configs.length) {
        const sftp = await session.sftp()
        for (const c of configs) {
            const localFile = resolveLocal(c.file)
            // eslint-disable-next-line no-await-in-loop
            const g = await guard(session, {
                target: c.remote,
                validate: c.validate,
                reload: c.reload,
                apply: () =>
                    new Promise<void>((resolve, reject) => {
                        sftp.fastPut(localFile, c.remote, (err) =>
                            err ? reject(new TransferError(`写入远程配置失败：${c.remote}`, { cause: err })) : resolve()
                        )
                    }),
            })
            configured.push({
                file: c.file,
                remote: c.remote,
                ok: g.ok,
                backup: g.backup,
                rolledBack: g.rolledBack,
                error: g.error ? scrubSecrets(g.error, secrets) : undefined,
            })
            if (!g.ok) {
                ok = false
                break
            }
        }
    }
    return { ...base, executed, configured, ok }
}

/**
 * 环境初始化：按 `stack` 声明把服务器收敛到目标栈状态。需要 connect + stack，不需要 local/remote。
 *
 * **安全模型**：写操作（安装/收敛步骤）必须 `dryRun`（预演：检测 + 出计划，不落地）或 `yes`（确认执行）
 * 二者其一；两者都没有时抛 {@link ConfigError}。检测为只读、各组件独立收敛（互不阻塞），实跑追加一条审计。
 * 步骤退出码非零不抛，作为 `ok=false` 的结构化结果返回（便于 agent 诊断）。
 */
export const provision = async (
    options?: RunOption,
    { yes = false, only }: { yes?: boolean; only?: string[] } = {}
): Promise<ProvisionResult> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const stack = config.stack
    if (!stack || Object.keys(stack).length === 0) {
        throw new ConfigError('provision 需要 stack 声明（配置文件 stack 字段）')
    }
    const selected = selectComponents(stack, only)
    if (!selected.length) throw new ConfigError('没有可处理的组件（stack 为空或均被关闭）')
    // 写护栏进 core：预演或确认二选一，CLI 与 lib 调用方都受益
    if (!config.dryRun && !yes) {
        throw new ConfigError('provision 是写操作，需 --dry-run 预演或 --yes 确认执行')
    }
    // 守护式写配置：实跑前预检本地源文件存在（fail-fast，避免连上后才发现缺文件）。
    // 预演不强求文件就位（dry-run 只出计划、不写）。
    if (!config.dryRun) {
        for (const sel of selected) {
            for (const c of parseConfigs(sel.options)) {
                const localFile = resolveLocal(c.file)
                if (!fs.existsSync(localFile)) throw new ConfigError(`configure 本地源文件不存在：${localFile}`)
            }
        }
    }
    const logger = new Logger({ debug: config.debug, json: config.json })
    return withSession(config.connect, logger, async (session) => {
        const components: ComponentResult[] = []
        for (const sel of selected) {
            // 顺序处理组件：实跑步骤多为网络安装，避免并发打满 SSH 会话；且日志可读
            // eslint-disable-next-line no-await-in-loop
            const r = await provisionOne(session, RECIPES[sel.component], sel.desired, sel.options, config.dryRun)
            components.push(r)
        }
        const ok = components.every((c) => c.ok)
        if (!config.dryRun) {
            recordAudit(config, logger, 'provision', ok, {
                components: selected.map((s) => `${s.component}@${s.desired}`),
            })
        }
        return { ok, dryRun: config.dryRun, components }
    })
}
