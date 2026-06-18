import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { provision } from '../src/provision'

// 受控的 exec：按命令子串返回 stdout/退出码（与 ops.mock.test 同一桩）
const h = vi.hoisted(() => ({
    state: {
        execs: [] as string[],
        responses: [] as { match: string; stdout: string; code?: number }[],
        puts: [] as { local: string; remote: string }[],
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
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            cb(null, {
                fastPut(local: string, remote: string, done: (err?: unknown) => void) {
                    h.state.puts.push({ local, remote })
                    done()
                },
            })
        }
    }
    return { Client: FakeClient }
})

beforeEach(() => {
    h.state.execs = []
    h.state.responses = []
    h.state.puts = []
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

describe('provision 守护式写配置（configure）', () => {
    let confFile = ''
    beforeEach(() => {
        confFile = path.join(os.tmpdir(), `wink-provision-${process.pid}-${h.state.execs.length}.conf`)
        fs.writeFileSync(confFile, 'server { listen 80; }\n')
    })
    afterEach(() => {
        try {
            fs.unlinkSync(confFile)
        } catch {
            /* 已删则忽略 */
        }
    })

    it('已满足组件仍推配置：跳过安装、经 guard 写入（备份/写/校验/reload），fastPut 被调用', async () => {
        h.state.responses = [{ match: 'nginx -v', stdout: 'nginx version: nginx/1.24.0' }] // 已装 → satisfied
        const r = await provision(
            base({
                nginx: {
                    version: 'latest',
                    configure: [
                        {
                            file: confFile,
                            remote: '/etc/nginx/nginx.conf',
                            validate: 'nginx -t',
                            reload: 'systemctl reload nginx',
                        },
                    ],
                },
            }),
            { yes: true }
        )
        expect(r.ok).toBe(true)
        expect(r.components[0].satisfied).toBe(true)
        expect(r.components[0].executed).toEqual([]) // 已满足，不跑安装步骤
        expect(r.components[0].configured).toHaveLength(1)
        expect(r.components[0].configured[0].ok).toBe(true)
        expect(r.components[0].configured[0].remote).toBe('/etc/nginx/nginx.conf')
        // fastPut 真正写过；guard 跑过校验/reload
        expect(h.state.puts).toEqual([{ local: confFile, remote: '/etc/nginx/nginx.conf' }])
        expect(h.state.execs.some((c) => c.includes('nginx -t'))).toBe(true)
        expect(h.state.execs.some((c) => c.includes('systemctl reload nginx'))).toBe(true)
    })

    it('dry-run：plannedConfigs 出计划、不写、不要求本地文件存在', async () => {
        h.state.responses = [{ match: 'nginx -v', stdout: 'nginx version: nginx/1.24.0' }]
        const r = await provision(
            base(
                {
                    nginx: {
                        version: 'latest',
                        configure: [{ file: './does-not-exist.conf', remote: '/etc/nginx/nginx.conf' }],
                    },
                },
                { dryRun: true }
            )
        )
        expect(r.dryRun).toBe(true)
        expect(r.components[0].plannedConfigs).toHaveLength(1)
        expect(r.components[0].configured).toEqual([])
        expect(h.state.puts).toEqual([]) // 预演不写
    })

    it('configure 校验失败 → guard 回滚、configured.ok=false、组件 ok=false', async () => {
        h.state.responses = [
            { match: 'nginx -v', stdout: 'nginx version: nginx/1.24.0' },
            { match: 'nginx -t', stdout: '', code: 1 }, // 校验失败 → guard 回滚
        ]
        const r = await provision(
            base({
                nginx: {
                    version: 'latest',
                    configure: [{ file: confFile, remote: '/etc/nginx/nginx.conf', validate: 'nginx -t' }],
                },
            }),
            { yes: true }
        )
        expect(r.ok).toBe(false)
        expect(r.components[0].configured[0].ok).toBe(false)
        expect(r.components[0].configured[0].rolledBack).toBe(true)
    })

    it('实跑缺本地源文件 → pre-flight 抛 ConfigError，不建立连接', async () => {
        await expect(
            provision(
                base({
                    nginx: { version: 'latest', configure: [{ file: './nope.conf', remote: '/etc/nginx/nginx.conf' }] },
                }),
                { yes: true }
            )
        ).rejects.toThrow(/本地源文件不存在/)
        expect(h.state.execs).toHaveLength(0)
    })

    it('configure 形态非法 → 连接前就报错（预演也校验，不建立连接）', async () => {
        await expect(
            provision(base({ nginx: { version: 'latest', configure: 'not-an-array' } }, { dryRun: true }))
        ).rejects.toThrow(/数组/)
        expect(h.state.execs).toHaveLength(0)
    })
})
