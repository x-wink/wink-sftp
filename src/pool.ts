/** 默认并发上限：保守取 5，避免超出 SSH 服务端 `MaxSessions`（典型默认 10）。 */
export const DEFAULT_CONCURRENCY = 5

/**
 * 以受限并发对 `items` 逐个执行 `worker`，结果按**原始顺序**返回。
 *
 * 与裸 `Promise.all` 不同：同一时刻最多 `concurrency` 个任务在飞，避免一次性
 * 打满 SSH 会话。任一 `worker` 抛错则整体 reject（沿用 `Promise.all` 语义，
 * 失败收集由调用方在 `worker` 内自行处理）。
 *
 * @param concurrency 并发上限；非正数会被收敛为 1。
 */
export const mapPool = async <T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
    const limit = Math.max(1, Math.floor(concurrency) || 1)
    const results: R[] = Array.from({ length: items.length })
    let next = 0
    const runner = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++
            // 单个 slot 内按序消费任务；并发由多个 runner 提供，故此处 await 必要
            // oxlint-disable-next-line no-await-in-loop
            results[index] = await worker(items[index], index)
        }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner())
    await Promise.all(workers)
    return results
}
