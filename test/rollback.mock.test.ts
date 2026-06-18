import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rollback } from '../src/core'

// 受控的远程父目录内容（含两份快照）+ 记录的 exec 命令
const h = vi.hoisted(() => ({
    state: {
        entries: [] as string[],
        execs: [] as string[],
    },
}))

const makeAttrs = () => ({
    size: 0,
    mtime: 1700000000,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
})

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
        connect() {
            setTimeout(() => this.emit('ready'), 0)
            return this
        }
        end() {}
        exec(command: string, cb: (err: unknown, stream: unknown) => void) {
            h.state.execs.push(command)
            const stream = new Emitter() as Emitter & { stderr: Emitter }
            stream.stderr = new Emitter()
            cb(null, stream)
            setTimeout(() => stream.emit('exit', 0), 0)
        }
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            cb(null, {
                readdir(_p: string, done: (err: unknown, list?: unknown) => void) {
                    done(
                        null,
                        h.state.entries.map((name) => ({ filename: name, attrs: makeAttrs() }))
                    )
                },
            })
        }
    }
    return { Client: FakeClient }
})

beforeEach(() => {
    h.state.entries = []
    h.state.execs = []
})

const conn = { host: 'h', port: 22, username: 'u', password: 'pw' }

describe('rollback（手动回滚）', () => {
    it('取时间戳最大的快照恢复', async () => {
        h.state.entries = ['app', 'app.wink-bak.100', 'app.wink-bak.300', 'app.wink-bak.200', 'other']
        const r = await rollback({ connect: conn, remote: '/srv/app' })
        expect(r.ok).toBe(true)
        expect(r.backup).toBe('/srv/app.wink-bak.300')
        expect(h.state.execs).toContain(`rm -rf '/srv/app' && mv '/srv/app.wink-bak.300' '/srv/app'`)
    })

    it('按数值而非字符串取最新：位数不同的时间戳也正确（100 > 90）', async () => {
        h.state.entries = ['app', 'app.wink-bak.90', 'app.wink-bak.100']
        const r = await rollback({ connect: conn, remote: '/srv/app' })
        // 字符串降序会误选 '90'（'9' > '1'）；数值降序应选 100
        expect(r.backup).toBe('/srv/app.wink-bak.100')
    })

    it('无快照：ok=false、backup=null、不执行恢复命令', async () => {
        h.state.entries = ['app', 'unrelated']
        const r = await rollback({ connect: conn, remote: '/srv/app' })
        expect(r.ok).toBe(false)
        expect(r.backup).toBeNull()
        expect(h.state.execs.some((c) => c.startsWith('rm -rf'))).toBe(false)
    })
})
