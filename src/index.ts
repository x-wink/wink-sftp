#! /usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { name, version, description } from '../package.json'
import type {
    RunOption,
    SftpOption,
    DeployResult,
    MultiDeployResult,
    PullResult,
    LsResult,
    RollbackResult,
} from './core'
import { runAuto, pull, ls, rollback } from './core'
import { runExec, status, tailLogs, ps, service, SERVICE_ACTIONS, SERVICE_MANAGERS } from './ops'
import type {
    ExecRunResult,
    StatusResult,
    LogsResult,
    PsResult,
    ServiceResult,
    ServiceAction,
    ServiceManager,
} from './ops'
import { edit } from './edit'
import type { EditResult } from './edit'
import { ConfigError, exitCodeOf, WinkSftpError } from './errors'

const program = new Command()
program.name(name).version(version).description(description)
// 释放 -h 给 connect-host（沿用本工具历史用法），help 仅保留 --help
program.helpOption('--help', '显示帮助信息')

/** 给命令挂上连接与调用级公共选项（部署 / 下载 / 浏览共用）。 */
const addConnectionOptions = (cmd: Command): Command =>
    cmd
        .helpOption('--help', '显示帮助信息')
        .option(
            '-c --config <path>',
            '指定配置文件路径（相对启动目录，支持 .json/.yaml/.yml），作为基底，显式命令行参数深合并覆盖其上'
        )
        .option('-h --connect-host <host>', '远程服务器地址')
        .option('-p --connect-port <port>', '远程服务器端口')
        .option('-u --connect-username <user>', '远程服务器用户名')
        .option('--connect-password <pwd>', '远程服务器密码（与私钥二选一）')
        .option('--connect-private-key <path>', '私钥文件路径（相对启动目录），用于密钥登录')
        .option('--connect-passphrase <pass>', '私钥口令（加密私钥时需要）')
        .option('--env <name>', '选择多环境配置中的某个环境（对应配置文件 environments 下的键）')
        .option('--debug', '输出调试日志，默认false')
        .option('--json', '以 JSON 结构化结果输出到 stdout（人类日志走 stderr），便于脚本/agent 解析')

/** 私钥以文件路径传入（相对启动目录），读为内容交给 ssh2；读失败抛 ConfigError。 */
const readPrivateKey = (p: unknown): string | undefined => {
    if (p === undefined) return undefined
    const keyPath = path.resolve(process.cwd(), String(p))
    try {
        return String(fs.readFileSync(keyPath))
    } catch (e) {
        throw new ConfigError(`读取私钥文件失败：${keyPath}`, { cause: e })
    }
}

/** 从扁平 CLI 选项构造连接配置与公共调用级开关。 */
const buildBase = (o: Record<string, unknown>): RunOption => ({
    config: o.config as string | undefined,
    debug: o.debug as boolean | undefined,
    json: Boolean(o.json),
    env: o.env as string | undefined,
    connect: {
        host: o.connectHost as string | undefined,
        port: o.connectPort !== undefined ? Number(o.connectPort) : undefined,
        username: o.connectUsername as string | undefined,
        password: o.connectPassword as string | undefined,
        privateKey: readPrivateKey(o.connectPrivateKey),
        passphrase: o.connectPassphrase as string | undefined,
    },
})

/** 统一执行：渲染结果（人类或 --json）并据 `ok` 设置退出码；异常走 {@link handleError}。 */
const execute = async <T extends { ok: boolean }>(
    json: boolean,
    fn: () => Promise<T>,
    render: (r: T) => void,
    failExit = 5
): Promise<void> => {
    try {
        const result = await fn()
        if (json) process.stdout.write(JSON.stringify(result) + '\n')
        else render(result)
        if (!result.ok) process.exitCode = failExit
    } catch (e) {
        handleError(e, json)
    }
}

/** 统一错误出口：--json 输出 `{ok:false,kind,error}`，否则人类信息；按错误类型定退出码。 */
const handleError = (e: unknown, json: boolean): void => {
    const kind = e instanceof WinkSftpError ? e.kind : 'error'
    const message = e instanceof Error ? e.message : String(e)
    if (json) {
        process.stdout.write(JSON.stringify({ ok: false, kind, error: message }) + '\n')
    } else {
        console.error('执行失败：', message)
    }
    process.exitCode = exitCodeOf(e)
}

