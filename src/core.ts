import { Client } from 'ssh2'
import type { ConnectConfig, SFTPWrapper } from 'ssh2'
import fs from 'node:fs'
import { scan } from './scanner'
import { resolveLocal, remoteIsDir, buildRemoteTarget, buildRemoteDir } from './pathmap'
import { execCommand, shellQuote } from './exec'
import { mapPool, DEFAULT_CONCURRENCY } from './pool'
import { Logger } from './logger'
import { ConfigError, ConnectionError, TransferError } from './errors'

export interface SftpOption {
    excludes?: string[]
    flat?: boolean
    clear?: boolean
    override?: boolean
    debug?: boolean
    mode?: number
    ignoreHidden?: boolean
    beforeRunCommand?: string
    afterRunCommand?: string
    /** 传输与建目录的并发上限（默认 {@link DEFAULT_CONCURRENCY}），避免打满 SSH `MaxSessions`。 */
    concurrency?: number
}

export interface RunOption {
    connect?: ConnectConfig
    local?: string
    remote?: string
    sftpOptions?: SftpOption
    debug?: boolean
    config?: string | false
    /** JSON 模式：结果走 stdout。 */
    json?: boolean
    /** 预演：打印将执行的动作但不落地（不建立连接）。 */
    dryRun?: boolean
}

interface ResolvedConfig {
    connect: ConnectConfig
    local: string
    remote: string
    sftpOptions: SftpOption
    debug: boolean
    json: boolean
    dryRun: boolean
}

/** 部署结果：结构化，供 CLI 渲染与定退出码、供 agent 解析。 */
export interface DeployResult {
    /** 是否全部成功（无失败文件）。 */
    ok: boolean
    /** 是否为预演。 */
    dryRun: boolean
    /** 本地根目录（绝对路径）。 */
    local: string
    /** 远程根路径。 */
    remote: string
    /** 已传输（或预演将传输）的远程目标。 */
    transferred: string[]
    /** 已跳过（已存在且未开启 override）的远程目标。 */
    skipped: string[]
    /** 传输失败的目标及原因。 */
    failed: { target: string; error: string }[]
    /** 已创建（或预演将创建）的远程目录。 */
    dirs: string[]
    /** 已执行（或预演将执行）的远程命令。 */
    commands: string[]
}

const DEFAULT_MODE = 0o777

/** 合并配置文件 / CLI 选项并校验，返回归一化配置。校验失败抛 {@link ConfigError}。 */
const resolveConfig = (options: RunOption = {}): ResolvedConfig => {
    const { config = false } = options
    // json / dryRun / debug 是调用级开关，即便用 -c 配置文件也应生效（叠加在文件之上）。
    const cliDebug = options.debug ?? false
    const cliJson = options.json ?? false
    const cliDryRun = options.dryRun ?? false
    let raw: RunOption = options
    if (config) {
        try {
            raw = JSON.parse(String(fs.readFileSync(resolveLocal(config)))) as RunOption
        } catch (e) {
            throw new ConfigError(`解析配置文件失败：${config}`, { cause: e })
        }
    }
    const connect = raw.connect ?? {}
    if (!connect.host || !connect.port || !connect.username || !connect.password || !raw.local || !raw.remote) {
        throw new ConfigError(
            '配置至少包含以下属性：connect.host、connect.port、connect.username、connect.password、local、remote'
        )
    }
    const debug = raw.debug ?? cliDebug
    const sftpOptions: SftpOption = { ...raw.sftpOptions }
    sftpOptions.debug ??= debug
    return {
        connect,
        local: raw.local,
        remote: raw.remote,
        sftpOptions,
        debug,
        json: (raw.json ?? false) || cliJson,
        dryRun: (raw.dryRun ?? false) || cliDryRun,
    }
}

/** 校验 clear 目标路径安全：非空、非 `/`、至少含一个有效路径段。 */
const assertSafeClearTarget = (remote: string): void => {
    const trimmed = remote.trim()
    const segments = trimmed
        .replace(/\/+$/, '')
        .split('/')
        .filter((s) => s && s !== '.')
    if (!trimmed || trimmed === '/' || segments.length === 0) {
        throw new ConfigError(`clear 目标路径不安全，拒绝清空：${JSON.stringify(remote)}`)
    }
}

const openSftp = (client: Client): Promise<SFTPWrapper> =>
    new Promise((resolve, reject) => {
        client.sftp((err, sftp) => (err ? reject(new ConnectionError('SFTP 开启失败', { cause: err })) : resolve(sftp)))
    })

/** 远程文件是否存在（用 `stat`，不抛错，仅返回布尔）。 */
const remoteExists = async (client: Client, target: string): Promise<boolean> => {
    try {
        await execCommand(client, `stat ${shellQuote(target)}`)
        return true
    } catch {
        return false
    }
}

const fastPut = (sftp: SFTPWrapper, file: string, target: string, mode: number): Promise<void> =>
    new Promise((resolve, reject) => {
        sftp.fastPut(file, target, { mode }, (err) =>
            err ? reject(new TransferError(`传输失败：${file} => ${target}`, { cause: err })) : resolve()
        )
    })

