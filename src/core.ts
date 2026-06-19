import type { ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import { scan, loadIgnorePatterns } from './scanner'
import { resolveLocal, linuxPath, remoteIsDir, buildRemoteTarget, buildRemoteDir, findFlatCollisions } from './pathmap'
import { shellQuote } from './exec'
import { mapPool, DEFAULT_CONCURRENCY } from './pool'
import { withRetry, DEFAULT_RETRIES } from './retry'
import { recordAudit } from './audit'
import { resolveConfig, mergeConfig } from './config'
import { Logger } from './logger'
import { withSession } from './session'
import type { SshSession } from './session'
import { backupRemote, restoreRemote } from './guard'
import { ConfigError, TransferError, WinkOpsError } from './errors'

export interface SftpOption {
    excludes?: string[]
    /** gitignore 风格忽略规则（与本地根目录下的 `.winkignore` 合并），按 glob 匹配。 */
    ignore?: string[]
    flat?: boolean
    clear?: boolean
    override?: boolean
    /** 增量传输：按 size + mtime 比对远程文件，仅传变更项（优先级高于 override）。 */
    incremental?: boolean
    /**
     * 文件级备份/回滚：部署前对已存在的远程目标快照（`cp -a` 到 `${remote}.wink-bak.<ts>`），
     * 任一文件传输失败则自动回滚到快照（仅回滚文件，不撤销前后置命令等副作用）。成功则保留快照。
     */
    backup?: boolean
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

/** stack 中单个组件的声明值：版本字符串/数字、布尔开关，或带 `version` 的对象。 */
export type StackValue = string | number | boolean | Record<string, unknown>
/** 声明式 stack（provision）：组件名 → 声明值。 */
export type StackSpec = Record<string, StackValue>

export interface RunOption {
    connect?: ConnectConfig
    local?: string
    remote?: string
    sftpOptions?: SftpOption
    /** provision 声明式 stack：组件名 → 目标版本/开关（参与配置合并，可经 environments 覆盖）。 */
    stack?: StackSpec
    debug?: boolean
    config?: string | false
    /** JSON 模式：结果走 stdout。 */
    json?: boolean
    /** 预演：打印将执行的动作但不落地（不建立连接）。 */
    dryRun?: boolean
    /** 是否记录本地审计日志（默认 true；预演不记录）。 */
    audit?: boolean
    /** 审计日志文件路径（默认 `~/.winkops/audit.log`）。 */
    auditLog?: string
    /** 选择的环境名（多环境配置），对应配置文件 `environments` 下的键。 */
    env?: string
    /** 多环境覆盖表：环境名 → 覆盖配置（深合并到基础配置之上）。 */
    environments?: Record<string, EnvOverride>
    /** 多机部署：每台主机的连接覆盖（深合并到基础 `connect` 之上，至少含 `host`）；非空则走多机编排。 */
    hosts?: ConnectConfig[]
    /** 多机失败策略：true=fail-fast（首台失败即停）；false=continue（默认，跑完所有主机再汇总）。 */
    failFast?: boolean
    /** 多机并发上限（同时部署的主机数，默认 {@link DEFAULT_CONCURRENCY}）。 */
    hostConcurrency?: number
}

/** 多环境覆盖：环境名下可覆盖的配置子集（不含 `env`/`environments`/`config` 等调用级字段）。 */
export type EnvOverride = Omit<RunOption, 'env' | 'environments' | 'config'>

export interface ResolvedConfig {
    connect: ConnectConfig
    local: string
    remote: string
    sftpOptions: SftpOption
    /** provision 声明式 stack（无则为空对象）。 */
    stack: StackSpec
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
    /** 启用 backup 且远程目标原先存在时的快照路径；否则 null。 */
    backup: string | null
    /** 是否因传输失败而回滚到快照。 */
    rolledBack: boolean
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

/** 仅保留 `keepPath` 这一最新快照，删除 `remote` 同级的其它 `${base}.wink-bak.*`，避免无限累积。清理失败不影响部署。 */
const pruneOldBackups = async (
    session: SshSession,
    sftp: SFTPWrapper,
    remote: string,
    keepPath: string,
    logger: Logger
): Promise<void> => {
    const parent = path.posix.dirname(remote)
    const prefix = `${path.posix.basename(remote)}.wink-bak.`
    const keepName = path.posix.basename(keepPath)
    try {
        const stale = (await readdir(sftp, parent)).filter((e) => e.name.startsWith(prefix) && e.name !== keepName)
        for (const e of stale) {
            // 顺序删除：旧备份通常很少；避免一次性打满 SSH 会话
            // eslint-disable-next-line no-await-in-loop
            await session.exec(`rm -rf ${shellQuote(linuxPath(parent, e.name))}`)
            logger.debug('已清理旧备份：' + e.name)
        }
    } catch (e) {
        logger.debug('清理旧备份失败（忽略）：' + (e instanceof Error ? e.message : String(e)))
    }
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
        backup: null,
        rolledBack: false,
    }
}

/**
 * 实跑部署：建目录、传文件、跑前后命令，返回结构化结果。
 *
 * 备份/回滚复用 {@link guard} 的底层原语（`backupRemote`/`restoreRemote`），但**不走 `guard()` 编排**：
 * 部署是「收集每文件成败、有失败才回滚」的部分失败模型，而 `guard()` 是「应用抛错即原子回滚」的模型，
 * 二者语义不同；硬套 `guard()` 会丢掉结构化的 `failed[]` 明细。故此处共享原语、自管编排。
 */
const deploy = async (session: SshSession, config: ResolvedConfig, logger: Logger): Promise<DeployResult> => {
    const sftp = await session.sftp()
    const opts = config.sftpOptions
    const commands: string[] = []
    const mode = opts.mode ?? DEFAULT_MODE
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    const retries = opts.retries ?? DEFAULT_RETRIES

    // 前置命令在扫描前执行，使其产物（如构建输出）能被纳入本次传输列表
    if (opts.beforeRunCommand) {
        logger.debug('执行前置命令：' + opts.beforeRunCommand)
        await session.exec(opts.beforeRunCommand)
        commands.push(opts.beforeRunCommand)
    }

    const { local, remote, isDir, remoteDirs, targets, warnings } = computePlan(config)
    logger.debug('待传输文件数：' + targets.length)
    warnings.forEach((w) => logger.warn('⚠ ' + w))

    // 文件级备份：在任何变更（clear / 传输）之前对已存在的远程目标快照，供失败回滚。
    // 备份本身失败时**清晰中止**（此时尚未改动远程），而非冒出底层 RemoteCommandError。
    let backup: string | null = null
    if (opts.backup) {
        try {
            backup = await backupRemote(session, remote)
        } catch (e) {
            throw new TransferError(`部署前备份失败，已中止（远程未改动）：${remote}`, { cause: e })
        }
        if (backup) logger.debug('已备份远程目标：' + backup)
    }

    if (isDir && opts.clear) {
        assertSafeClearTarget(remote)
        const cmd = `rm -rf ${shellQuote(remote)}/*`
        await session.exec(cmd)
        commands.push(cmd)
        logger.debug('已清空远程文件夹：' + remote)
    }

    // 受限并发建目录，避免一次性打满 SSH MaxSessions
    await mapPool(remoteDirs, concurrency, async (dir) => {
        await session.exec(`mkdir -p ${shellQuote(dir)}`)
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

    // 传输失败且有备份：回滚到快照（文件级），让远程目标恢复到部署前状态。
    // 回滚在后置命令之前——失败时不应再执行 afterRunCommand（如重启已被回滚的服务）。
    // 回滚本身失败时**不外抛**：计入 warnings、保留原始 failed[] 与退出码（传输失败 5），
    // 避免把「部分文件失败」掩盖成「远程命令失败」并丢掉明细。
    let rolledBack = false
    if (failed.length > 0 && backup) {
        logger.warn(`⚠ 传输失败，回滚到备份：${remote}`)
        try {
            await restoreRemote(session, remote, backup)
            rolledBack = true
        } catch (e) {
            warnings.push(
                `回滚失败，远程可能处于不一致状态（备份保留于 ${backup}）：${e instanceof Error ? e.message : String(e)}`
            )
            logger.warn('⚠ ' + warnings[warnings.length - 1])
        }
    } else if (backup && !rolledBack) {
        // 成功（无失败）：仅保留最新快照，清理更旧的，避免无限累积占满磁盘
        await pruneOldBackups(session, sftp, remote, backup, logger)
    }

    // 回滚后不再执行后置命令（避免对已回滚的目标做 reload/重启）；未回滚则维持原行为
    if (!rolledBack && opts.afterRunCommand) {
        logger.debug('执行后置命令：' + opts.afterRunCommand)
        await session.exec(opts.afterRunCommand)
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
        backup: rolledBack ? null : backup,
        rolledBack,
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
        const result = await withSession(config.connect, logger, (session) => deploy(session, config, logger))
        recordAudit(config, logger, 'deploy', result.ok, {
            remote: config.remote,
            transferred: result.transferred.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
            commands: result.commands,
        })
        return result
    } catch (e) {
        recordAudit(config, logger, 'deploy', false, {
            remote: config.remote,
            error: e instanceof Error ? e.message : String(e),
        })
        throw e
    }
}

/** 单台主机的部署结果（连接/配置错误捕获为 `error`，不抛）。 */
export interface HostDeployResult {
    /** 主机地址。 */
    host: string
    /** 该主机是否成功（连接、配置、全部文件传输均成功）。 */
    ok: boolean
    /** 成功或部分失败时的部署结果。 */
    result?: DeployResult
    /** 连接/配置等致命错误（kind 来自类型化错误）。 */
    error?: { kind: string; message: string }
}

/** 多机部署聚合结果。 */
export interface MultiDeployResult {
    /** 是否所有主机都成功。 */
    ok: boolean
    /** 各主机结果（continue 模式含全部；fail-fast 模式止于首个失败主机）。 */
    hosts: HostDeployResult[]
}

/**
 * 对单台主机执行一次部署，把连接/配置等致命错误捕获为结构化结果（不抛），便于聚合。
 * `merged` 为已合并好的配置（含文件 + 环境）；用 `config:false` 让每台**不再重复解析配置文件**。
 */
const deployHost = async (
    merged: RunOption,
    options: RunOption | undefined,
    hc: ConnectConfig
): Promise<HostDeployResult> => {
    const host = hc.host ?? merged.connect?.host ?? '?'
    const perHost: RunOption = {
        ...merged, // 文件+环境合并后的全部字段（含 audit/debug 等文件级调用开关）
        config: false, // merged 已含文件/环境值，避免每台主机重复读取与解析配置文件
        env: undefined,
        environments: undefined,
        hosts: undefined,
        connect: { ...merged.connect, ...hc },
        // CLI/编程式调用级开关优先于文件值
        debug: options?.debug ?? merged.debug,
        json: options?.json ?? merged.json,
        dryRun: options?.dryRun ?? merged.dryRun,
        audit: options?.audit ?? merged.audit,
        auditLog: options?.auditLog ?? merged.auditLog,
    }
    try {
        const result = await run(perHost)
        return { host, ok: result.ok, result }
    } catch (e) {
        const kind = e instanceof WinkOpsError ? e.kind : 'error'
        return { host, ok: false, error: { kind, message: e instanceof Error ? e.message : String(e) } }
    }
}

/** 在已合并配置上执行多机编排（{@link runMany} 与 {@link runAuto} 共用，避免重复解析配置文件）。 */
const runManyMerged = async (merged: RunOption, options?: RunOption): Promise<MultiDeployResult> => {
    const hosts = merged.hosts ?? []
    if (!hosts.length) throw new ConfigError('多机部署需要至少一台主机（hosts 为空）')
    const failFast = merged.failFast ?? false
    const hostConcurrency = merged.hostConcurrency ?? DEFAULT_CONCURRENCY
    const results: HostDeployResult[] = []
    if (failFast) {
        for (const hc of hosts) {
            // 顺序执行以实现「首台失败即停」
            // eslint-disable-next-line no-await-in-loop
            const r = await deployHost(merged, options, hc)
            results.push(r)
            if (!r.ok) break
        }
    } else {
        results.push(...(await mapPool(hosts, hostConcurrency, (hc) => deployHost(merged, options, hc))))
    }
    return { ok: results.length === hosts.length && results.every((r) => r.ok), hosts: results }
}

/**
 * 多机并行部署：对每台 `hosts`（来自文件 / 环境 / 显式参数，经 {@link mergeConfig} 合并）执行部署并聚合。
 * 每台一个独立会话（连接互不影响）。
 *
 * 失败策略：默认 **continue**（受限并发跑完所有主机再汇总）；`failFast=true` 时**顺序**执行、
 * 首台失败即停并跳过其余。`failFast`/`hostConcurrency` 同样支持在配置文件/环境中设置。
 * 连接/配置错误被收进对应主机的 `error`，不影响其它主机。
 */
export const runMany = (options?: RunOption): Promise<MultiDeployResult> => runManyMerged(mergeConfig(options), options)

/** 自动分派：合并后存在 `hosts` 走多机编排，否则走单机 {@link run}。CLI 部署入口（只解析一次配置）。 */
export const runAuto = (options?: RunOption): Promise<DeployResult | MultiDeployResult> => {
    const merged = mergeConfig(options)
    return merged.hosts?.length ? runManyMerged(merged, options) : run(options)
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
                    // 用 sort 而非 toSorted：后者是 Node 20+，本包 engines 下限为 18；此数组是 map 新建的，排序不影响外部
                    // eslint-disable-next-line unicorn/no-array-sort
                    .sort((a, b) => a.name.localeCompare(b.name))
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
    return withSession(config.connect, logger, async (session) => {
        const sftp = await session.sftp()
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
    return withSession(config.connect, logger, async (session) => {
        const sftp = await session.sftp()
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

/** `rollback` 结果。 */
export interface RollbackResult {
    /** 是否成功恢复（找到并还原了备份）。 */
    ok: boolean
    /** 被恢复的远程目标。 */
    remote: string
    /** 用于恢复的备份路径（未找到任何备份则 null）。 */
    backup: string | null
}

/**
 * 手动回滚：把 `remote` 恢复到**最近一次** `--sftp-backup` 生成的快照（`${remote}.wink-bak.<ts>`）。
 * 在 `remote` 的父目录中按名查找快照、取时间戳最大者还原。无快照时 `ok=false`。
 * 仅文件级——不撤销部署钩子的副作用（服务重启、数据库变更等）。
 */
export const rollback = async (options?: RunOption): Promise<RollbackResult> => {
    const config = resolveConfig(options, { requireLocal: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    const remote = config.remote
    const parent = path.posix.dirname(remote)
    const prefix = `${path.posix.basename(remote)}.wink-bak.`
    return withSession(config.connect, logger, async (session) => {
        const sftp = await session.sftp()
        const backups = (await readdir(sftp, parent))
            .map((e) => e.name)
            .filter((name) => name.startsWith(prefix))
            // 按时间戳后缀**数值**降序取最新（避免字符串比较在位数不同的时间戳上排错）；
            // 用 sort 而非 toSorted（后者 Node 20+，engines 下限为 18）；此数组是 map/filter 新建的
            // eslint-disable-next-line unicorn/no-array-sort
            .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
        if (!backups.length) {
            logger.warn('⚠ 未找到可回滚的备份：' + remote)
            return { ok: false, remote, backup: null }
        }
        const backup = linuxPath(parent, backups[0])
        await restoreRemote(session, remote, backup)
        logger.debug('已回滚到备份：' + backup)
        return { ok: true, remote, backup }
    })
}
