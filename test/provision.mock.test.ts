import { describe, it, expect, beforeEach, vi } from 'vitest'
import { provision } from '../src/provision'

// 受控的 exec：按命令子串返回 stdout/退出码（与 ops.mock.test 同一桩）
const h = vi.hoisted(() => ({
    state: {
        execs: [] as string[],
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
const base = (stack: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    connect: conn,
    stack,
    audit: false,
    ...extra,
})

describe('provision 安全护栏', () => {
    it('既无 --dry-run 也无 --yes → 抛错且不建立连接', async () => {
        await expect(provision(base({ docker: true }))).rejects.toThrow(/--dry-run|--yes/)
        expect(h.state.execs).toHaveLength(0)
    })

    it('缺 stack → 抛错且不建立连接', async () => {
        await expect(provision({ connect: conn, audit: false, dryRun: true })).rejects.toThrow(/stack/)
        expect(h.state.execs).toHaveLength(0)
    })

    it('不支持的组件 → 抛错且不建立连接（护栏进 core）', async () => {
        await expect(provision(base({ postgres: 14 }, { dryRun: true }))).rejects.toThrow(/不支持的组件/)
        expect(h.state.execs).toHaveLength(0)
    })

    it('组件被 false 关闭后无可处理项 → 抛错', async () => {
        await expect(provision(base({ docker: false }, { dryRun: true }))).rejects.toThrow(/没有可处理的组件/)
    })
})

describe('provision 预演（dry-run）', () => {
    it('已满足的组件 satisfied=true、不执行步骤', async () => {
        h.state.responses = [{ match: 'node --version', stdout: 'v20.11.0\n' }]
        const r = await provision(base({ nodejs: '20' }, { dryRun: true }))
        expect(r.dryRun).toBe(true)
        expect(r.ok).toBe(true)
        expect(r.components[0].satisfied).toBe(true)
        expect(r.components[0].planned).toEqual([])
        expect(r.components[0].executed).toEqual([])
        // 仅执行了一次检测，未执行任何安装步骤
        expect(h.state.execs).toHaveLength(1)
    })

    it('未满足：给出 planned 步骤但不执行（executed 为空）', async () => {
        h.state.responses = [{ match: 'node --version', stdout: '' }]
        const r = await provision(base({ nodejs: '20' }, { dryRun: true }))
        expect(r.components[0].satisfied).toBe(false)
        expect(r.components[0].planned).toHaveLength(2)
        expect(r.components[0].executed).toEqual([])
        // 只检测、不执行步骤
        expect(h.state.execs).toHaveLength(1)
    })
})

describe('provision 执行（--yes）', () => {
    it('未安装 → 执行步骤，全 0 退出则 ok', async () => {
        h.state.responses = [{ match: 'node --version', stdout: '' }]
        const r = await provision(base({ nodejs: '20' }), { yes: true })
        expect(r.ok).toBe(true)
        expect(r.components[0].executed).toHaveLength(2)
        expect(r.components[0].executed.every((s) => s.ok)).toBe(true)
        // 检测 + 两步
        expect(h.state.execs).toHaveLength(3)
    })

    it('幂等：检测已满足则即便 --yes 也不执行步骤', async () => {
        h.state.responses = [{ match: 'docker --version', stdout: 'Docker version 24.0.7, build x' }]
        const r = await provision(base({ docker: true }), { yes: true })
        expect(r.components[0].satisfied).toBe(true)
        expect(r.components[0].executed).toEqual([])
        expect(h.state.execs).toHaveLength(1)
    })

    it('步骤失败 → ok=false 且停在首个失败步骤', async () => {
        h.state.responses = [
            { match: 'node --version', stdout: '' },
            { match: 'nvm install', stdout: '', code: 1 },
        ]
        const r = await provision(base({ nodejs: '20' }), { yes: true })
        expect(r.ok).toBe(false)
        expect(r.components[0].executed).toHaveLength(2) // 装 nvm（成功）+ 装 node（失败后停）
        expect(r.components[0].executed[1].ok).toBe(false)
    })

    it('only 限定只处理指定组件', async () => {
        h.state.responses = [
            { match: 'docker --version', stdout: 'Docker version 24.0.7, build x' },
            { match: 'node --version', stdout: 'v20.11.0' },
        ]
        const r = await provision(base({ nodejs: '20', docker: true }), { yes: true, only: ['docker'] })
        expect(r.components).toHaveLength(1)
        expect(r.components[0].component).toBe('docker')
    })

    it('only 指定 stack 未声明的组件 → 抛错', async () => {
        await expect(provision(base({ docker: true }), { yes: true, only: ['nodejs'] })).rejects.toThrow(/未声明/)
    })

    it('mysql docker：结果只暴露脱敏命令，root 密码不泄漏到 executed/--json', async () => {
        h.state.responses = [{ match: 'mysqld --version', stdout: '' }] // 容器内检测：未安装
        const r = await provision(base({ mysql: { version: 8, mode: 'docker', rootPassword: 's3cret-pw' } }), {
            yes: true,
        })
        const cmds = r.components[0].executed.map((s) => s.command).join('\n')
        expect(cmds).toContain("MYSQL_ROOT_PASSWORD='***'")
        expect(cmds).not.toContain('s3cret-pw') // 明文密码绝不出现在结构化结果里
    })

    it('mysql docker dry-run：planned 也用脱敏命令', async () => {
        h.state.responses = [{ match: 'mysqld --version', stdout: '' }]
        const r = await provision(
            base({ mysql: { version: 8, mode: 'docker', rootPassword: 's3cret-pw' } }, { dryRun: true })
        )
        const planned = r.components[0].planned.map((s) => s.command).join('\n')
        expect(planned).not.toContain('s3cret-pw')
        expect(planned).toContain("MYSQL_ROOT_PASSWORD='***'")
    })

    it('mysql docker 步骤失败：失败路径的 command 与回显 stderr 仍脱敏（不泄漏明文）', async () => {
        h.state.responses = [
            { match: 'mysqld --version', stdout: '' }, // 检测：未安装
            { match: 'docker run', stdout: '', stderr: "boom echoing 's3cret-pw'\n", code: 1 }, // 安装失败且回显密码
        ]
        const r = await provision(base({ mysql: { version: 8, mode: 'docker', rootPassword: 's3cret-pw' } }), {
            yes: true,
        })
        expect(r.ok).toBe(false)
        const blob = JSON.stringify(r.components[0].executed)
        expect(blob).not.toContain('s3cret-pw') // command 与 stderr 都脱敏
        expect(blob).toContain('***')
    })
})