/** 把结构化部署结果渲染为人类可读摘要（走 stderr）。 */
const renderDeploy = (r: DeployResult): void => {
    console.error(r.dryRun ? '【预演】以下动作将执行但不会落地：' : '部署完成：')
    if (r.commands.length) {
        console.error(`  远程命令（${r.commands.length}）：`)
        r.commands.forEach((c) => console.error('    $ ' + c))
    }
    if (r.dirs.length) console.error(`  远程目录（${r.dirs.length}）`)
    r.warnings.forEach((w) => console.error('  ⚠ ' + w))
    console.error(`  传输 ${r.transferred.length} / 跳过 ${r.skipped.length} / 失败 ${r.failed.length}`)
    r.failed.forEach((f) => console.error(`    ✗ ${f.target}：${f.error}`))
    if (r.rolledBack) console.error(`  ↩ 已回滚到备份：${r.remote}`)
    else if (r.backup) console.error(`  ⛁ 已保留备份：${r.backup}`)
}

/** 多机部署结果摘要（走 stderr）。 */
const renderMulti = (r: MultiDeployResult): void => {
    const okCount = r.hosts.filter((h) => h.ok).length
    console.error(`多机部署：${okCount}/${r.hosts.length} 成功`)
    for (const h of r.hosts) {
        if (h.ok && h.result) {
            const d = h.result
            console.error(
                `  ✓ ${h.host}：传输 ${d.transferred.length} / 跳过 ${d.skipped.length} / 失败 ${d.failed.length}`
            )
        } else {
            console.error(`  ✗ ${h.host}：${h.error?.message ?? '部署失败'}`)
        }
    }
}

/** 部署结果统一渲染：多机（含 hosts）走 {@link renderMulti}，单机走 {@link renderDeploy}。 */
const renderDeployOrMulti = (r: DeployResult | MultiDeployResult): void => {
    if ('hosts' in r) renderMulti(r)
    else renderDeploy(r)
}

/** 手动回滚结果摘要（走 stderr）。 */
const renderRollback = (r: RollbackResult): void => {
    if (r.ok) console.error(`已回滚：${r.remote} ← ${r.backup}`)
    else console.error(`未找到可回滚的备份：${r.remote}`)
}

/** 把下载结果渲染为人类摘要（走 stderr）。 */
const renderPull = (r: PullResult): void => {
    console.error('下载完成：')
    if (r.dirs.length) console.error(`  本地目录（${r.dirs.length}）`)
    console.error(`  下载 ${r.downloaded.length} / 失败 ${r.failed.length}`)
    r.failed.forEach((f) => console.error(`    ✗ ${f.target}：${f.error}`))
}

/** 把远程目录列表渲染为人类摘要（走 stderr）。 */
const renderLs = (r: LsResult): void => {
    console.error(`远程目录 ${r.remote}（${r.entries.length} 项）：`)
    for (const e of r.entries) {
        const tag = e.type === 'dir' ? 'd' : e.type === 'link' ? 'l' : '-'
        console.error(`  ${tag} ${String(e.size).padStart(10)}  ${e.name}`)
    }
}

/** 把 exec 结果渲染为人类摘要：stdout 原样到 stderr 区，附退出码。 */
const renderExec = (r: ExecRunResult): void => {
    if (r.stdout) process.stderr.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n')
    if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n')
    console.error(`退出码 ${r.code}`)
}

/** KB → GB 字符串（两位小数）。 */
const kbToGb = (kb: number): string => (kb / 1024 / 1024).toFixed(2)

/** 把资源快照渲染为人类摘要（走 stderr）。 */
const renderStatus = (r: StatusResult): void => {
    console.error(`主机 ${r.host ?? '?'}`)
    if (r.load) console.error(`  负载（1/5/15 分钟）：${r.load.join(' / ')}`)
    if (r.cpuCores !== null) console.error(`  CPU 核数：${r.cpuCores}`)
    if (r.memory) {
        console.error(`  内存：已用 ${kbToGb(r.memory.usedKb)}G / 总 ${kbToGb(r.memory.totalKb)}G`)
    }
    for (const d of r.disks) {
        console.error(`  磁盘 ${d.mountedOn}：${d.usePercent}% 已用（${d.filesystem}）`)
    }
}

/** 把日志行渲染到 stderr（每行原样）。 */
const renderLogs = (r: LogsResult): void => {
    console.error(`${r.path}（${r.lines.length} 行）：`)
    for (const line of r.lines) console.error(line)
}

