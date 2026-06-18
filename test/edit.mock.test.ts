import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { edit } from '../src/edit'

const h = vi.hoisted(() => ({
    state: {
        execs: [] as string[],
        fastPuts: [] as { local: string; remote: string }[],
        existing: new Set<string>(), // test -e 命中的远程路径
        failExec: [] as string[], // 命令含子串则退出码 1
        failPut: false,
    },
}))

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
            setTimeout(() => {
                const m = command.match(/^test -e '(.*)'$/)
                let code = m ? (h.state.existing.has(m[1]) ? 0 : 1) : 0
                if (h.state.failExec.some((s) => command.includes(s))) code = 1
                stream.emit('exit', code)
            }, 0)
        }
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            cb(null, {
                fastPut(local: string, remote: string, done: (err?: unknown) => void) {
                    h.state.fastPuts.push({ local, remote })
                    done(h.state.failPut ? new Error('put failed') : undefined)
                },
            })
        }
    }
    return { Client: FakeClient }
})

let tmp: string
let contentFile: string
beforeEach(() => {
    h.state.execs = []
    h.state.fastPuts = []
    h.state.existing = new Set()
    h.state.failExec = []
    h.state.failPut = false
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-edit-'))
    contentFile = path.join(tmp, 'new.conf')
    fs.writeFileSync(contentFile, 'server { listen 80; }')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const conn = { host: 'h', port: 22, username: 'u', password: 'pw' }
const opts = (extra: Record<string, unknown> = {}) => ({
    remote: '/etc/nginx/nginx.conf',
    file: contentFile,
    ...extra,
})

describe('edit（守护式编辑，mock ssh2）', () => {
    it('校验通过：备份→写入→validate→reload，ok=true', async () => {
        h.state.existing.add('/etc/nginx/nginx.conf')
        const r = await edit(opts({ validate: 'nginx -t', reload: 'systemctl reload nginx' }), { connect: conn })
        expect(r.ok).toBe(true)
        expect(r.rolledBack).toBe(false)
        expect(h.state.fastPuts[0]).toMatchObject({ remote: '/etc/nginx/nginx.conf' })
        expect(h.state.execs.some((c) => c.startsWith(`cp -a '/etc/nginx/nginx.conf'`))).toBe(true) // 备份
        expect(h.state.execs).toContain('nginx -t')
        expect(h.state.execs).toContain('systemctl reload nginx')
    })

    it('校验失败：回滚到备份，ok=false、rolledBack=true', async () => {
        h.state.existing.add('/etc/nginx/nginx.conf')
        h.state.failExec = ['nginx -t']
        const r = await edit(opts({ validate: 'nginx -t', reload: 'systemctl reload nginx' }), { connect: conn })
        expect(r.ok).toBe(false)
        expect(r.rolledBack).toBe(true)
        expect(h.state.execs.some((c) => c.includes('mv ') && c.includes('.wink-bak.'))).toBe(true) // 恢复
        expect(h.state.execs).not.toContain('systemctl reload nginx') // 校验失败不应 reload
    })

    it('本地内容文件不存在：抛配置错误', async () => {
        await expect(edit(opts({ file: path.join(tmp, 'nope') }), { connect: conn })).rejects.toThrow(/不存在/)
    })

    it('写入失败：回滚（目标原存在）', async () => {
        h.state.existing.add('/etc/nginx/nginx.conf')
        h.state.failPut = true
        const r = await edit(opts(), { connect: conn })
        expect(r.ok).toBe(false)
        expect(r.rolledBack).toBe(true)
    })
})
