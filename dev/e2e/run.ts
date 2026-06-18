// e2e：进程内起 SSH/SFTP 测试服务端，spawn 真实 CLI（src/index.ts）跑各场景并断言。
// 不依赖 Docker / 系统 sshd / 任何账号，CI 可用。运行：pnpm run e2e
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startTestServer, generateTestKey } from './server'

const repoRoot = process.cwd()
const tsxBin = path.resolve(repoRoot, 'node_modules/.bin/tsx')

interface CliResult {
    code: number
    json: Record<string, unknown>
    raw: string
}

const runCli = (args: string[]): Promise<CliResult> =>
    new Promise((resolve) => {
        const cp = spawn(tsxBin, ['src/index.ts', ...args], { cwd: repoRoot })
        let out = ''
        let err = ''
        cp.stdout.on('data', (d) => (out += d))
        cp.stderr.on('data', (d) => (err += d))
        cp.on('close', (code) => {
            let json: Record<string, unknown> = {}
            try {
                json = JSON.parse(out.trim())
            } catch {
                json = { _parseError: true, _stdout: out, _stderr: err }
            }
            resolve({ code: code ?? -1, json, raw: out })
        })
    })

let passed = 0
let failed = 0
const check = (name: string, cond: boolean, detail?: unknown): void => {
    if (cond) {
        passed++
        console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    } else {
        failed++
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`)
        if (detail !== undefined) console.log('    ', JSON.stringify(detail))
    }
}

const main = async (): Promise<void> => {
    const server = await startTestServer()
    const port = String(server.port)

    // 临时夹具：本地源 + 远程目标（「远程」即本机临时目录）+ 客户端私钥
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-e2e-'))
    const dist = path.join(tmp, 'dist')
    const remote = path.join(tmp, 'remote')
    const back = path.join(tmp, 'back')
    fs.mkdirSync(path.join(dist, 'secret'), { recursive: true })
    fs.mkdirSync(remote, { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), 'hi')
    fs.writeFileSync(path.join(dist, 'app.log'), 'log')
    fs.writeFileSync(path.join(dist, 'secret', 'k'), 'sec')
    fs.writeFileSync(path.join(dist, '.winksftpignore'), '*.log\nsecret/\n')

    const keyPath = path.join(tmp, 'id_e2e')
    fs.writeFileSync(keyPath, generateTestKey(), { mode: 0o600 })

    const conn = (auth: string[]) => ['-h', '127.0.0.1', '-p', port, '-u', 'tester', ...auth]
    const pw = ['--connect-password', 'pw']
    const key = ['--connect-private-key', keyPath]

    try {
        console.log('1) deploy --dry-run + .winksftpignore（密码登录）')
        let r = await runCli(['-l', dist, '-r', remote, '--dry-run', '--json', ...conn(pw)])
        check('ok && dryRun', r.json.ok === true && r.json.dryRun === true, r.json)
        check(
            'transferred 只含 index.html（排除 *.log / secret/ / 忽略文件）',
            Array.isArray(r.json.transferred) &&
                (r.json.transferred as string[]).length === 1 &&
                (r.json.transferred as string[])[0].endsWith('/index.html'),
            r.json.transferred
        )

        console.log('2) deploy 真跑（密码登录）→ 落地校验')
        r = await runCli(['-l', dist, '-r', remote, '--json', ...conn(pw)])
        check('ok', r.json.ok === true, r.json)
        check('index.html 已落地', fs.existsSync(path.join(remote, 'index.html')))
        check('app.log 未传（*.log 忽略）', !fs.existsSync(path.join(remote, 'app.log')))
        check('secret/ 空目录未建（dir 规则整目录剪枝）', !fs.existsSync(path.join(remote, 'secret')))

        console.log('3) 增量重跑 → 全部跳过')
        r = await runCli(['-l', dist, '-r', remote, '--sftp-incremental', '--json', ...conn(pw)])
        check(
            'transferred 0 / skipped 1',
            (r.json.transferred as string[]).length === 0 && (r.json.skipped as string[]).length === 1,
            { t: r.json.transferred, s: r.json.skipped }
        )

        console.log('4) 改动后增量 → 重传')
        fs.writeFileSync(path.join(dist, 'index.html'), 'changed-content')
        r = await runCli(['-l', dist, '-r', remote, '--sftp-incremental', '--json', ...conn(pw)])
        check('transferred 1', (r.json.transferred as string[]).length === 1, r.json.transferred)

        console.log('5) ls 子命令（密钥登录）— 回归：子命令须能拿到连接参数')
        r = await runCli(['ls', remote, '--json', ...conn(key)])
        check('ok', r.json.ok === true, r.json)
        check(
            'entries 含 index.html',
            Array.isArray(r.json.entries) &&
                (r.json.entries as { name: string }[]).some((e) => e.name === 'index.html'),
            r.json.entries
        )

        console.log('6) pull 子命令（密码登录）')
        r = await runCli(['pull', '-r', remote, '-l', back, '--json', ...conn(pw)])
        check('ok && downloaded>=1', r.json.ok === true && (r.json.downloaded as string[]).length >= 1, r.json)
        check('本地落地 index.html', fs.existsSync(path.join(back, 'index.html')))

        console.log('7) 失败路径：ls 不存在目录 → 退出码 5 / kind=transfer')
        r = await runCli(['ls', path.join(tmp, 'no-such-dir'), '--json', ...conn(pw)])
        check('exit=5 && ok=false', r.code === 5 && r.json.ok === false, { code: r.code, json: r.json })

        console.log('8) 多环境 + ${ENV_VAR} secrets（YAML 配置）')
        const prodRemote = path.join(tmp, 'remote-prod')
        fs.mkdirSync(prodRemote, { recursive: true })
        const cfg = path.join(tmp, 'sftp.yaml')
        fs.writeFileSync(
            cfg,
            [
                'connect:',
                '  host: 127.0.0.1',
                `  port: ${port}`,
                '  username: tester',
                '  password: ${WINK_E2E_PW}',
                `local: ${dist}`,
                `remote: ${remote}`,
                'environments:',
                `  prod: { remote: ${prodRemote} }`,
            ].join('\n')
        )
        r = await runCliEnv(['-c', cfg, '--env', 'prod', '--dry-run', '--json'], { WINK_E2E_PW: 'pw' })
        check('注入 secret + 选中 prod 环境', r.json.ok === true && r.json.remote === prodRemote, r.json)
        r = await runCliEnv(['-c', cfg, '--env', 'prod', '--dry-run', '--json'], {})
        check('缺 ${WINK_E2E_PW} → 退出码 2', r.code === 2 && r.json.kind === 'config', { code: r.code, json: r.json })

        console.log('9) 文件级备份：部署前快照已存在的远程目标')
        // remote 已含 index.html（用例 2 落地），开启 --sftp-backup 再部署一次 → 生成快照
        r = await runCli(['-l', dist, '-r', remote, '--sftp-backup', '-o', '--json', ...conn(pw)])
        const backupPath = r.json.backup as string | null
        check(
            'backup 路径返回且快照目录已生成',
            r.json.ok === true &&
                typeof backupPath === 'string' &&
                backupPath.includes('.wink-bak.') &&
                fs.existsSync(backupPath),
            r.json
        )

        console.log('10) 多机部署：一台正常 + 一台连接失败（continue 汇总）')
        const cfgMulti = path.join(tmp, 'multi.json')
        fs.writeFileSync(
            cfgMulti,
            JSON.stringify({
                connect: { username: 'tester', password: 'pw' },
                local: dist,
                remote,
                sftpOptions: { override: true },
                // 第一台用真实测试端口；第二台指向已关闭端口 1 → 连接失败
                hosts: [
                    { host: '127.0.0.1', port: Number(port) },
                    { host: '127.0.0.1', port: 1 },
                ],
            })
        )
        r = await runCli(['-c', cfgMulti, '--json'])
        const hosts = r.json.hosts as { ok: boolean; error?: { kind: string } }[] | undefined
        check(
            'ok=false、两台聚合、首台成功次台连接失败',
            r.json.ok === false &&
                Array.isArray(hosts) &&
                hosts.length === 2 &&
                hosts[0].ok === true &&
                hosts[1].ok === false &&
                hosts[1].error?.kind === 'connection',
            r.json
        )

        console.log('11) 手动回滚：恢复到用例 9 生成的快照')
        // 往 remote 写一个干扰文件，回滚后应被快照覆盖（快照里没有它）
        fs.writeFileSync(path.join(remote, 'stray.txt'), 'stray')
        r = await runCli(['-r', remote, '--rollback', '--json', ...conn(pw)])
        check(
            'ok && 选中 wink-bak 快照 && 回滚后 index.html 在、干扰文件已被覆盖消失',
            r.json.ok === true &&
                typeof r.json.backup === 'string' &&
                (r.json.backup as string).includes('.wink-bak.') &&
                fs.existsSync(path.join(remote, 'index.html')) &&
                !fs.existsSync(path.join(remote, 'stray.txt')),
            r.json
        )

        console.log('12) 畸形 --hosts（解析不出主机）→ 退出码 2 / kind=config')
        r = await runCli(['-l', dist, '-r', remote, '--hosts', ',,', '--json', ...conn(pw)])
        check('exit=2 && kind=config', r.code === 2 && r.json.kind === 'config', { code: r.code, json: r.json })
    } finally {
        await server.close()
        fs.rmSync(tmp, { recursive: true, force: true })
    }

    console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}e2e: ${passed} passed, ${failed} failed\x1b[0m`)
    process.exit(failed === 0 ? 0 : 1)
}

// 带额外环境变量跑 CLI（用于 secrets 注入用例）
const runCliEnv = (args: string[], extraEnv: Record<string, string>): Promise<CliResult> =>
    new Promise((resolve) => {
        const cp = spawn(tsxBin, ['src/index.ts', ...args], { cwd: repoRoot, env: { ...process.env, ...extraEnv } })
        let out = ''
        let err = ''
        cp.stdout.on('data', (d) => (out += d))
        cp.stderr.on('data', (d) => (err += d))
        cp.on('close', (code) => {
            let json: Record<string, unknown> = {}
            try {
                json = JSON.parse(out.trim())
            } catch {
                json = { _parseError: true, _stdout: out, _stderr: err }
            }
            resolve({ code: code ?? -1, json, raw: out })
        })
    })

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
