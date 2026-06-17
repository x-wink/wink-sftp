/** 默认重试次数（不含首次尝试）。 */
export const DEFAULT_RETRIES = 2

export interface RetryOptions {
    /** 额外重试次数（不含首次）；非正数视为不重试。 */
    retries: number
    /** 每次重试前的延迟毫秒数，按尝试次数线性递增（第 n 次重试等 `delayMs * n`）。默认 0。 */
    delayMs?: number
    /** 每次重试前回调，便于上层打印日志。`attempt` 从 1 计数。 */
    onRetry?: (attempt: number, error: unknown) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 反复执行 `fn` 直到成功或耗尽重试次数。
 *
 * 首次失败后最多再重试 `retries` 次（共 `retries + 1` 次尝试）；全部失败则抛出
 * **最后一次**的错误。用于抵御真实网络抖动下的单文件传输失败。
 */
export const withRetry = async <T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> => {
    const retries = Math.max(0, Math.floor(options.retries) || 0)
    const delayMs = options.delayMs ?? 0
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // oxlint-disable-next-line no-await-in-loop
            return await fn()
        } catch (e) {
            lastError = e
            if (attempt < retries) {
                options.onRetry?.(attempt + 1, e)
                // oxlint-disable-next-line no-await-in-loop
                if (delayMs > 0) await sleep(delayMs * (attempt + 1))
            }
        }
    }
    throw lastError
}
