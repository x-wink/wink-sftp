import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import type { RunOption, ResolvedConfig, SftpOption } from './core'
import { resolveLocal } from './pathmap'
import { defaultAuditPath } from './audit'
import { ConfigError } from './errors'

/**
 * 配置 schema（zod 单一事实源）：校验从 **文件**（JSON / YAML）加载的配置结构。
 * 编程式调用的 {@link RunOption} 由 TypeScript 静态保证，不再二次校验。
 *
 * `connect` 用 `looseObject` 放行 ssh2 `ConnectConfig` 的其余字段（如 `readyTimeout`），
 * 仅对本工具关心的字段约束类型。顶层未知字段被静默剔除，便于向后兼容地新增字段。
 */
const connectSchema = z.looseObject({
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    agent: z.string().optional(),
})

const sftpOptionsSchema = z.object({
    excludes: z.array(z.string()).optional(),
    flat: z.boolean().optional(),
    clear: z.boolean().optional(),
    override: z.boolean().optional(),
    debug: z.boolean().optional(),
    mode: z.number().optional(),
    ignoreHidden: z.boolean().optional(),
    beforeRunCommand: z.string().optional(),
    afterRunCommand: z.string().optional(),
    concurrency: z.number().optional(),
    retries: z.number().optional(),
})

/** 基础配置字段（也是每个环境覆盖项可包含的字段）。 */
const baseShape = {
    connect: connectSchema.optional(),
    local: z.string().optional(),
    remote: z.string().optional(),
    sftpOptions: sftpOptionsSchema.optional(),
    debug: z.boolean().optional(),
    json: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    audit: z.boolean().optional(),
    auditLog: z.string().optional(),
}

export const configSchema = z.object({
    ...baseShape,
    // 多环境：environments.<name> 为覆盖项，--env <name> 选中后深合并到基础配置之上
    environments: z.record(z.string(), z.object(baseShape)).optional(),
})

/** 把 zod 校验问题列表压成一行可读信息（`字段路径: 原因`）。 */
const formatIssues = (issues: z.core.$ZodIssue[]): string =>
    issues.map((i) => `${i.path.join('.') || '<root>'}：${i.message}`).join('；')

/** 匹配 `${VAR_NAME}` 占位（变量名首字符非数字）。 */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 解析一行行的 `.env` 文本为键值表：忽略空行与 `#` 注释，支持 `export KEY=`，
 * 去除值两侧成对的引号。仅覆盖单行值的常见写法，不处理多行/转义。
 */
export const parseDotEnv = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (!m) continue
        let val = m[2].trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
        }
        out[m[1]] = val
    }
    return out
}

/** 读取 cwd 下的 `.env`（若存在）为键值表；不存在或读失败均返回空表，绝不抛错。 */
const loadDotEnv = (): Record<string, string> => {
    try {
        const p = resolveLocal('.env')
        return fs.existsSync(p) ? parseDotEnv(fs.readFileSync(p, 'utf8')) : {}
    } catch {
        return {}
    }
}

/**
 * 递归把配置中所有字符串里的 `${ENV_VAR}` 替换为环境变量值，不落明文。
 * 返回替换后的副本与「引用了但未定义」的变量名列表（由调用方决定是否报错）。
 */
export const interpolateSecrets = <T>(
    value: T,
    env: Record<string, string | undefined>
): { value: T; missing: string[] } => {
    const missing = new Set<string>()
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
            return v.replace(ENV_REF, (_, name: string) => {
                const resolved = env[name]
                if (resolved === undefined) {
                    missing.add(name)
                    return ''
                }
                return resolved
            })
        }
        if (Array.isArray(v)) return v.map(walk)
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {}
            for (const [k, val] of Object.entries(v)) out[k] = walk(val)
            return out
        }
        return v
    }
    return { value: walk(value) as T, missing: [...missing] }
}

/**
 * 读取并解析配置文件，按扩展名区分格式：`.yaml` / `.yml` 走 YAML，其余按 JSON。
 * 读取或解析失败、结构非法均抛 {@link ConfigError}。返回经 zod 校验的配置对象。
 */
