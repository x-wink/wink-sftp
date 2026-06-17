import { describe, it, expect } from 'vitest'
import { redact } from '../src/logger'

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
})