/** 把进程快照渲染为人类摘要（走 stderr）。 */
const renderPs = (r: PsResult): void => {
    console.error(`进程（${r.processes.length}）：`)
    for (const p of r.processes) {
        const cpu = `${p.cpu.toFixed(1)}%`.padStart(6)
        const mem = `${p.mem.toFixed(1)}%`.padStart(6)
        console.error(`  ${String(p.pid).padStart(7)}  cpu ${cpu}  mem ${mem}  ${p.user.padEnd(10)}  ${p.command}`)
    }
}

/** 把服务操作结果渲染为人类摘要（走 stderr）。 */
const renderService = (r: ServiceResult): void => {
    console.error(`${r.manager} ${r.action} ${r.service} → 退出码 ${r.code}`)
    if (r.stdout) process.stderr.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n')
    if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n')
}

/** 把守护式编辑结果渲染为人类摘要（走 stderr）。 */
const renderEdit = (r: EditResult): void => {
    if (r.ok) console.error(`已编辑 ${r.target}${r.backup ? `（备份：${r.backup}）` : ''}`)
    else if (r.rolledBack) console.error(`编辑失败已回滚 ${r.target}：${r.error ?? ''}`)
    else console.error(`编辑失败 ${r.target}：${r.error ?? ''}`)
}

// deploy（默认命令，无子命令时执行；保持向后兼容）。
// 必须作为独立子命令而非 program 根命令——否则连接选项会与 pull/ls 子命令同名，
// commander 会把同名选项归到父命令，导致子命令收不到连接参数。
addConnectionOptions(program.command('deploy', { isDefault: true }))
    .description('部署/上传本地目录到远程（无子命令时默认执行）')
    .option('-l --local <local>', '本地路径')
    .option('-r --remote <remote>', '远程路径')
    .option('--dry-run', '预演：打印将执行的动作但不建立连接、不落地')
    .option('--no-audit', '禁用本地审计日志')
    .option('--audit-log <path>', '审计日志文件路径，默认 ~/.wink-sftp/audit.log')
    .option('-e --sftp-excludes <paths>', '要排除的本地目录，暂时只支持全字匹配，多个目录用英文逗号分隔，默认为空')
    .option('--sftp-ignore <patterns>', 'gitignore 风格忽略规则，多个用英文逗号分隔（与 .winksftpignore 合并）')
    .option('-f --sftp-flat', '是否扁平化目录（本地文件夹下任意深度的文件都直接传输到远程文件夹下），默认为false')
    .option('--sftp-clear', '是否在传输开始前清空远程文件夹，默认为false。慎用！删错了你别怪我！')
    .option('-o --sftp-override', '是否覆盖远程文件夹中已存在的文件，默认为false')
    .option('--sftp-incremental', '增量传输：按 size+mtime 比对，只传变更文件（优先于 override）')
    .option('--sftp-backup', '部署前对已存在的远程目标快照，传输失败自动回滚（文件级）')
    .option('-i --sftp-ignore-hidden', '是否忽略隐藏文件夹，默认为true')
    .option('-m --sftp-mode <mode>', '远程文件mode，默认为0o777')
    .option('--sftp-concurrency <n>', '传输与建目录的并发上限，默认为5')
    .option('--sftp-retries <n>', '单文件传输失败的额外重试次数，默认为2')
    .option('--before-run-command <command>', '传输开始前要执行的命令，别瞎写！')
    .option('--after-run-command <command>', '传输完成后要执行的命令，别瞎写！')
    .option('--hosts <list>', '多机部署：逗号分隔的主机地址，各自合并到连接配置之上（端口/用户/凭据共用）')
    .option('--fail-fast', '多机：首台失败即停止（默认跑完所有主机再汇总）')
    .option('--host-concurrency <n>', '多机：同时部署的主机数上限，默认为5')
    .option('--rollback', '手动回滚：把远程目标恢复到最近一次 --sftp-backup 生成的快照')
    .action(async (options: Record<string, unknown>) => {
        // 配置构造（含可能抛错的私钥读取）放进 execute 回调，统一由其 try/catch 兜底
        const buildConfig = (): RunOption => {
            const mode = options.sftpMode !== undefined ? parseInt(String(options.sftpMode), 8) : undefined
            const concurrency = options.sftpConcurrency !== undefined ? Number(options.sftpConcurrency) : undefined
            const retries = options.sftpRetries !== undefined ? Number(options.sftpRetries) : undefined
            const hostsArg = options.hosts as string | undefined
            const hosts = hostsArg
                ?.split(',')
                .map((h) => ({ host: h.trim() }))
                .filter((h) => h.host)
            // 提供了 --hosts 却解析不出任何有效主机（如 ",," / 纯空白）：明确报错，而非静默退化为单机
            if (hostsArg !== undefined && !hosts?.length) {
                throw new ConfigError(`--hosts 未解析出有效主机地址：${JSON.stringify(hostsArg)}`)
            }
            const hostConcurrency = options.hostConcurrency !== undefined ? Number(options.hostConcurrency) : undefined
            return {
                ...buildBase(options),
                local: options.local as string | undefined,
                remote: options.remote as string | undefined,
                dryRun: Boolean(options.dryRun),
                audit: options.audit as boolean | undefined,
                auditLog: options.auditLog as string | undefined,
                hosts: hosts?.length ? hosts : undefined,
                failFast: options.failFast as boolean | undefined,
                hostConcurrency,
                sftpOptions: {
                    excludes: (options.sftpExcludes as string | undefined)?.split(','),
                    ignore: (options.sftpIgnore as string | undefined)?.split(','),
                    flat: options.sftpFlat,
                    clear: options.sftpClear,
                    override: options.sftpOverride,
                    incremental: options.sftpIncremental,
                    backup: options.sftpBackup,
                    ignoreHidden: options.sftpIgnoreHidden,
                    mode,
                    concurrency,
                    retries,
                    debug: options.debug,
                    beforeRunCommand: options.beforeRunCommand,
                    afterRunCommand: options.afterRunCommand,
                } as SftpOption,
            }
        }
        const json = Boolean(options.json)
        if (options.rollback) {
            await execute(json, () => rollback(buildConfig()), renderRollback)
        } else {
            await execute(json, () => runAuto(buildConfig()), renderDeployOrMulti)
        }
    })

