import { describe, it, expect } from 'vitest'
import { mapPool, DEFAULT_CONCURRENCY } from '../src/pool'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('mapPool', () => {
    it('按原始顺序返回结果（即便完成顺序不同）', async () => {
        const out = await mapPool([3, 1, 2], 2, async (n) => {
            await new Promise((r) => setTimeout(r, n))
            return n * 10
        })
        expect(out).toEqual([30, 10, 20])
    })

    it('同一时刻在飞任务数不超过并发上限', async () => {
        let active = 0
        let peak = 0
        await mapPool(
            Array.from({ length: 10 }, (_, i) => i),
            3,
            async () => {
                active++
                peak = Math.max(peak, active)
                await tick()
                active--
            }
        )
        expect(peak).toBeLessThanOrEqual(3)
    })

    it('worker 收到正确的下标', async () => {
        const out = await mapPool(['a', 'b', 'c'], 2, async (item, index) => `${index}:${item}`)
        expect(out).toEqual(['0:a', '1:b', '2:c'])
    })

    it('空列表直接返回空数组，不调用 worker', async () => {
        let called = false
        const out = await mapPool([], 5, async () => {
            called = true
            return 1
        })
        expect(out).toEqual([])
        expect(called).toBe(false)
    })

    it('并发上限非正数时收敛为 1（串行）', async () => {
        let active = 0
        let peak = 0
        await mapPool([1, 2, 3], 0, async () => {
            active++
            peak = Math.max(peak, active)
            await tick()
            active--
        })
        expect(peak).toBe(1)
    })

    it('任一 worker 抛错则整体 reject', async () => {
        await expect(
            mapPool([1, 2, 3], 2, async (n) => {
                if (n === 2) throw new Error('boom')
                return n
            })
        ).rejects.toThrow('boom')
    })

    it('默认并发上限为 5', () => {
        expect(DEFAULT_CONCURRENCY).toBe(5)
    })
})
