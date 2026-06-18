import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runExec, status, tailLogs, ps, service } from '../src/ops'

// 受控的 exec：按命令返回 stdout/退出码
const h = vi.hoisted(() => ({
    state: {
        execs: [] as string[],
        // 命令子串 → { stdout, code }
        responses: [] as { match: string; stdout: string; code?: number }[],
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
            const resp = h.state.responses.find((r) => command.includes(r.match))
            setTimeout(() => {
                if (resp?.stdout) stream.emit('data', Buffer.from(resp.stdout))
                stream.emit('exit', resp?.code ?? 0)
            }, 0)
        }
    }
    return { Client: FakeClient }
})

beforeEach(() => {
    h.state.execs = []
    h.state.responses = []
})

const conn = { host: 'h', port: 22, username: 'u', password: 'pw' }

describe('runExec', () => {
    it('退出码 0：ok=true，带回 stdout', async () => {
        h.state.responses = [{ match: 'whoami', stdout: 'root\n' }]
        const r = await runExec('whoami', { connect: conn })
        expect(r).toMatchObject({ ok: true, code: 0, command: 'whoami' })
        expect(r.stdout).toBe('root\n')
    })

    it('退出码非零：ok=false 但不抛（诊断原语返回结构化结果）', async () => {
        h.state.responses = [{ match: 'test -f', stdout: '', code: 1 }]
        const r = await runExec('test -f /nope', { connect: conn })
        expect(r.ok).toBe(false)
        expect(r.code).toBe(1)
    })
})

describe('status', () => {
    it('解析采集到的各段；best-effort 整体 ok=true', async () => {
        const SEP = '@@wink@@'
        const stdout = [
            'web-01',
            '0.10 0.20 0.30 1/100 1',
            '4',
            'MemTotal:       8000000 kB\nMemAvailable:    5000000 kB',
            'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /',
        ].join(`\n${SEP}\n`)
        h.state.responses = [{ match: 'hostname', stdout }]
        const r = await status({ connect: conn })
        expect(r.ok).toBe(true)
        expect(r.host).toBe('web-01')
        expect(r.load).toEqual([0.1, 0.2, 0.3])
        expect(r.cpuCores).toBe(4)
        expect(r.memory).toEqual({ totalKb: 8000000, usedKb: 3000000, availableKb: 5000000 })
        expect(r.disks[0].mountedOn).toBe('/')
    })

    it('采集为空时各字段为 null/空，仍 ok=true', async () => {
        h.state.responses = [{ match: 'hostname', stdout: '' }]
        const r = await status({ connect: conn })
        expect(r.ok).toBe(true)
        expect(r.host).toBeNull()
        expect(r.load).toBeNull()
        expect(r.memory).toBeNull()
        expect(r.disks).toEqual([])
    })
})

describe('tailLogs', () => {
    it('无 grep：test -f 守门 + tail -n，路径转义', async () => {
        h.state.responses = [{ match: 'tail -n 50', stdout: 'line1\nline2\n' }]
        const r = await tailLogs('/var/log/app.log', { connect: conn }, { lines: 50 })
        expect(r.lines).toEqual(['line1', 'line2'])
        expect(h.state.execs[0]).toBe(`test -f '/var/log/app.log' && tail -n 50 '/var/log/app.log'`)
    })

    it('带 grep：test -f 守门 + 先过滤再 tail，模式与路径均转义', async () => {
        h.state.responses = [{ match: 'grep', stdout: 'ERROR x\n' }]
        const r = await tailLogs('/var/log/app.log', { connect: conn }, { grep: 'ERROR', lines: 100 })
        expect(r.lines).toEqual(['ERROR x'])
        expect(h.state.execs[0]).toBe(`test -f '/var/log/app.log' && grep -- 'ERROR' '/var/log/app.log' | tail -n 100`)
    })

    it('空输出返回空行数组', async () => {
        h.state.responses = [{ match: 'tail', stdout: '' }]
        const r = await tailLogs('/var/log/app.log', { connect: conn })
        expect(r.lines).toEqual([])
    })

    it('CRLF + 末尾换行：按 \\r?\\n 切分且不留尾部空行', async () => {
        h.state.responses = [{ match: 'tail', stdout: 'a\r\nb\r\n' }]
        const r = await tailLogs('/var/log/app.log', { connect: conn })
        expect(r.lines).toEqual(['a', 'b'])
    })

    it('非数字 -n 回退默认 200（而非静默变 1）', async () => {
        h.state.responses = [{ match: 'tail -n 200', stdout: 'x\n' }]
        const r = await tailLogs('/var/log/app.log', { connect: conn }, { lines: Number('abc') })
        expect(r.lines).toEqual(['x'])
        expect(h.state.execs[0]).toContain('tail -n 200')
    })
})