// pull（下载）：把远程文件/目录拉取到本地
addConnectionOptions(program.command('pull'))
    .description('从远程下载文件/目录到本地（fastGet，目录递归镜像）')
    .option('-l --local <local>', '本地目标路径')
    .option('-r --remote <remote>', '远程源路径')
    .option('--sftp-concurrency <n>', '下载并发上限，默认为5')
    .option('--sftp-retries <n>', '单文件下载失败的额外重试次数，默认为2')
    .action(async (options: Record<string, unknown>) => {
        await execute(
            Boolean(options.json),
            () => {
                const concurrency = options.sftpConcurrency !== undefined ? Number(options.sftpConcurrency) : undefined
                const retries = options.sftpRetries !== undefined ? Number(options.sftpRetries) : undefined
                const config: RunOption = {
                    ...buildBase(options),
                    local: options.local as string | undefined,
                    remote: options.remote as string | undefined,
                    sftpOptions: { concurrency, retries, debug: options.debug } as SftpOption,
                }
                return pull(config)
            },
            renderPull
        )
    })

// ls（远程浏览）：列出远程目录内容（只读）
addConnectionOptions(program.command('ls'))
    .description('列出远程目录内容（只读）')
    .argument('[remote]', '要列出的远程目录（不带 -c 时亦可用 -r 指定）')
    .option('-r --remote <remote>', '远程目录路径')
    .action(async (remoteArg: string | undefined, options: Record<string, unknown>) => {
        await execute(
            Boolean(options.json),
            () => {
                const config: RunOption = {
                    ...buildBase(options),
                    remote: (remoteArg ?? options.remote) as string | undefined,
                }
                return ls(config)
            },
            renderLs,
            1
        )
    })

// exec（远程执行）：跑一条远程命令并收集结构化结果；退出码透传为进程退出码
addConnectionOptions(program.command('exec'))
    .description('在远程执行命令并收集 stdout/stderr/退出码（读/写原语）')
    .argument('<command>', '要执行的远程命令（建议用引号包裹整条命令）')
    .action(async (command: string, options: Record<string, unknown>) => {
        const json = Boolean(options.json)
        try {
            const result = await runExec(command, buildBase(options))
            if (json) process.stdout.write(JSON.stringify(result) + '\n')
            else renderExec(result)
            process.exitCode = result.code // 远程命令退出码透传，便于脚本分支
        } catch (e) {
            handleError(e, json)
        }
    })

