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
        /** target → 远程 stat（增量比对用）：size 与 mtime（秒）。 */
        remoteStats: new Map<string, { size: number; mtime: number }>(),
        /** sftp.stat 被探测的 target（用于断言存在性检查是否发生）。 */
        statCalls: [] as string[],
        /** 上传后对齐 mtime：记录 utimes 调用。 */
        utimes: [] as { target: string; mtime: number }[],
        /** target → 还需失败的次数（Infinity 表示永久失败）。 */
        failRemaining: new Map<string, number>(),
        /** exec 命令包含其中任一子串则以退出码 1 失败（模拟 cp/mv 失败）。 */
        failExec: [] as string[],
        /** 目录 → readdir 返回的文件名（用于备份清理）。 */
        dirEntries: {} as Record<string, string[]>,
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
                let code = m ? (h.state.existing.has(m[1]) ? 0 : 1) : 0
                if (h.state.failExec.some((sub) => command.includes(sub))) code = 1
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
                stat(target: string, done: (err: unknown, stats?: unknown) => void) {
                    h.state.statCalls.push(target)
                    const s = h.state.remoteStats.get(target)
                    if (s) done(null, s)
                    else if (h.state.existing.has(target)) done(null, { size: 0, mtime: 0 })
                    else done(new Error('no such file'))
                },
                utimes(target: string, _atime: number, mtime: number, done: (err?: unknown) => void) {
                    h.state.utimes.push({ target, mtime })
                    done()
                },
                readdir(dir: string, done: (err: unknown, list?: unknown) => void) {
                    const names = h.state.dirEntries[dir] ?? []
                    done(
                        null,
                        names.map((name) => ({
                            filename: name,
                            attrs: {
                                size: 0,
                                mtime: 0,
                                isDirectory: () => false,
                                isFile: () => true,
                                isSymbolicLink: () => false,
                            },
                        }))
                    )
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
    h.state.remoteStats = new Map()
    h.state.statCalls = []
    h.state.utimes = []
    h.state.failRemaining = new Map()
    h.state.failExec = []
    h.state.dirEntries = {}
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
        // override 时不探测远程存在性（既不走 exec stat，也不走 sftp.stat）
        expect(h.state.execs.some((c) => c.startsWith('stat '))).toBe(false)
        expect(h.state.statCalls).toEqual([])
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

    // 远程 mtime（秒）需等于本地文件 mtime 才算「未变更」（部署后由 utimes 对齐为本地 mtime）
    const localMtimeSec = (rel: string) => Math.floor(fs.statSync(path.join(localDir, rel)).mtimeMs / 1000)

    it('增量：size 相同且 mtime 与本地对齐则跳过，不再 fastPut', async () => {
        h.state.remoteStats.set('/remote/a.txt', { size: 1, mtime: localMtimeSec('a.txt') })
        h.state.remoteStats.set('/remote/b.txt', { size: 1, mtime: localMtimeSec('b.txt') })
        h.state.remoteStats.set('/remote/sub/c.txt', { size: 1, mtime: localMtimeSec('sub/c.txt') })
        const r = await baseRun({ incremental: true })
        expect(r.skipped.toSorted()).toEqual(['/remote/a.txt', '/remote/b.txt', '/remote/sub/c.txt'])
        expect(r.transferred).toEqual([])
        expect(h.state.fastPuts).toEqual([])
    })

    it('增量：size 不同或 mtime 不一致则覆盖传输，未变更项仍跳过', async () => {
        h.state.remoteStats.set('/remote/a.txt', { size: 999, mtime: localMtimeSec('a.txt') }) // size 不同 → 变更
        h.state.remoteStats.set('/remote/b.txt', { size: 1, mtime: localMtimeSec('b.txt') }) // 未变更
        // c.txt 远程不存在（stat 返回 null）→ 传输
        const r = await baseRun({ incremental: true })
        expect(r.transferred.toSorted()).toEqual(['/remote/a.txt', '/remote/sub/c.txt'])
        expect(r.skipped).toEqual(['/remote/b.txt'])
    })

    it('增量：远程 mtime 比本地新（时钟偏差）仍判为变更并重传', async () => {
        // 旧实现用 remote.mtime >= local 会误跳过；新实现要求相等，故重传
        h.state.remoteStats.set('/remote/a.txt', { size: 1, mtime: localMtimeSec('a.txt') + 3600 })
        const r = await baseRun({ incremental: true })
        expect(r.transferred).toContain('/remote/a.txt')
    })

    it('上传后对齐远程 mtime 为本地 mtime（utimes）', async () => {
        await baseRun({ override: true })
        const a = h.state.utimes.find((u) => u.target === '/remote/a.txt')
        expect(a?.mtime).toBe(localMtimeSec('a.txt'))
    })

    it('beforeRunCommand 在扫描/建目录之前执行', async () => {
        await baseRun({ override: true, beforeRunCommand: 'npm run build' })
        const firstMkdir = h.state.execs.findIndex((c) => c.startsWith('mkdir -p'))
        expect(h.state.execs[0]).toBe('npm run build')
        expect(firstMkdir).toBeGreaterThan(0)
    })

    it('backup：部署前快照远程目标，成功后保留备份路径', async () => {
        const r = await baseRun({ override: true, backup: true })
        expect(r.ok).toBe(true)
        expect(h.state.execs.some((c) => c.startsWith(`cp -a '/remote' '/remote.wink-bak.`))).toBe(true)
        expect(r.backup).toMatch(/^\/remote\.wink-bak\./)
        expect(r.rolledBack).toBe(false)
    })

    it('backup：传输失败自动回滚到快照，afterRunCommand 不执行', async () => {
        h.state.failRemaining.set('/remote/a.txt', Infinity)
        const r = await baseRun({ override: true, backup: true, afterRunCommand: 'systemctl restart app' })
        expect(r.ok).toBe(false)
        expect(r.rolledBack).toBe(true)
        expect(r.backup).toBeNull()
        expect(h.state.execs.some((c) => /^rm -rf '\/remote' && mv '\/remote\.wink-bak\..*' '\/remote'$/.test(c))).toBe(
            true
        )
        expect(h.state.execs).not.toContain('systemctl restart app')
    })

    it('backup：回滚自身失败时计入 warnings、不外抛、保留传输失败结果', async () => {
        h.state.failRemaining.set('/remote/a.txt', Infinity)
        h.state.failExec = ['mv '] // 让 restoreRemote 的 mv 失败
        const r = await baseRun({ override: true, backup: true })
        expect(r.ok).toBe(false) // 仍是传输失败的结果，未被回滚错误掩盖
        expect(r.rolledBack).toBe(false) // 回滚没成功
        expect(r.failed.map((f) => f.target)).toEqual(['/remote/a.txt'])
        expect(r.warnings.some((w) => w.includes('回滚失败'))).toBe(true)
    })

    it('backup：备份 cp 失败则清晰中止（TransferError），不触碰远程', async () => {
        h.state.failExec = ['cp -a']
        await expect(baseRun({ override: true, backup: true })).rejects.toThrow(/部署前备份失败/)
        expect(h.state.fastPuts).toEqual([]) // 未传输任何文件
    })

    it('backup：成功后仅保留最新快照，清理更旧的快照', async () => {
        h.state.dirEntries = { '/': ['remote', 'remote.wink-bak.100', 'remote.wink-bak.200', 'keep-me'] }
        const r = await baseRun({ override: true, backup: true })
        expect(r.ok).toBe(true)
        expect(h.state.execs).toContain(`rm -rf '/remote.wink-bak.100'`)
        expect(h.state.execs).toContain(`rm -rf '/remote.wink-bak.200'`)
        expect(h.state.execs.some((c) => c.includes('keep-me'))).toBe(false) // 非快照不动
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

    // 回归：CLI --no-audit（options.audit === false）必须覆盖配置文件 audit:true
    it('CLI --no-audit 覆盖配置文件 audit:true', async () => {
        const auditLog = path.join(localDir, 'audit.log')
        const cfgPath = path.join(localDir, 'wink.json')
        fs.writeFileSync(
            cfgPath,
            JSON.stringify({
                connect: { host: 'h', port: 22, username: 'u', password: 'pw' },
                local: localDir,
                remote: REMOTE,
                audit: true,
                auditLog,
                sftpOptions: { override: true },
            })
        )
        await run({ config: cfgPath, audit: false })
        expect(fs.existsSync(auditLog)).toBe(false)
    })

    it('配置文件 audit:true 且未传 --no-audit 时照常写审计（对照）', async () => {
        const auditLog = path.join(localDir, 'audit.log')
        const cfgPath = path.join(localDir, 'wink.json')
        fs.writeFileSync(
            cfgPath,
            JSON.stringify({
                connect: { host: 'h', port: 22, username: 'u', password: 'pw' },
                local: localDir,
                remote: REMOTE,
                audit: true,
                auditLog,
                sftpOptions: { override: true },
            })
        )
        await run({ config: cfgPath })
        expect(fs.existsSync(auditLog)).toBe(true)
    })
})