/** 计算扫描结果与基础映射（dry-run 与实跑共用）。 */
const computePlan = (config: ResolvedConfig) => {
    const local = resolveLocal(config.local)
    const { remote, sftpOptions: opts } = config
    const excludes = (opts.excludes ?? []).map((item) => resolveLocal(config.local, item))
    const { dirs, files } = scan(local, { ignoreHidden: opts.ignoreHidden ?? true, excludes })
    const isDir = remoteIsDir(files, remote)
    const flat = opts.flat ?? false
    const remoteDirs = flat ? [] : dirs.map((dir) => buildRemoteDir(dir, local, remote))
    const targets = files.map((file) => ({
        file,
        target: buildRemoteTarget(file, { local, remote, remoteIsDir: isDir, flat }),
    }))
    return { local, remote, opts, isDir, remoteDirs, targets }
}

/** 预演：仅本地计算将执行的动作，不建立连接、不落地。 */
const planDeploy = (config: ResolvedConfig): DeployResult => {
    const { local, remote, opts, isDir, remoteDirs, targets } = computePlan(config)
    const commands: string[] = []
    if (opts.beforeRunCommand) commands.push(opts.beforeRunCommand)
    if (isDir && opts.clear) {
        assertSafeClearTarget(remote)
        commands.push(`rm -rf ${shellQuote(remote)}/*`)
    }
    if (opts.afterRunCommand) commands.push(opts.afterRunCommand)
    return {
        ok: true,
        dryRun: true,
        local,
        remote,
        transferred: targets.map((t) => t.target),
        skipped: [],
        failed: [],
        dirs: remoteDirs,
        commands,
    }
}

/** 实跑部署：建目录、传文件、跑前后命令，返回结构化结果。 */
const deploy = async (client: Client, config: ResolvedConfig, logger: Logger): Promise<DeployResult> => {
    const sftp = await openSftp(client)
    const opts = config.sftpOptions
    const commands: string[] = []
    const mode = opts.mode ?? DEFAULT_MODE
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY

    // 前置命令在扫描前执行，使其产物（如构建输出）能被纳入本次传输列表
    if (opts.beforeRunCommand) {
        logger.debug('执行前置命令：' + opts.beforeRunCommand)
        await execCommand(client, opts.beforeRunCommand)
        commands.push(opts.beforeRunCommand)
    }

    const { local, remote, isDir, remoteDirs, targets } = computePlan(config)
    logger.debug('待传输文件数：' + targets.length)

    if (isDir && opts.clear) {
        assertSafeClearTarget(remote)
        const cmd = `rm -rf ${shellQuote(remote)}/*`
        await execCommand(client, cmd)
        commands.push(cmd)
        logger.debug('已清空远程文件夹：' + remote)
    }

    // 受限并发建目录，避免一次性打满 SSH MaxSessions
    await mapPool(remoteDirs, concurrency, async (dir) => {
        await execCommand(client, `mkdir -p ${shellQuote(dir)}`)
        logger.debug('创建文件夹：' + dir)
    })

    const transferred: string[] = []
    const skipped: string[] = []
    const failed: DeployResult['failed'] = []
    // 受限并发传输：同一时刻最多 concurrency 个文件在飞
    await mapPool(targets, concurrency, async ({ file, target }) => {
        try {
            if (!opts.override && (await remoteExists(client, target))) {
                logger.debug('文件已存在，跳过：' + target)
                skipped.push(target)
                return
            }
            logger.debug(`开始传输：${file} => ${target}`)
            await fastPut(sftp, file, target, mode)
            transferred.push(target)
        } catch (e) {
            failed.push({ target, error: e instanceof Error ? e.message : String(e) })
        }
    })

    if (opts.afterRunCommand) {
        logger.debug('执行后置命令：' + opts.afterRunCommand)
        await execCommand(client, opts.afterRunCommand)
        commands.push(opts.afterRunCommand)
    }

    return {
        ok: failed.length === 0,
        dryRun: false,
        local,
        remote,
        transferred,
        skipped,
        failed,
        dirs: remoteDirs,
        commands,
    }
}

const connectAndDeploy = (config: ResolvedConfig, logger: Logger): Promise<DeployResult> =>
    new Promise((resolve, reject) => {
        const client = new Client()
        let settled = false
        const finish = (fn: () => void) => {
            if (!settled) {
                settled = true
                fn()
            }
        }
        client
            .on('ready', async () => {
                logger.debug('连接成功')
                try {
                    const result = await deploy(client, config, logger)
                    finish(() => resolve(result))
                } catch (e) {
                    finish(() => reject(e))
                } finally {
                    client.end()
                }
            })
            .on('error', (err) => finish(() => reject(new ConnectionError('SSH 连接失败', { cause: err }))))
            .on('timeout', () => finish(() => reject(new ConnectionError('SSH 会话超时'))))
            .connect(config.connect)
    })

/**
 * 入口：解析配置后执行部署或预演。
 *
 * 成功 resolve {@link DeployResult}（含 `ok`，部分文件失败时 `ok=false`）；
 * 配置/连接/远程命令错误时 reject 类型化错误。退出码由 CLI 层据此决定。
 */
export const run = (options?: RunOption): Promise<DeployResult> => {
    const config = resolveConfig(options)
    const logger = new Logger({ debug: config.debug, json: config.json })
    logger.debug('解析后的配置：', config)
    return config.dryRun ? Promise.resolve(planDeploy(config)) : connectAndDeploy(config, logger)
}
