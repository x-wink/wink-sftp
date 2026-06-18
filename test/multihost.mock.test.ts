import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMany, runAuto } from '../src/core'

// host 为 'bad' 的连接会握手失败，借此模拟单机失败；其余主机正常部署。
vi.mock('ssh2', () => {
    class Emitter {
        private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
        on(event: string, cb: (...args: unknown[]) => void) {
            ;(this.handlers[event] ||= []).push(cb)
            return this
        }
        emit(event: string, ...args: unknown[]) {
            for (const cb of this.handlers[event] ?? []) cb(...args)
        }
    }
    class FakeClient extends Emitter {
        connect(cfg: { host?: string }) {
            setTimeout(() => (cfg.host === 'bad' ? this.emit('error', new Error('refused')) : this.emit('ready')), 0)
            return this
        }
        end() {}
        exec(_command: string, cb: (err: unknown, stream: unknown) => void) {
            const stream = new Emitter() as Emitter & { stderr: Emitter }
            stream.stderr = new Emitter()
            cb(null, stream)
            setTimeout(() => stream.emit('exit', 0), 0)
        }
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            cb(null, {
                fastPut: (_f: string, _t: string, _o: unknown, done: (e?: unknown) => void) => done(),
                stat: (_t: string, done: (e: unknown, s?: unknown) => void) => done(new Error('none')),
                utimes: (_t: string, _a: number, _m: number, done: (e?: unknown) => void) => done(),
            })
        }
    }
    return { Client: FakeClient }
})

let localDir: string
beforeEach(() => {
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-multi-'))
    fs.writeFileSync(path.join(localDir, 'a.txt'), 'a')
})
afterEach(() => fs.rmSync(localDir, { recursive: true, force: true }))

const base = (hosts: { host: string }[], extra: Record<string, unknown> = {}) => ({
    connect: { port: 22, username: 'u', password: 'pw' },
    local: localDir,
    remote: '/remote',
    audit: false,
    sftpOptions: { override: true },
    hosts,
    ...extra,
})

describe('runMany（多机部署）', () => {
    it('全部成功：ok=true，按序聚合每台结果', async () => {
        const r = await runMany(base([{ host: 'h1' }, { host: 'h2' }]))
        expect(r.ok).toBe(true)
        expect(r.hosts.map((h) => h.host)).toEqual(['h1', 'h2'])
        expect(r.hosts.every((h) => h.ok && h.result?.transferred.length === 1)).toBe(true)
    })

    it('continue（默认）：单台连接失败不影响其它，所有主机都被尝试', async () => {
        const r = await runMany(base([{ host: 'h1' }, { host: 'bad' }, { host: 'h3' }]))
        expect(r.ok).toBe(false)
        expect(r.hosts).toHaveLength(3)
        const bad = r.hosts.find((h) => h.host === 'bad')
        expect(bad?.ok).toBe(false)
        expect(bad?.error?.kind).toBe('connection')
        expect(r.hosts.filter((h) => h.ok).map((h) => h.host)).toEqual(['h1', 'h3'])
    })

    it('failFast：首台失败即停，跳过其余主机', async () => {
        const r = await runMany(base([{ host: 'h1' }, { host: 'bad' }, { host: 'h3' }], { failFast: true }))
        expect(r.ok).toBe(false)
        expect(r.hosts.map((h) => h.host)).toEqual(['h1', 'bad']) // h3 未尝试
    })

    it('无主机：抛配置错误', async () => {
        await expect(runMany(base([]))).rejects.toThrow(/至少一台主机/)
    })
})

describe('runAuto（自动分派）', () => {
    it('有 hosts：走多机，返回含 hosts 的聚合结果', async () => {
        const r = await runAuto(base([{ host: 'h1' }]))
        expect('hosts' in r).toBe(true)
    })

    it('无 hosts：走单机，返回 DeployResult', async () => {
        const r = await runAuto({
            connect: { host: 'h1', port: 22, username: 'u', password: 'pw' },
            local: localDir,
            remote: '/remote',
            audit: false,
            sftpOptions: { override: true },
        })
        expect('hosts' in r).toBe(false)
        expect((r as { transferred: string[] }).transferred).toHaveLength(1)
    })
})
