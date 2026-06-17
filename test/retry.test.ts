import { describe, it, expect } from 'vitest'
import { withRetry, DEFAULT_RETRIES } from '../src/retry'

describe('withRetry', () => {
    it('首次成功则不重试', async () => {
        let calls = 0
        const out = await withRetry(
            async () => {
                calls++
                return 'ok'
            },
            { retries: 2 }
        )
        expect(out).toBe('ok')
        expect(calls).toBe(1)
    })

    it('失败后重试，最终成功返回结果', async () => {
        let calls = 0
        const out = await withRetry(
            async () => {
                calls++
                if (calls < 3) throw new Error('flaky')
                return calls
            },
            { retries: 2 }
        )
        expect(out).toBe(3)
        expect(calls).toBe(3)
    })

    it('耗尽重试后抛出最后一次错误', async () => {
        let calls = 0
        await expect(
            withRetry(
                async () => {
                    calls++
                    throw new Error(`fail-${calls}`)
                },
                { retries: 2 }
            )
        ).rejects.toThrow('fail-3')
        expect(calls).toBe(3)
    })

    it('retries 为 0 时只尝试一次', async () => {
        let calls = 0
        await expect(
            withRetry(
                async () => {
                    calls++
                    throw new Error('boom')
                },
                { retries: 0 }
            )
        ).rejects.toThrow('boom')
        expect(calls).toBe(1)
    })

    it('每次重试前回调 onRetry，attempt 从 1 计数', async () => {
        const attempts: number[] = []
        await withRetry(
            async () => {
                if (attempts.length < 2) throw new Error('x')
                return 1
            },
            { retries: 3, onRetry: (attempt) => attempts.push(attempt) }
        )
        expect(attempts).toEqual([1, 2])
    })

    it('默认重试次数为 2', () => {
        expect(DEFAULT_RETRIES).toBe(2)
    })
})