describe('ps', () => {
    const PS_OUT = [
        '  PID  PPID USER %CPU %MEM   RSS COMMAND',
        '    1     0 root  0.0  0.1  1024 /sbin/init',
        '  900     1 node 12.0  5.0 88000 node /app/server.js',
    ].join('\n')

    it('采集 ps -A 并结构化（命令固定 LC_ALL=C 防区域小数）', async () => {
        h.state.responses = [{ match: 'ps -A', stdout: PS_OUT }]
        const r = await ps({ connect: conn })
        expect(r.ok).toBe(true)
        expect(r.processes).toHaveLength(2)
        expect(r.processes[1]).toMatchObject({ pid: 900, user: 'node', command: 'node /app/server.js' })
        expect(h.state.execs[0]).toBe('LC_ALL=C ps -A -o pid,ppid,user,pcpu,pmem,rss,args')
    })

    it('grep 在客户端按命令行子串过滤', async () => {
        h.state.responses = [{ match: 'ps -A', stdout: PS_OUT }]
        const r = await ps({ connect: conn }, { grep: 'server.js' })
        expect(r.processes).toHaveLength(1)
        expect(r.processes[0].pid).toBe(900)
    })

    it('ps 退出码非零：ok=false 但不抛（结构化结果，与 runExec 一致）', async () => {
        h.state.responses = [{ match: 'ps -A', stdout: '', code: 1 }]
        const r = await ps({ connect: conn })
        expect(r.ok).toBe(false)
        expect(r.processes).toEqual([])
    })
})

describe('service', () => {
    it('status 只读：无需 --yes，构造 systemctl status 命令', async () => {
        h.state.responses = [{ match: 'systemctl status', stdout: 'active\n' }]
        const r = await service('nginx', 'status', { connect: conn, audit: false })
        expect(r.ok).toBe(true)
        expect(r.command).toBe("systemctl status --no-pager 'nginx'")
        expect(h.state.execs[0]).toBe("systemctl status --no-pager 'nginx'")
    })

    it('写动作缺 --yes：抛错且不建立连接', async () => {
        await expect(service('nginx', 'restart', { connect: conn, audit: false })).rejects.toThrow(/--yes/)
        expect(h.state.execs).toHaveLength(0)
    })

    it('写动作带 yes：执行并按退出码定 ok', async () => {
        h.state.responses = [{ match: 'systemctl restart', stdout: '', code: 0 }]
        const r = await service('nginx', 'restart', { connect: conn, audit: false }, { yes: true })
        expect(r.ok).toBe(true)
        expect(h.state.execs[0]).toBe("systemctl restart 'nginx'")
    })

    it('命令退出码非零：ok=false 但不抛（诊断原语返回结构化结果）', async () => {
        h.state.responses = [{ match: 'systemctl status', stdout: '', code: 4 }]
        const r = await service('nope', 'status', { connect: conn, audit: false })
        expect(r.ok).toBe(false)
        expect(r.code).toBe(4)
    })

    it('docker reload 不支持：抛错且不建立连接', async () => {
        await expect(
            service('redis', 'reload', { connect: conn, audit: false }, { manager: 'docker', yes: true })
        ).rejects.toThrow()
        expect(h.state.execs).toHaveLength(0)
    })

    it('非法动作 / 管理器：核心层校验抛错且不建立连接（护栏进 core）', async () => {
        // 模拟 lib 调用方强转非法字符串
        await expect(
            service('nginx', 'frobnicate' as never, { connect: conn, audit: false }, { yes: true })
        ).rejects.toThrow(/未知服务动作/)
        await expect(
            service('nginx', 'status', { connect: conn, audit: false }, { manager: 'k8s' as never })
        ).rejects.toThrow(/未知服务管理器/)
        expect(h.state.execs).toHaveLength(0)
    })
})