// status（资源快照）：agentless 采集 CPU/内存/磁盘/负载（只读）
addConnectionOptions(program.command('status'))
    .description('远程主机资源/健康快照：CPU/内存/磁盘/负载（只读，best-effort）')
    .action(async (options: Record<string, unknown>) => {
        await execute(Boolean(options.json), () => status(buildBase(options)), renderStatus, 1)
    })

// logs（日志查看）：tail -n + 可选 grep（只读）
addConnectionOptions(program.command('logs'))
    .description('查看远程日志：tail 末 N 行 + 可选 grep 过滤（只读）')
    .argument('<path>', '远程日志文件路径')
    .option('-n --lines <n>', '查看末尾多少行，默认 200')
    .option('--grep <pattern>', '只保留匹配该模式的行（grep）')
    .action(async (remotePath: string, options: Record<string, unknown>) => {
        await execute(
            Boolean(options.json),
            () =>
                tailLogs(remotePath, buildBase(options), {
                    lines: options.lines !== undefined ? Number(options.lines) : undefined,
                    grep: options.grep as string | undefined,
                }),
            renderLogs,
            1
        )
    })

// edit（守护式配置编辑）：用本地文件内容原子替换远程文件，失败回滚（写）
addConnectionOptions(program.command('edit'))
    .description('守护式编辑远程配置：备份→替换→校验→reload→失败回滚（写）')
    .argument('[remote]', '远程目标文件（亦可用 -r 指定）')
    .option('-r --remote <remote>', '远程目标文件路径')
    .option('--file <path>', '本地内容文件（其内容将替换远程文件）')
    .option('--validate <command>', '替换后执行的校验命令（如 "nginx -t"），失败回滚')
    .option('--reload <command>', '校验通过后执行的 reload 命令（如 "systemctl reload nginx"），失败回滚')
    .action(async (remoteArg: string | undefined, options: Record<string, unknown>) => {
        await execute(
            Boolean(options.json),
            () => {
                const remote = (remoteArg ?? options.remote) as string | undefined
                if (!remote) throw new ConfigError('edit 需要远程目标文件（位置参数或 -r）')
                if (!options.file) throw new ConfigError('edit 需要 --file 指定本地内容文件')
                return edit(
                    {
                        remote,
                        file: options.file as string,
                        validate: options.validate as string | undefined,
                        reload: options.reload as string | undefined,
                    },
                    buildBase(options)
                )
            },
            renderEdit,
            4
        )
    })

// ps（进程快照）：ps -A 解析为结构化进程列表，可选 --grep 过滤（只读）
addConnectionOptions(program.command('ps'))
    .description('远程进程快照：PID/属主/CPU/内存/命令，可选 --grep 过滤（只读）')
    .option('--grep <pattern>', '只保留命令行包含该子串的进程')
    .action(async (options: Record<string, unknown>) => {
        await execute(
            Boolean(options.json),
            () => ps(buildBase(options), { grep: options.grep as string | undefined }),
            renderPs,
            1
        )
    })

// service（服务管理）：status 只读放行；start/stop/restart/reload 为写动作需 --yes（写本地审计）
addConnectionOptions(program.command('service'))
    .description('服务管理：status（只读）/ start·stop·restart·reload（写，需 --yes）')
    .argument('<name>', '服务/容器名')
    .argument('<action>', `动作：${SERVICE_ACTIONS.join('|')}`)
    .option('--manager <manager>', `服务管理器：${SERVICE_MANAGERS.join('|')}（默认 systemd）`, 'systemd')
    .option('--yes', '确认执行写动作（start/stop/restart/reload）')
    .action(async (svcName: string, action: string, options: Record<string, unknown>) => {
        await execute(
            Boolean(options.json),
            () => {
                if (!SERVICE_ACTIONS.includes(action as ServiceAction)) {
                    throw new ConfigError(`未知服务动作：${action}（支持 ${SERVICE_ACTIONS.join('/')}）`)
                }
                const manager = options.manager as string
                if (!SERVICE_MANAGERS.includes(manager as ServiceManager)) {
                    throw new ConfigError(`未知服务管理器：${manager}（支持 ${SERVICE_MANAGERS.join('/')}）`)
                }
                return service(svcName, action as ServiceAction, buildBase(options), {
                    manager: manager as ServiceManager,
                    yes: Boolean(options.yes),
                })
            },
            renderService,
            4
        )
    })

program.parse()
