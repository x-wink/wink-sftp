import { describe, it, expect, vi } from 'vitest'
import { redact, Logger } from '../src/logger'

describe('redact', () => {
    it('脱敏 password / passphrase 等敏感字段', () => {
        const out = redact({
            connect: { host: 'h', username: 'u', password: 'secret', passphrase: 'p' },
        }) as {
            connect: Record<string, string>
        }
        expect(out.connect.host).toBe('h')
        expect(out.connect.username).toBe('u')
        expect(out.connect.password).toBe('******')
        expect(out.connect.passphrase).toBe('******')
    })

    it('不改动原对象（深拷贝）', () => {
        const input = { password: 'secret' }
        redact(input)
        expect(input.password).toBe('secret')
    })

    it('字段缺省值（null/undefined）不被替换为掩码', () => {
        const out = redact({ password: null }) as { password: null }
        expect(out.password).toBeNull()
    })

    it('递归脱敏数组中的对象', () => {
        const out = redact([{ key: 'k1' }, { key: 'k2' }]) as { key: string }[]
        expect(out.map((o) => o.key)).toEqual(['******', '******'])
    })
})

describe('Logger', () => {
    it('debug 仅在开启时输出到 stderr，并脱敏', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            new Logger({ debug: false }).debug('hidden')
            expect(spy).not.toHaveBeenCalled()
            new Logger({ debug: true }).debug('cfg', { password: 'secret' })
            expect(spy).toHaveBeenCalledWith('[debug]', 'cfg', { password: '******' })
        } finally {
            spy.mockRestore()
        }
    })

    it('info / warn / error 一律走 stderr', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            const logger = new Logger()
            logger.info('i')
            logger.warn('w')
            logger.error('e')
            expect(spy.mock.calls).toEqual([['i'], ['w'], ['e']])
        } finally {
            spy.mockRestore()
        }
    })

    it('result：JSON 模式写一行 JSON 到 stdout，不调用 render', () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        const render = vi.fn()
        try {
            new Logger({ json: true }).result({ ok: true }, render)
            expect(stdout).toHaveBeenCalledWith('{"ok":true}\n')
            expect(render).not.toHaveBeenCalled()
        } finally {
            stdout.mockRestore()
        }
    })

    it('result：非 JSON 模式交给 render', () => {
        const render = vi.fn()
        new Logger({ json: false }).result({ ok: true }, render)
        expect(render).toHaveBeenCalledWith({ ok: true })
    })
})
