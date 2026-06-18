import { describe, it, expect } from 'vitest'
import { guard, backupRemote, restoreRemote, existsRemote } from '../src/guard'
import type { ExecCapable } from '../src/guard'
import type { ExecResult } from '../src/exec'
import { RemoteCommandError } from '../src/errors'

interface StubOptions {
    /** 视为已存在的远程路径。 */
    existing?: Set<string>
    /** 命令包含其中任一子串则失败（模拟 validate/reload/apply 命令失败）。 */
    failCommands?: string[]
}

/** 构造一个记录命令的 stub 会话；`test -e` 按 existing 判定，failCommands 命中则抛错。 */
const makeSession = (opts: StubOptions = {}): ExecCapable & { calls: string[] } => {
    const calls: string[] = []
    return {
        calls,
        async exec(command: string): Promise<ExecResult> {
            calls.push(command)
            const m = command.match(/^test -e '(.*)'$/)
            if (m) {
                if (opts.existing?.has(m[1])) return { command, stdout: '', stderr: '', code: 0 }
                throw new RemoteCommandError(`非零：${command}`, { command })
            }
            if (opts.failCommands?.some((f) => command.includes(f))) {
                throw new RemoteCommandError(`命令失败：${command}`, { command })
            }
            return { command, stdout: '', stderr: '', code: 0 }
        },
    }
}

describe('existsRemote', () => {
    it('存在返回 true、不存在返回 false（不抛错）', async () => {
        const s = makeSession({ existing: new Set(['/etc/nginx.conf']) })
        expect(await existsRemote(s, '/etc/nginx.conf')).toBe(true)
        expect(await existsRemote(s, '/none')).toBe(false)
    })
})

describe('backupRemote', () => {
    it('目标存在：cp -a 到 .wink-bak.<suffix> 并返回备份路径', async () => {
        const s = makeSession({ existing: new Set(['/app']) })
        const backup = await backupRemote(s, '/app', '42')
        expect(backup).toBe('/app.wink-bak.42')
        expect(s.calls).toContain(`cp -a '/app' '/app.wink-bak.42'`)
    })

    it('目标不存在：返回 null、不执行 cp', async () => {
        const s = makeSession()
        const backup = await backupRemote(s, '/app', '42')
        expect(backup).toBeNull()
        expect(s.calls.some((c) => c.startsWith('cp -a'))).toBe(false)
    })
})

describe('restoreRemote', () => {
    it('删除目标再把备份移回（均转义）', async () => {
        const s = makeSession()
        await restoreRemote(s, '/app', '/app.wink-bak.42')
        expect(s.calls).toContain(`rm -rf '/app' && mv '/app.wink-bak.42' '/app'`)
    })
})

describe('guard', () => {
    it('应用成功且无校验：成功后清理备份，backup=null', async () => {
        const s = makeSession({ existing: new Set(['/app']) })
        let applied = false
        const r = await guard(s, { target: '/app', backupSuffix: '1', apply: async () => void (applied = true) })
        expect(applied).toBe(true)
        expect(r.ok).toBe(true)
        expect(r.rolledBack).toBe(false)
        expect(r.backup).toBeNull()
        expect(s.calls).toContain(`rm -rf '/app.wink-bak.1'`) // 成功清理备份
    })

    it('keepBackup：成功后保留备份并返回其路径', async () => {
        const s = makeSession({ existing: new Set(['/app']) })
        const r = await guard(s, { target: '/app', backupSuffix: '1', keepBackup: true, apply: async () => {} })
        expect(r.backup).toBe('/app.wink-bak.1')
        expect(s.calls.some((c) => c.startsWith('rm -rf') && c.includes('wink-bak'))).toBe(false)
    })

    it('校验失败：自动回滚到备份，ok=false、rolledBack=true', async () => {
        const s = makeSession({ existing: new Set(['/app']), failCommands: ['nginx -t'] })
        const r = await guard(s, { target: '/app', backupSuffix: '1', apply: async () => {}, validate: 'nginx -t' })
        expect(r.ok).toBe(false)
        expect(r.rolledBack).toBe(true)
        expect(r.error).toMatch(/nginx -t/)
        expect(s.calls).toContain(`rm -rf '/app' && mv '/app.wink-bak.1' '/app'`)
    })

    it('reload 失败：同样回滚', async () => {
        const s = makeSession({ existing: new Set(['/app']), failCommands: ['systemctl reload'] })
        const r = await guard(s, {
            target: '/app',
            backupSuffix: '1',
            apply: async () => {},
            reload: 'systemctl reload nginx',
        })
        expect(r.ok).toBe(false)
        expect(r.rolledBack).toBe(true)
    })

    it('apply 抛错：回滚并把错误收进 result', async () => {
        const s = makeSession({ existing: new Set(['/app']) })
        const r = await guard(s, {
            target: '/app',
            backupSuffix: '1',
            apply: async () => {
                throw new Error('write failed')
            },
        })
        expect(r.ok).toBe(false)
        expect(r.rolledBack).toBe(true)
        expect(r.error).toBe('write failed')
    })

    it('目标原先不存在：失败时无备份可回滚，rolledBack=false', async () => {
        const s = makeSession({ failCommands: ['nginx -t'] })
        const r = await guard(s, { target: '/new', backupSuffix: '1', apply: async () => {}, validate: 'nginx -t' })
        expect(r.ok).toBe(false)
        expect(r.backup).toBeNull()
        expect(r.rolledBack).toBe(false)
    })
})
