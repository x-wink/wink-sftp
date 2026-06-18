import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SshSession, withSession } from '../src/session'
import { Logger } from '../src/logger'

// 共享 mock 状态
const h = vi.hoisted(() => ({
    state: {
        ended: 0,
        sftpOpens: 0,
        execs: [] as string[],
    },
}))

// 用连接配置的 host 控制握手结果：'bad' → error，'slow' → timeout，其余 → ready
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
            setTimeout(() => {
                if (cfg.host === 'bad') this.emit('error', new Error('refused'))
                else if (cfg.host === 'slow') this.emit('timeout')
                else this.emit('ready')
            }, 0)
            return this
        }
        end() {
            h.state.ended++
        }
        exec(command: string, cb: (err: unknown, stream: unknown) => void) {
            h.state.execs.push(command)
            const stream = new Emitter() as Emitter & { stderr: Emitter }
            stream.stderr = new Emitter()
            cb(null, stream)
            // 命令含 'fail' → 退出码 1，否则 0
            setTimeout(() => stream.emit('exit', command.includes('fail') ? 1 : 0), 0)
        }
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            h.state.sftpOpens++
            cb(null, { _fake: true })
        }
    }
    return { Client: FakeClient }
})

beforeEach(() => {
    h.state.ended = 0
    h.state.sftpOpens = 0
    h.state.execs = []
})

const logger = new Logger()

describe('SshSession', () => {
    it('open 成功后可 exec，close 断开连接', async () => {
        const s = new SshSession({ host: 'ok', port: 22, username: 'u' }, logger)
        await s.open()
        const r = await s.exec('ls')
        expect(r.code).toBe(0)
        expect(h.state.execs).toContain('ls')
        s.close()
        expect(h.state.ended).toBe(1)
    })

    it('未 open 即 exec：抛连接未建立错误', async () => {
        const s = new SshSession({ host: 'ok', port: 22, username: 'u' })
        await expect(s.exec('ls')).rejects.toThrow(/会话未建立/)
    })

    it('sftp 通道复用：多次调用只开一次', async () => {
        const s = new SshSession({ host: 'ok', port: 22, username: 'u' })
        await s.open()
        const a = await s.sftp()
        const b = await s.sftp()
        expect(a).toBe(b)
        expect(h.state.sftpOpens).toBe(1)
        s.close()
    })

    it('连接失败：reject 类型化连接错误', async () => {
        const s = new SshSession({ host: 'bad', port: 22, username: 'u' })
        await expect(s.open()).rejects.toThrow(/SSH 连接失败/)
    })

    it('握手超时：reject 会话超时', async () => {
        const s = new SshSession({ host: 'slow', port: 22, username: 'u' })
        await expect(s.open()).rejects.toThrow(/会话超时/)
    })

    it('raw 在 open 前为 null、open 后可取、close 后回到 null', async () => {
        const s = new SshSession({ host: 'ok', port: 22, username: 'u' })
        expect(s.raw).toBeNull()
        await s.open()
        expect(s.raw).not.toBeNull()
        s.close()
        expect(s.raw).toBeNull()
    })
})

describe('withSession', () => {
    it('运行 fn 后保证断开', async () => {
        const out = await withSession({ host: 'ok', port: 22, username: 'u' }, logger, async (s) => {
            await s.exec('whoami')
            return 'done'
        })
        expect(out).toBe('done')
        expect(h.state.ended).toBe(1)
    })

    it('fn 抛错也断开连接并向上抛', async () => {
        await expect(
            withSession({ host: 'ok', port: 22, username: 'u' }, logger, async () => {
                throw new Error('boom')
            })
        ).rejects.toThrow('boom')
        expect(h.state.ended).toBe(1)
    })
})
