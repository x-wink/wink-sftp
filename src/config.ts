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

export const configSchema = z.object({
    connect: connectSchema.optional(),
    local: z.string().optional(),
    remote: z.string().optional(),
    sftpOptions: sftpOptionsSchema.optional(),
    debug: z.boolean().optional(),
    json: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    audit: z.boolean().optional(),
    auditLog: z.string().optional(),
})

/** 把 zod 校验问题列表压成一行可读信息（`字段路径: 原因`）。 */
const formatIssues = (issues: z.core.$ZodIssue[]): string =>
    issues.map((i) => `${i.path.join('.') || '<root>'}：${i.message}`).join('；')

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
    const parsed = configSchema.safeParse(data)
    if (!parsed.success) {
        throw new ConfigError(`配置文件校验失败：${configPath}（${formatIssues(parsed.error.issues)}）`)
    }
    return parsed.data as RunOption
}

/** 合并配置文件 / CLI 选项并校验，返回归一化配置。校验失败抛 {@link ConfigError}。 */
export const resolveConfig = (options: RunOption = {}): ResolvedConfig => {
    const { config = false } = options
    // json / dryRun / debug 是调用级开关，即便用 -c 配置文件也应生效（叠加在文件之上）。
    const cliDebug = options.debug ?? false
    const cliJson = options.json ?? false
    const cliDryRun = options.dryRun ?? false
    const raw: RunOption = config ? loadConfigFile(config) : options
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
