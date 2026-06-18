import type { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import { scan, loadIgnorePatterns } from './scanner'
import { resolveLocal, linuxPath, remoteIsDir, buildRemoteTarget, buildRemoteDir, findFlatCollisions } from './pathmap'
import { execCommand, shellQuote } from './exec'
import { mapPool, DEFAULT_CONCURRENCY } from './pool'
import { withRetry, DEFAULT_RETRIES } from './retry'
import { appendAudit } from './audit'
import { resolveConfig } from './config'
import { Logger } from './logger'
import { withSession } from './session'
import { ConfigError, ConnectionError, TransferError } from './errors'

export interface SftpOption {
    excludes?: string[]
    /** gitignore 风格忽略规则（与本地根目录下的 `.winksftpignore` 合并），按 glob 匹配。 */
    ignore?: string[]
    flat?: boolean
    clear?: boolean
    override?: boolean
    /** 增量传输：按 size + mtime 比对远程文件，仅传变更项（优先级高于 override）。 */
    incremental?: boolean
    debug?: boolean
    mode?: number
    ignoreHidden?: boolean
    beforeRunCommand?: string
    afterRunCommand?: string
    /** 传输与建目录的并发上限（默认 {@link DEFAULT_CONCURRENCY}），避免打满 SSH `MaxSessions`。 */
    concurrency?: number
    /** 单文件传输失败的额外重试次数（默认 {@link DEFAULT_RETRIES}），抵御网络抖动。 */
    retries?: number
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
    /** 是否记录本地审计日志（默认 true；预演不记录）。 */
    audit?: boolean
    /** 审计日志文件路径（默认 `~/.wink-sftp/audit.log`）。 */
    auditLog?: string
    /** 选择的环境名（多环境配置），对应配置文件 `environments` 下的键。 */
    env?: string
    /** 多环境覆盖表：环境名 → 覆盖配置（深合并到基础配置之上）。 */
    environments?: Record<string, EnvOverride>
}

/** 多环境覆盖：环境名下可覆盖的配置子集（不含 `env`/`environments`/`config` 等调用级字段）。 */
export type EnvOverride = Omit<RunOption, 'env' | 'environments' | 'config'>

export interface ResolvedConfig {
    connect: ConnectConfig
    local: string
    remote: string
    sftpOptions: SftpOption
    debug: boolean
    json: boolean
    dryRun: boolean
    audit: boolean
    auditLog: string
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
    /** 已跳过（已存在且未开启 override，或增量比对未变更）的远程目标。 */
    skipped: string[]
    /** 传输失败的目标及原因。 */
    failed: { target: string; error: string }[]
    /** 已创建（或预演将创建）的远程目录。 */
    dirs: string[]
    /** 已执行（或预演将执行）的远程命令。 */
    commands: string[]
    /** 非致命告警（如 flat 模式同名覆盖）。 */
    warnings: string[]
}

/** 远程目录中的一项（`ls` 结果元素）。 */
export interface RemoteEntry {
    /** 文件名（不含路径）。 */
    name: string
    /** 类型：文件 / 目录 / 符号链接 / 其它。 */
    type: 'file' | 'dir' | 'link' | 'other'
    /** 字节大小。 */
    size: number
    /** 修改时间（秒）。 */
    mtime: number
}

/** `ls` 远程浏览结果。 */
export interface LsResult {
    ok: true
    /** 被列出的远程目录。 */
    remote: string
    /** 目录项（按名称排序）。 */
    entries: RemoteEntry[]
}

/** `pull` 下载结果。 */
export interface PullResult {
    /** 是否全部成功（无失败文件）。 */
    ok: boolean
    /** 本地根目录（绝对路径）。 */
    local: string
    /** 远程源路径。 */
    remote: string
    /** 已下载的本地文件路径。 */
    downloaded: string[]
    /** 下载失败的远程源及原因。 */
    failed: { target: string; error: string }[]
    /** 已创建的本地目录。 */
    dirs: string[]
}

const DEFAULT_MODE = 0o777

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

/** 取远程文件完整 `Stats`；不存在或出错返回 null，绝不抛错。存在性检查与增量比对共用。 */
const statRemote = (sftp: SFTPWrapper, target: string): Promise<Stats | null> =>
    new Promise((resolve) => {
        sftp.stat(target, (err, stats: Stats) => resolve(err ? null : stats))
    })

/** 上传后把远程 mtime 设为本地 mtime（秒），使增量比对不受两机时钟差影响；失败仅忽略（增量退化为重传）。 */
const setRemoteMtime = (sftp: SFTPWrapper, target: string, local: fs.Stats): Promise<void> =>
    new Promise((resolve) => {
        const sec = Math.floor(local.mtimeMs / 1000)
        sftp.utimes(target, sec, sec, () => resolve())
    })

/**
 * 增量判定：远程已存在、size 相同、且远程 mtime 与本地 mtime（秒）**相等**时视为未变更。
 * 因上传后用 {@link setRemoteMtime} 把远程 mtime 对齐为本地 mtime，比较以本地时钟为唯一基准、
 * 不依赖远程时钟，避免两机时钟偏差导致改动文件被误跳过。
 */
const isUnchanged = (local: fs.Stats, remote: { size: number; mtime: number }): boolean =>
    remote.size === local.size && remote.mtime === Math.floor(local.mtimeMs / 1000)

const fastPut = (sftp: SFTPWrapper, file: string, target: string, mode: number): Promise<void> =>
    new Promise((resolve, reject) => {
        sftp.fastPut(file, target, { mode }, (err) =>
            err ? reject(new TransferError(`传输失败：${file} => ${target}`, { cause: err })) : resolve()
        )
    })

/** 生成 `[n/total] 状态 目标` 进度回调（部署与下载共用）。 */
const makeProgress = (logger: Logger, total: number): ((status: string, target: string) => void) => {
    let done = 0
    return (status, target) => logger.info(`[${++done}/${total}] ${status} ${target}`)
}

/** 计算扫描结果与基础映射（dry-run 与实跑共用）。 */
const computePlan = (config: ResolvedConfig) => {
    const local = resolveLocal(config.local)
    const { remote, sftpOptions: opts } = config
    const excludes = (opts.excludes ?? []).map((item) => resolveLocal(config.local, item))
    const ignorePatterns = loadIgnorePatterns(local, opts.ignore)
    const { dirs, files } = scan(local, { ignoreHidden: opts.ignoreHidden ?? true, excludes, ignorePatterns })
    const isDir = remoteIsDir(files, remote)
    const flat = opts.flat ?? false
    const remoteDirs = flat ? [] : dirs.map((dir) => buildRemoteDir(dir, local, remote))
    const targets = files.map((file) => ({
        file,
        target: buildRemoteTarget(file, { local, remote, remoteIsDir: isDir, flat }),
    }))
    const warnings = flat
        ? findFlatCollisions(targets).map(
              (c) => `flat 模式同名覆盖：${c.target} ← ${c.files.join('、')}（仅最后传入者生效）`
          )
        : []
    return { local, remote, opts, isDir, remoteDirs, targets, warnings }
}

/** 预演：仅本地计算将执行的动作，不建立连接、不落地。 */
const planDeploy = (config: ResolvedConfig): DeployResult => {
    const { local, remote, opts, isDir, remoteDirs, targets, warnings } = computePlan(config)
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
        warnings,
    }
}

