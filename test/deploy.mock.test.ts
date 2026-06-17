import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../src/core'

// 共享 mock 状态（vi.hoisted 保证在 vi.mock 工厂中可见）
const h = vi.hoisted(() => ({
    state: {
        execs: [] as string[],
        fastPuts: [] as string[],
        existing: new Set<string>(),
        /** target → 还需失败的次数（Infinity 表示永久失败）。 */
        failRemaining: new Map<string, number>(),
        ended: false,
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
        end() {
            h.state.ended = true
        }
        exec(command: string, cb: (err: unknown, stream: unknown) => void) {
            h.state.execs.push(command)
            const stream = new Emitter() as Emitter & { stderr: Emitter }
            stream.stderr = new Emitter()
            cb(null, stream)
            setTimeout(() => {
                const m = command.match(/^stat '(.*)'$/)
                const code = m ? (h.state.existing.has(m[1]) ? 0 : 1) : 0
                stream.emit('exit', code)
            }, 0)
        }
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            cb(null, {
                fastPut(_file: string, target: string, _opts: unknown, done: (err?: unknown) => void) {
                    h.state.fastPuts.push(target)
                    const rem = h.state.failRemaining.get(target) ?? 0
                    if (rem > 0) {
                        if (rem !== Infinity) h.state.failRemaining.set(target, rem - 1)
                        done(new Error('flaky'))
                    } else {
                        done()
                    }
                },
            })
        }
    }
    return { Client: FakeClient }
})

let localDir: string
const REMOTE = '/remote'

// 每个用例构造一个含 a.txt / b.txt / sub/c.txt 的本地目录
beforeEach(() => {
    h.state.execs = []
    h.state.fastPuts = []
    h.state.existing = new Set()
    h.state.failRemaining = new Map()
    h.state.ended = false
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-deploy-'))
    fs.writeFileSync(path.join(localDir, 'a.txt'), 'a')
    fs.writeFileSync(path.join(localDir, 'b.txt'), 'b')
    fs.mkdirSync(path.join(localDir, 'sub'))
    fs.writeFileSync(path.join(localDir, 'sub', 'c.txt'), 'c')
})

const baseRun = (sftpOptions: Record<string, unknown> = {}) =>
    run({
        connect: { host: 'h', port: 22, username: 'u', password: 'pw' },
        local: localDir,
        remote: REMOTE,
        audit: false,
        sftpOptions,
    })

describe('deploy（mock ssh2）', () => {
    it('全新部署：三文件全部传输，建两层目录，断开连接', async () => {
        const r = await baseRun()
        expect(r.ok).toBe(true)
        expect(r.transferred.toSorted()).toEqual(['/remote/a.txt', '/remote/b.txt', '/remote/sub/c.txt'])
        expect(r.skipped).toEqual([])
        expect(h.state.execs).toContain(`mkdir -p '/remote'`)
        expect(h.state.execs).toContain(`mkdir -p '/remote/sub'`)
        expect(h.state.ended).toBe(true)
    })

    it('override=false：已存在文件被跳过且不再 fastPut', async () => {
        h.state.existing.add('/remote/b.txt')
        const r = await baseRun()
        expect(r.skipped).toEqual(['/remote/b.txt'])
        expect(r.transferred.toSorted()).toEqual(['/remote/a.txt', '/remote/sub/c.txt'])
        expect(h.state.fastPuts).not.toContain('/remote/b.txt')
    })

    it('override=true：不做存在性检查，全部覆盖', async () => {
        h.state.existing.add('/remote/b.txt')
        const r = await baseRun({ override: true })
        expect(r.transferred).toHaveLength(3)
        expect(r.skipped).toEqual([])
        expect(h.state.execs.some((c) => c.startsWith('stat '))).toBe(false)
    })

    it('clear=true：先执行 rm -rf 清空远程目录', async () => {
        const r = await baseRun({ clear: true, override: true })
        expect(h.state.execs).toContain(`rm -rf '/remote'/*`)
        expect(r.commands).toContain(`rm -rf '/remote'/*`)
    })

    it('单文件抖动失败后重试成功', async () => {
        h.state.failRemaining.set('/remote/a.txt', 2) // 失败两次，第三次成功
        const r = await baseRun({ override: true })
        expect(r.ok).toBe(true)
        expect(r.transferred).toContain('/remote/a.txt')
        expect(h.state.fastPuts.filter((t) => t === '/remote/a.txt')).toHaveLength(3)
    })

    it('单文件永久失败：计入 failed，ok=false', async () => {
        h.state.failRemaining.set('/remote/a.txt', Infinity)
        const r = await baseRun({ override: true })
        expect(r.ok).toBe(false)
        expect(r.failed.map((f) => f.target)).toEqual(['/remote/a.txt'])
        expect(r.transferred.toSorted()).toEqual(['/remote/b.txt', '/remote/sub/c.txt'])
    })

    it('beforeRunCommand 在扫描/建目录之前执行', async () => {
        await baseRun({ override: true, beforeRunCommand: 'npm run build' })
        const firstMkdir = h.state.execs.findIndex((c) => c.startsWith('mkdir -p'))
        expect(h.state.execs[0]).toBe('npm run build')
        expect(firstMkdir).toBeGreaterThan(0)
    })

    it('实跑写入审计日志', async () => {
        const auditLog = path.join(localDir, 'audit.log')
        await run({
            connect: { host: 'srv', port: 22, username: 'deployer', password: 'pw' },
            local: localDir,
            remote: REMOTE,
            audit: true,
            auditLog,
            sftpOptions: { override: true },
        })
        const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n')
        expect(lines).toHaveLength(1)
        const rec = JSON.parse(lines[0])
        expect(rec).toMatchObject({ action: 'deploy', ok: true, host: 'srv', username: 'deployer' })
        expect(rec.detail.transferred).toBe(3)
    })
})
