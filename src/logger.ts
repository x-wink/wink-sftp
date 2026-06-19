/** 需要脱敏的敏感字段名。 */
const SECRET_KEYS = new Set(['password', 'passphrase', 'privatekey', 'key'])

/**
 * 深拷贝并脱敏对象中的敏感字段（password / passphrase / privateKey 等），
 * 用于 debug 打印配置时不泄露明文凭据。
 */
export const redact = <T>(value: T): T => {
    if (Array.isArray(value)) {
        return value.map((item) => redact(item)) as unknown as T
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const isSecret = SECRET_KEYS.has(k.toLowerCase()) && v !== null && v !== undefined
            out[k] = isSecret ? '******' : redact(v)
        }
        return out as T
    }
    return value
}

export interface LoggerOptions {
    /** 输出调试日志。 */
    debug?: boolean
    /** JSON 模式：结果对象走 stdout，人类日志仍走 stderr。 */
    json?: boolean
}

/**
 * 分级日志：人类可读日志一律走 **stderr**；机器可读结果（`--json`）走 **stdout**。
 * 保证 `winkops ... --json | jq` 成立。
 */
export class Logger {
    constructor(private readonly options: LoggerOptions = {}) {}

    debug(...args: unknown[]): void {
        if (this.options.debug) console.error('[debug]', ...args.map(redact))
    }
    info(...args: unknown[]): void {
        console.error(...args)
    }
    warn(...args: unknown[]): void {
        console.error(...args)
    }
    error(...args: unknown[]): void {
        console.error(...args)
    }

    /**
     * 输出最终结果：JSON 模式写一行 JSON 到 stdout；否则把人类摘要交给 `render` 写 stderr。
     */
    result(payload: unknown, render: (payload: unknown) => void): void {
        if (this.options.json) {
            process.stdout.write(JSON.stringify(payload) + '\n')
        } else {
            render(payload)
        }
    }
}