export const loadConfigFile = (configPath: string): RunOption => {
    const abs = resolveLocal(configPath)
    let text: string
    try {
        text = fs.readFileSync(abs, 'utf8')
    } catch (e) {
        throw new ConfigError(`读取配置文件失败：${configPath}`, { cause: e })
    }
    const ext = path.extname(abs).toLowerCase()
    let data: unknown
    try {
        data = ext === '.yaml' || ext === '.yml' ? yaml.load(text) : JSON.parse(text)
    } catch (e) {
        throw new ConfigError(`解析配置文件失败：${configPath}`, { cause: e })
    }
    // 先注入 ${ENV_VAR} secrets（环境变量优先于 .env），再交 zod 校验最终结构
    const { value: interpolated, missing } = interpolateSecrets(data, { ...loadDotEnv(), ...process.env })
    if (missing.length) {
        throw new ConfigError(`配置引用了未定义的环境变量：${missing.join('、')}（请在环境变量或 .env 中提供）`)
    }
    data = interpolated
    const parsed = configSchema.safeParse(data)
    if (!parsed.success) {
        throw new ConfigError(`配置文件校验失败：${configPath}（${formatIssues(parsed.error.issues)}）`)
    }
    return parsed.data as RunOption
}

/** 判断是否为可深合并的普通对象（排除数组与 null）。 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 深合并 `override` 到 `base` 之上（返回新对象）：两侧均为普通对象的键递归合并，
 * 否则 `override` 覆盖（数组与标量整体替换）。用于把所选环境覆盖叠加到基础配置。
 */
export const deepMerge = <T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T => {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(override)) {
        if (v === undefined) continue
        out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v
    }
    return out as T
}

/**
 * 按 `options.env` 选中的环境名，把 `raw.environments[name]` 深合并到基础配置之上。
 * 未选环境时原样返回；选了但不存在该环境抛 {@link ConfigError}。
 */
const applyEnv = (raw: RunOption, selected?: string): RunOption => {
    if (!selected) return raw
    const override = raw.environments?.[selected]
    if (!override) {
        const available = Object.keys(raw.environments ?? {})
        throw new ConfigError(
            `未找到环境配置：${selected}（可用环境：${available.length ? available.join('、') : '无'}）`
        )
    }
    return deepMerge(raw as Record<string, unknown>, override as Record<string, unknown>) as RunOption
}

/** 合并配置文件 / CLI 选项并校验，返回归一化配置。校验失败抛 {@link ConfigError}。 */
export const resolveConfig = (options: RunOption = {}): ResolvedConfig => {
    const { config = false } = options
    // json / dryRun / debug 是调用级开关，即便用 -c 配置文件也应生效（叠加在文件之上）。
    const cliDebug = options.debug ?? false
    const cliJson = options.json ?? false
    const cliDryRun = options.dryRun ?? false
    // env 同为调用级开关：选中的环境名来自 options（CLI/编程式），环境表来自加载后的配置
    const raw: RunOption = applyEnv(config ? loadConfigFile(config) : options, options.env)
    const connect = raw.connect ?? {}
    // 密码登录或密钥登录二选一：privateKey / agent 任一存在即可，允许密码留空
    const hasAuth = Boolean(connect.password) || Boolean(connect.privateKey) || Boolean(connect.agent)
    if (!connect.host || !connect.port || !connect.username || !hasAuth || !raw.local || !raw.remote) {
        throw new ConfigError(
            '配置至少包含以下属性：connect.host、connect.port、connect.username、' +
                'connect.password 或 connect.privateKey（或 connect.agent）、local、remote'
        )
    }
    const debug = raw.debug ?? cliDebug
    const sftpOptions: SftpOption = { ...raw.sftpOptions }
    sftpOptions.debug ??= debug
    return {
        connect,
        local: raw.local,
        remote: raw.remote,
        sftpOptions,
        debug,
        json: (raw.json ?? false) || cliJson,
        dryRun: (raw.dryRun ?? false) || cliDryRun,
        // 调用级开关优先于配置文件：CLI 显式 --no-audit（options.audit === false）必须生效，
        // 否则取配置文件值、再默认开启；auditLog 同理由 CLI 覆盖文件。
        audit: options.audit === false ? false : (raw.audit ?? true),
        auditLog: options.auditLog ?? raw.auditLog ?? defaultAuditPath(),
    }
}