/** 实跑部署：建目录、传文件、跑前后命令，返回结构化结果。 */
const deploy = async (client: Client, config: ResolvedConfig, logger: Logger): Promise<DeployResult> => {
    const sftp = await openSftp(client)
    const opts = config.sftpOptions
    const commands: string[] = []
    const mode = opts.mode ?? DEFAULT_MODE
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    const retries = opts.retries ?? DEFAULT_RETRIES

    // 前置命令在扫描前执行，使其产物（如构建输出）能被纳入本次传输列表
    if (opts.beforeRunCommand) {
        logger.debug('执行前置命令：' + opts.beforeRunCommand)
        await execCommand(client, opts.beforeRunCommand)
        commands.push(opts.beforeRunCommand)
    }

    const { local, remote, isDir, remoteDirs, targets, warnings } = computePlan(config)
    logger.debug('待传输文件数：' + targets.length)
    warnings.forEach((w) => logger.warn('⚠ ' + w))

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
    const progress = makeProgress(logger, targets.length)
    // 受限并发传输：同一时刻最多 concurrency 个文件在飞
    await mapPool(targets, concurrency, async ({ file, target }) => {
        try {
            const localStat = fs.statSync(file)
            // 增量优先：远程未变更则跳过；否则覆盖传输（不再看 override）
            if (opts.incremental) {
                const remoteInfo = await statRemote(sftp, target)
                if (remoteInfo && isUnchanged(localStat, remoteInfo)) {
                    logger.debug('增量比对未变更，跳过：' + target)
                    skipped.push(target)
                    progress('跳过', target)
                    return
                }
            } else if (!opts.override && (await statRemote(sftp, target))) {
                logger.debug('文件已存在，跳过：' + target)
                skipped.push(target)
                progress('跳过', target)
                return
            }
            logger.debug(`开始传输：${file} => ${target}`)
            await withRetry(() => fastPut(sftp, file, target, mode), {
                retries,
                delayMs: 200,
                onRetry: (attempt, e) =>
                    logger.warn(
                        `传输失败，重试 ${attempt}/${retries}：${target}（${e instanceof Error ? e.message : String(e)}）`
                    ),
            })
            // 对齐远程 mtime，使后续 --sftp-incremental 比对以本地时钟为准
            await setRemoteMtime(sftp, target, localStat)
            transferred.push(target)
            progress('已传', target)
        } catch (e) {
            failed.push({ target, error: e instanceof Error ? e.message : String(e) })
            progress('失败', target)
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
        warnings,
    }
}

/**
 * 通用连接运行器：经 {@link withSession} 新建独立会话，在其底层 `Client` 上运行 `fn`，结束后断开。
 * 连接失败 / 超时 reject 类型化 {@link ConnectionError}。部署 / 下载 / 浏览共用。
 */
const withConnection = <T>(connect: ConnectConfig, logger: Logger, fn: (client: Client) => Promise<T>): Promise<T> =>
    withSession(connect, logger, (session) => fn(session.raw as Client))

/** 记录一条审计；写入失败仅降级为 debug 日志，绝不中断主流程。 */
const recordAudit = (config: ResolvedConfig, logger: Logger, ok: boolean, detail: Record<string, unknown>): void => {
    if (!config.audit) return
    try {
        appendAudit(config.auditLog, {
            time: new Date().toISOString(),
            host: config.connect.host,
            username: config.connect.username,
            action: 'deploy',
            ok,
            detail: { remote: config.remote, ...detail },
        })
    } catch (e) {
        // 审计写入失败不应中断部署，但用户已显式启用审计，需 warn 提示而非静默
        logger.warn('⚠ 审计日志写入失败：' + (e instanceof Error ? e.message : String(e)))
    }
}

/**
 * 入口：解析配置后执行部署或预演。
 *
 * 成功 resolve {@link DeployResult}（含 `ok`，部分文件失败时 `ok=false`）；
 * 配置/连接/远程命令错误时 reject 类型化错误。退出码由 CLI 层据此决定。
 * 实跑（非预演）会在结束后追加一条本地审计记录。
 */
export const run = async (options?: RunOption): Promise<DeployResult> => {
    const config = resolveConfig(options)
    const logger = new Logger({ debug: config.debug, json: config.json })
    logger.debug('解析后的配置：', config)
    if (config.dryRun) return planDeploy(config)
    try {
        const result = await withConnection(config.connect, logger, (client) => deploy(client, config, logger))
        recordAudit(config, logger, result.ok, {
            transferred: result.transferred.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
            commands: result.commands,
        })
        return result
    } catch (e) {
        recordAudit(config, logger, false, { error: e instanceof Error ? e.message : String(e) })
        throw e
    }
}

/** 把远程 `Stats` 归类为 {@link RemoteEntry} 的 type。 */
const classify = (attrs: Stats): RemoteEntry['type'] =>
    attrs.isDirectory() ? 'dir' : attrs.isSymbolicLink() ? 'link' : attrs.isFile() ? 'file' : 'other'

/** 列出远程目录（按名称排序）。读取失败抛 {@link TransferError}。 */
const readdir = (sftp: SFTPWrapper, dir: string): Promise<RemoteEntry[]> =>
    new Promise((resolve, reject) => {
        sftp.readdir(dir, (err, list) => {
            if (err) {
                reject(new TransferError(`读取远程目录失败：${dir}`, { cause: err }))
                return
            }
            resolve(
                list
                    .map((e) => ({
                        name: e.filename,
                        type: classify(e.attrs),
                        size: e.attrs.size,
                        mtime: e.attrs.mtime,
                    }))
                    .toSorted((a, b) => a.name.localeCompare(b.name))
            )
        })
    })

/** 递归遍历远程目录，收集所有文件与目录的绝对 POSIX 路径。 */
const walkRemote = async (sftp: SFTPWrapper, root: string): Promise<{ files: string[]; dirs: string[] }> => {
    const files: string[] = []
    const dirs: string[] = []
    const recurse = async (dir: string): Promise<void> => {
        dirs.push(dir)
        const entries = await readdir(sftp, dir)
        for (const e of entries) {
            const full = linuxPath(dir, e.name)
            // 顺序递归子目录：远程目录树通常不深，避免一次性打开过多 SFTP 会话
            // eslint-disable-next-line no-await-in-loop
            if (e.type === 'dir') await recurse(full)
            else if (e.type === 'file') files.push(full)
        }
    }
    await recurse(root)
    return { files, dirs }
}

const fastGet = (sftp: SFTPWrapper, remote: string, local: string): Promise<void> =>
    new Promise((resolve, reject) => {
        sftp.fastGet(remote, local, (err) =>
            err ? reject(new TransferError(`下载失败：${remote} => ${local}`, { cause: err })) : resolve()
        )
    })

/**
 * 远程文件浏览：列出 `remote` 指向的目录内容（只读，不写审计）。
 * 需要 connect + remote；不需要 local。失败 reject 类型化错误。
 */
export const ls = async (options?: RunOption): Promise<LsResult> => {
    const config = resolveConfig(options, { requireLocal: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    logger.debug('解析后的配置：', config)
    return withConnection(config.connect, logger, async (client) => {
        const sftp = await openSftp(client)
        const entries = await readdir(sftp, config.remote)
        return { ok: true, remote: config.remote, entries }
    })
}

/**
 * 下载：把远程 `remote`（文件或目录）拉取到本地 `local`，镜像目录结构。
 * 受限并发 + 单文件失败重试。远程为目录时递归下载；为文件时下载单个文件。
 */
export const pull = async (options?: RunOption): Promise<PullResult> => {
    const config = resolveConfig(options)
    const logger = new Logger({ debug: config.debug, json: config.json })
    logger.debug('解析后的配置：', config)
    const localRoot = resolveLocal(config.local)
    const remote = config.remote
    const opts = config.sftpOptions
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    const retries = opts.retries ?? DEFAULT_RETRIES
    return withConnection(config.connect, logger, async (client) => {
        const sftp = await openSftp(client)
        const stats = await statRemote(sftp, remote)
        if (!stats) throw new TransferError(`远程路径不存在：${remote}`)

        let jobs: { remoteFile: string; localFile: string }[]
        let dirs: string[]
        if (stats.isDirectory()) {
            const walked = await walkRemote(sftp, remote)
            jobs = walked.files.map((rf) => ({
                remoteFile: rf,
                localFile: path.join(localRoot, path.posix.relative(remote, rf)),
            }))
            dirs = walked.dirs.map((d) => path.join(localRoot, path.posix.relative(remote, d)))
        } else {
            // 单文件：local 已存在且是目录则落到 local/<basename>，否则把 local 当作目标文件路径
            const localIsDir = fs.existsSync(localRoot) && fs.statSync(localRoot).isDirectory()
            const localFile = localIsDir ? path.join(localRoot, path.posix.basename(remote)) : localRoot
            jobs = [{ remoteFile: remote, localFile }]
            dirs = [path.dirname(localFile)]
        }

        // 预先建好所有本地目录（含每个文件的父目录），传输时不再逐个 mkdir
        const uniqueDirs = [...new Set(dirs)]
        for (const d of uniqueDirs) fs.mkdirSync(d, { recursive: true })

        const downloaded: string[] = []
        const failed: PullResult['failed'] = []
        const progress = makeProgress(logger, jobs.length)
        await mapPool(jobs, concurrency, async ({ remoteFile, localFile }) => {
            try {
                await withRetry(() => fastGet(sftp, remoteFile, localFile), {
                    retries,
                    delayMs: 200,
                    onRetry: (attempt, e) =>
                        logger.warn(
                            `下载失败，重试 ${attempt}/${retries}：${remoteFile}（${e instanceof Error ? e.message : String(e)}）`
                        ),
                })
                downloaded.push(localFile)
                progress('已下', localFile)
            } catch (e) {
                failed.push({ target: remoteFile, error: e instanceof Error ? e.message : String(e) })
                progress('失败', remoteFile)
            }
        })
        return { ok: failed.length === 0, local: localRoot, remote, downloaded, failed, dirs: uniqueDirs }
    })
}
