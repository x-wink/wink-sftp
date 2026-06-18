import { withSession } from './session'
import type { SshSession } from './session'
import { resolveConfig } from './config'
import { Logger } from './logger'
import { recordAudit } from './audit'
import { execStructured } from './ops'
import { shellQuote } from './exec'
import { ConfigError } from './errors'
import type { RunOption, StackValue, StackSpec } from './core'

/**
 * 环境初始化（单机 provision）：按声明式 `stack` 把服务器**收敛**到目标栈状态。
 *
 * 设计与 `service` 一致——recipe 用**纯函数**（检测命令字符串 + `parse` 解析 + `converge` 规划）描述，
 * 编排器只负责「执行检测 → 算收敛步骤 → 预演或执行」，便于 fixture 单测、e2e 只验证编排/连通。
 *
 * 本批交付语言运行时 + docker 四个 recipe（node/jdk/python/docker）；nginx/redis/mysql 等需守护式
 * `configure` 的 recipe 复用 {@link guard}，留待下批。边界：面向固定栈的策划式 recipes，非通用 CM 引擎。
 */

/** 组件当前安装状态（由 recipe 的 `parse` 从检测输出归一化）。 */
export interface DetectState {
    /** 是否已安装（检测到版本）。 */
    installed: boolean
    /** 检测到的版本（未安装为 null）。 */
    version: string | null
}

/** 一个收敛步骤：人类描述 + 实际远程命令。 */
export interface PlanStep {
    description: string
    command: string
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
    /** 检测命令（版本无关，检测当前默认版本）。 */
    detect: string
    /** 解析检测输出为安装状态。 */
    parse(output: string): DetectState
    /** 给定目标版本（`normalizeDesired` 归一化后的字符串）与检测状态产出收敛步骤。 */
    converge(desired: string, state: DetectState): ConvergePlan
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
    if (typeof value === 'string' || typeof value === 'number') return String(value)
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

/** nvm 安装脚本（固定版本，避免随上游 HEAD 漂移）。 */
const NVM_INSTALLER = 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh'

/** Node.js（经 nvm 版本管理）。 */
const nodejs: Recipe = {
    component: 'nodejs',
    detect: 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; node --version 2>/dev/null || true',
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
    detect: 'export SDKMAN_DIR="${SDKMAN_DIR:-$HOME/.sdkman}"; [ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ] && . "$SDKMAN_DIR/bin/sdkman-init.sh"; java -version 2>&1 | head -n 1 || true',
    // java -version 形如 `openjdk version "17.0.9" 2023-...` 或 `java version "1.8.0_292"`
    parse: (out) => parseVersion(out, /version "(\d[\d._]*)"/),
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
    detect: 'export PYENV_ROOT="${PYENV_ROOT:-$HOME/.pyenv}"; export PATH="$PYENV_ROOT/bin:$PATH"; command -v pyenv >/dev/null 2>&1 && eval "$(pyenv init - 2>/dev/null)"; python --version 2>&1 || true',
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
    detect: 'docker --version 2>/dev/null || true',
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

/** 受支持的组件 recipe 注册表（本批：语言运行时 + docker）。 */
export const RECIPES: Record<string, Recipe> = { nodejs, jdk, python, docker }

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
    executed: { description: string; command: string; ok: boolean; stdout: string; stderr: string; code: number }[]
    /** 该组件是否成功（已满足、或全部步骤退出码 0）。 */
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

/** 从 stack 选出要处理的组件（可用 `only` 限定子集）；校验组件均受支持、声明值合法。 */
const selectComponents = (stack: StackSpec, only?: string[]): { component: string; desired: string }[] => {
    const names = only && only.length ? only : Object.keys(stack)
    const out: { component: string; desired: string }[] = []
    for (const name of names) {
        if (!(name in stack)) throw new ConfigError(`stack 中未声明组件：${name}`)
        if (!RECIPES[name]) {
            throw new ConfigError(`不支持的组件：${name}（本批支持 ${Object.keys(RECIPES).join('/')}）`)
        }
        const desired = normalizeDesired(name, stack[name])
        if (desired === null) continue // 显式关闭（false）：跳过
        out.push({ component: name, desired })
    }
    return out
}

/** 对单个组件执行检测 + 收敛（预演只检测出计划；实跑顺序执行步骤、首个失败即停）。 */
const provisionOne = async (
    session: SshSession,
    recipe: Recipe,
    desired: string,
    dryRun: boolean
): Promise<ComponentResult> => {
    const probe = await execStructured(session, recipe.detect)
    const detected = recipe.parse(probe.stdout)
    const plan = recipe.converge(desired, detected)
    const base: ComponentResult = {
        component: recipe.component,
        desired,
        detected,
        satisfied: plan.satisfied,
        planned: plan.steps,
        executed: [],
        ok: true,
    }
    if (dryRun || plan.satisfied) return base
    const executed: ComponentResult['executed'] = []
    let ok = true
    for (const step of plan.steps) {
        // 顺序执行：后续步骤依赖前序（如先装版本管理器再装运行时）
        // eslint-disable-next-line no-await-in-loop
        const r = await execStructured(session, step.command)
        const stepOk = r.code === 0
        executed.push({ description: step.description, command: step.command, ...r, ok: stepOk })
        if (!stepOk) {
            ok = false
            break // 步骤失败则停止该组件，避免在半成品上继续
        }
    }
    return { ...base, executed, ok }
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
    const logger = new Logger({ debug: config.debug, json: config.json })
    return withSession(config.connect, logger, async (session) => {
        const components: ComponentResult[] = []
        for (const { component, desired } of selected) {
            // 顺序处理组件：实跑步骤多为网络安装，避免并发打满 SSH 会话；且日志可读
            // eslint-disable-next-line no-await-in-loop
            components.push(await provisionOne(session, RECIPES[component], desired, config.dryRun))
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
