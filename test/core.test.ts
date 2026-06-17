import { describe, it, expect } from 'vitest'
import { run } from '../src/core'

// dry-run 不建立连接，可用于校验配置解析与计划计算
const base = {
    connect: { host: 'h', port: 22, username: 'u' },
    local: 'src',
    remote: '/apps/app',
    dryRun: true,
}

describe('run（dry-run）', () => {
    it('密码登录：返回预演计划', async () => {
        const r = await run({ ...base, connect: { ...base.connect, password: 'pw' } })
        expect(r.dryRun).toBe(true)
        expect(r.ok).toBe(true)
        expect(r.transferred.length).toBeGreaterThan(0)
    })

    it('密钥登录：仅提供 privateKey 也能通过配置校验', async () => {
        const r = await run({ ...base, connect: { ...base.connect, privateKey: 'FAKE-KEY' } })
        expect(r.dryRun).toBe(true)
        expect(r.transferred.length).toBeGreaterThan(0)
    })

    it('既无密码也无私钥/agent：抛配置错误', () => {
        // resolveConfig 在 run 内同步校验，故同步抛出
        expect(() => run({ ...base })).toThrow(/connect\.password 或 connect\.privateKey/)
    })

    it('前置/后置命令进入 commands', async () => {
        const r = await run({
            ...base,
            connect: { ...base.connect, password: 'pw' },
            sftpOptions: { beforeRunCommand: 'npm run build', afterRunCommand: 'pm2 restart app' },
        })
        expect(r.commands).toEqual(['npm run build', 'pm2 restart app'])
    })
})
