import { describe, it, expect } from 'vitest'
import type { Client } from 'ssh2'
import { shellQuote, execCommand } from '../src/exec'
import { RemoteCommandError } from '../src/errors'

// 最小化的 ssh2 stream / client 桩，用于驱动 execCommand 的各分支
class Emitter {
    private handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
    on(event: string, cb: (...a: unknown[]) => void) {
        ;(this.handlers[event] ||= []).push(cb)
        return this
    }
    emit(event: string, ...args: unknown[]) {
        for (const cb of this.handlers[event] ?? []) cb(...args)
    }
}
class FakeStream extends Emitter {
    stderr = new Emitter()
}

const fakeClient = (behavior: (stream: FakeStream) => void, startErr?: Error): Client =>
    ({
        exec(_command: string, cb: (err: unknown, stream: FakeStream) => void) {
            if (startErr) {
                cb(startErr, new FakeStream())
                return
            }
            const stream = new FakeStream()
            cb(null, stream)
            setTimeout(() => behavior(stream), 0)
        },
    }) as unknown as Client

describe('shellQuote', () => {
    it('用单引号包裹普通字符串', () => {
        expect(shellQuote('abc')).toBe(`'abc'`)
    })

    it('包裹含空格的路径，使其成为单个参数', () => {
        expect(shellQuote('/apps/my app')).toBe(`'/apps/my app'`)
    })

    it('转义内部单引号（闭合→转义→重开）', () => {
        expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`)
    })

    it('中和命令注入元字符（不被 shell 解释）', () => {
        const malicious = '$(rm -rf /); `whoami`; a && b | c > d'
        const quoted = shellQuote(malicious)
        // 整体被单引号包裹，内部无裸单引号可逃逸
        expect(quoted.startsWith(`'`)).toBe(true)
        expect(quoted.endsWith(`'`)).toBe(true)
        expect(quoted).toBe(`'${malicious}'`)
    })

    it('处理文件名注入：分号与反引号被中和', () => {
        expect(shellQuote('file;rm -rf ~')).toBe(`'file;rm -rf ~'`)
    })
})

describe('execCommand', () => {
    it('退出码 0：返回结构化结果，stderr 不算失败', async () => {
        const client = fakeClient((s) => {
            s.emit('data', Buffer.from('hello'))
            s.stderr.emit('data', Buffer.from('warn'))
            s.emit('exit', 0)
        })
        const r = await execCommand(client, 'echo hi')
        expect(r).toMatchObject({ command: 'echo hi', stdout: 'hello', stderr: 'warn', code: 0 })
    })

    it('退出码非零：抛 RemoteCommandError 并携带结果', async () => {
        const client = fakeClient((s) => {
            s.stderr.emit('data', Buffer.from('boom'))
            s.emit('exit', 2)
        })
        await expect(execCommand(client, 'false')).rejects.toBeInstanceOf(RemoteCommandError)
    })

    it('命令无法启动：抛 RemoteCommandError', async () => {
        const client = fakeClient(() => {}, new Error('no channel'))
        await expect(execCommand(client, 'ls')).rejects.toThrow(/无法启动/)
    })
})
