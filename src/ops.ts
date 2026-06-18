import { withSession } from './session'
import type { SshSession, StreamHandlers } from './session'
import { resolveConfig } from './config'
import { Logger } from './logger'
import { recordAudit } from './audit'
import { shellQuote } from './exec'
import { ConfigError, RemoteCommandError } from './errors'
import type { RunOption } from './core'

/**
 * 在会话上执行命令，把**退出码非零也作为结构化结果返回（不抛）**——运维/诊断原语共用底座：
 * 「命令失败」本身就是要呈现给调用方的事实。仅连接失败 / 命令无法启动（{@link RemoteCommandError}
 * 不带 `result`）等真正异常才 reject。`runExec`/`ps`/`service` 均以此统一处理退出码语义。
 */
export const execStructured = async (
    session: SshSession,
    command: string
): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
        const r = await session.exec(command)
        return { stdout: r.stdout, stderr: r.stderr, code: r.code }
    } catch (e) {
        if (e instanceof RemoteCommandError && e.result) return e.result
        throw e // 无法启动（如命令不存在于 shell 之外）等仍按异常上抛
    }
}

/** `exec` 远程执行结果：退出码非零也作为结构化结果返回（不抛），便于 agent 诊断。 */
export interface ExecRunResult {
    /** 退出码是否为 0。 */
    ok: boolean
    /** 执行的远程命令。 */
    command: string
    /** 标准输出。 */
    stdout: string
    /** 错误输出（非空不代表失败，以 code 为准）。 */
    stderr: string
    /** 退出码。 */
    code: number
}

/**
 * 远程执行命令并收集结构化结果（只读/读写原语）。需要 connect，不需要 local/remote。
 *
 * 与 `execCommand` 不同：退出码非零**不抛**，而是作为 `ok=false` 的结果返回——`exec` 作为
 * 诊断原语，「命令失败」本身就是要呈现给调用方的事实。仅连接失败 / 命令无法启动时才 reject。
 */
export const runExec = async (command: string, options?: RunOption): Promise<ExecRunResult> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    return withSession(config.connect, logger, async (session) => {
        const r = await execStructured(session, command)
        return { ok: r.code === 0, command, stdout: r.stdout, stderr: r.stderr, code: r.code }
    })
}

/** 单块磁盘用量（`df -Pk` 一行）。 */
export interface DiskUsage {
    filesystem: string
    sizeKb: number
    usedKb: number
    availKb: number
    usePercent: number
    mountedOn: string
}

/** 资源/健康快照（agentless，best-effort：采集不到的字段为 null，`ok` 仍为 true）。 */
export interface StatusResult {
    ok: boolean
    /** 主机名。 */
    host: string | null
    /** 平均负载 [1, 5, 15] 分钟。 */
    load: [number, number, number] | null
    /** CPU 逻辑核数。 */
    cpuCores: number | null
    /** 内存（KB）：总/已用/可用。 */
    memory: { totalKb: number; usedKb: number; availableKb: number } | null
    /** 各挂载点磁盘用量。 */
    disks: DiskUsage[]
}

/** 各采集片段之间的分隔标记（不会出现在正常输出里）。 */
const SEP = '@@wink@@'

/** 解析 `/proc/loadavg` 前三个数为 [1,5,15] 负载；失败返回 null。 */
export const parseLoadavg = (text: string): [number, number, number] | null => {
    const parts = text.trim().split(/\s+/)
    const nums = parts.slice(0, 3).map(Number)
    return nums.length === 3 && nums.every((n) => !Number.isNaN(n)) ? [nums[0], nums[1], nums[2]] : null
}

/**
 * 解析 `/proc/meminfo`：取 MemTotal 与 MemAvailable（KB），已用 = 总 - 可用。
 * 老内核（< 3.14）/部分容器无 MemAvailable 时回退到 MemFree（偏保守，已用会略高估）；
 * 连 MemTotal 都缺才返回 null。
 */
export const parseMeminfo = (text: string): StatusResult['memory'] => {
    const get = (key: string): number | null => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
        return m ? Number(m[1]) : null
    }
    const totalKb = get('MemTotal')
    const availableKb = get('MemAvailable') ?? get('MemFree')
    if (totalKb === null || availableKb === null) return null
    return { totalKb, usedKb: totalKb - availableKb, availableKb }
}

/** 解析 `df -Pk` 输出（POSIX 格式，KB 块）为各挂载点用量；跳过表头与无法解析行。 */
export const parseDf = (text: string): DiskUsage[] => {
    const out: DiskUsage[] = []
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
        // filesystem size used avail capacity% mounted-on（mounted-on 可能含空格，取末段为挂载点）
        const m = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/)
        if (!m) continue
        out.push({
            filesystem: m[1].trim(),
            sizeKb: Number(m[2]),
            usedKb: Number(m[3]),
            availKb: Number(m[4]),
            usePercent: Number(m[5]),
            mountedOn: m[6].trim(),
        })
    }
    return out
}

/**
 * 主机资源/健康快照：一次远程执行采集 hostname / loadavg / nproc / meminfo / df，再纯函数解析归一化。
 * **best-effort**：任一片段采集/解析失败仅置为 null（或空盘列表），整体 `ok` 仍为 true——快照不因
 * 单项缺失而失败，跨发行版差异由解析层吸收。需要 connect，不需要 local/remote。
 */
export const status = async (options?: RunOption): Promise<StatusResult> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    // 各段以 SEP 分隔；每段失败用 `|| true` 兜底为空，保证整条命令退出码 0、缺失段为空字符串
    const probe = [
        `hostname || true`,
        `cat /proc/loadavg || true`,
        `nproc || true`,
        `cat /proc/meminfo || true`,
        `df -Pk || true`,
    ].join(`; echo '${SEP}'; `)
    return withSession(config.connect, logger, async (session) => {
        const r = await session.exec(probe)
        const [host = '', load = '', cores = '', mem = '', df = ''] = r.stdout.split(SEP)
        return {
            ok: true,
            host: host.trim() || null,
            load: parseLoadavg(load),
            cpuCores: Number.isNaN(Number(cores.trim())) || !cores.trim() ? null : Number(cores.trim()),
            memory: parseMeminfo(mem),
            disks: parseDf(df),
        }
    })
}

/** `logs` 结果。 */
export interface LogsResult {
    ok: boolean
    /** 查看的远程文件路径。 */
    path: string
    /** 命中的日志行（已按 grep 过滤、取末 N 行）。 */
    lines: string[]
}

/**
 * 查看远程日志：`tail -n <lines>`，可选 `grep <pattern>` 过滤（路径与模式均经 {@link shellQuote} 防注入）。
 * 一次性读取（流式 `--follow` 暂未做，按需再加）。需要 connect，不需要 local。
 */
export const tailLogs = async (
    remotePath: string,
    options?: RunOption,
    { lines = 200, grep }: { lines?: number; grep?: string } = {}
): Promise<LogsResult> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    // 非有限/非正数（如 -n 传了非数字 → NaN）回退到默认 200，而非静默变成 1 行
    const n = Number.isFinite(lines) && lines >= 1 ? Math.floor(lines) : 200
    const target = shellQuote(remotePath)
    // 先 `test -f` 守门：文件缺失则整条命令非零退出 → 统一报错（与 grep/非 grep 两路行为一致，
    // 也与 `ls` 对不存在目标报错的语义对齐）；存在但 grep 无命中时管道退出码取 tail（0），正常返回空。
    const cmd = grep
        ? `test -f ${target} && grep -- ${shellQuote(grep)} ${target} | tail -n ${n}`
        : `test -f ${target} && tail -n ${n} ${target}`
    return withSession(config.connect, logger, async (session) => {
        const r = await session.exec(cmd)
        // 按 \r?\n 切分（兼容 CRLF），并丢弃末尾换行产生的空串
        const out = r.stdout.split(/\r?\n/)
        if (out.length && out[out.length - 1] === '') out.pop()
        return { ok: true, path: remotePath, lines: out }
    })
}

/** `logs --follow` / `exec --stream` 等流式命令结束时的结果。 */
export interface StreamResult {
    /** 退出码是否为 0。 */
    ok: boolean
    /** 退出码（被信号终止时通常为 -1）。 */
    code: number
}

/**
 * 流式跟踪远程日志（`tail -n <lines> -f`，可选 `grep --line-buffered` 过滤）：每完整一行回调
 * `onLine`，直到流结束（文件被删 / 连接关闭 / 调用方终止进程）。路径与模式经 {@link shellQuote} 防注入。
 * 与 {@link tailLogs} 不同——不收集全部输出，适合持续跟随。需要 connect，不需要 local/remote。
 */
export const followLogs = async (
    remotePath: string,
    options: RunOption | undefined,
    { lines = 200, grep, onLine }: { lines?: number; grep?: string; onLine: (line: string) => void }
): Promise<StreamResult & { path: string }> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    const n = Number.isFinite(lines) && lines >= 1 ? Math.floor(lines) : 200
    const target = shellQuote(remotePath)
    // tail -f 持续输出；grep 用 --line-buffered 保证实时（否则管道按块缓冲、看不到新行）
    const cmd = grep
        ? `tail -n ${n} -f ${target} | grep --line-buffered -- ${shellQuote(grep)}`
        : `tail -n ${n} -f ${target}`
    return withSession(config.connect, logger, async (session) => {
        let buf = ''
        // 行缓冲：流式数据块未必对齐换行，攒够一整行才回调
        const emit = (chunk: string): void => {
            buf += chunk
            let idx: number
            while ((idx = buf.indexOf('\n')) >= 0) {
                onLine(buf.slice(0, idx).replace(/\r$/, ''))
                buf = buf.slice(idx + 1)
            }
        }
        const handle = await session.stream(cmd, { onStdout: emit })
        const { code } = await handle.done
        if (buf.length) onLine(buf.replace(/\r$/, '')) // 冲刷无尾换行的残留
        return { ok: code === 0, code, path: remotePath }
    })
}

/**
 * 流式远程执行：实时把 stdout/stderr 数据块交给回调，结束返回退出码。
 * 与 {@link runExec}（收集后一次性返回）不同，适合长流 / 大输出。需要 connect，不需要 local/remote。
 */
export const streamExec = async (
    command: string,
    options?: RunOption,
    handlers: StreamHandlers = {}
): Promise<StreamResult & { command: string }> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    return withSession(config.connect, logger, async (session) => {
        const handle = await session.stream(command, handlers)
        const { code } = await handle.done
        return { ok: code === 0, code, command }
    })
}

/** 单个进程信息（`ps` 一行解析）。 */
export interface ProcessInfo {
    /** 进程号。 */
    pid: number
    /** 父进程号。 */
    ppid: number
    /** 属主用户名。 */
    user: string
    /** CPU 占用百分比。 */
    cpu: number
    /** 内存占用百分比。 */
    mem: number
    /** 常驻内存（KB）。 */
    rssKb: number
    /** 完整命令行。 */
    command: string
}

/** `ps` 结果。 */
export interface PsResult {
    ok: boolean
    /** 进程列表（已按可选 grep 过滤）。 */
    processes: ProcessInfo[]
}

/**
 * 解析 `ps -A -o pid,ppid,user,pcpu,pmem,rss,args` 输出：跳过表头、丢弃无法解析行。
 * 末列 `args` 为完整命令行（可含空格），用贪婪 `(.+)` 吃掉行尾。
 */
export const parsePs = (text: string): ProcessInfo[] => {
    const out: ProcessInfo[] = []
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        out.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            user: m[3],
            cpu: Number(m[4]),
            mem: Number(m[5]),
            rssKb: Number(m[6]),
            command: m[7].trim(),
        })
    }
    return out
}

/**
 * 远程进程快照：一次 `ps` 采集所有进程并结构化，可选 `grep` 按命令行子串过滤。
 * 过滤在**客户端**做（而非远程 `| grep`）——避免 grep 进程自身入列与 shell 转义复杂度。
 * 需要 connect，不需要 local/remote。
 */
export const ps = async (options?: RunOption, { grep }: { grep?: string } = {}): Promise<PsResult> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    // `-A -o` 在 GNU(Linux) 与 BSD(macOS) ps 上语义一致（裸 `-e` 在 macOS 含义不同，不可用）；
    // `LC_ALL=C` 固定 C 区域设置，强制 %CPU/%MEM 用点号小数——否则 de_DE 等区域输出逗号小数会
    // 让 parsePs 的 `[\d.]+` 列整行不匹配、静默丢光所有进程。
    return withSession(config.connect, logger, async (session) => {
        const r = await execStructured(session, 'LC_ALL=C ps -A -o pid,ppid,user,pcpu,pmem,rss,args')
        const all = parsePs(r.stdout)
        return { ok: r.code === 0, processes: grep ? all.filter((p) => p.command.includes(grep)) : all }
    })
}

/** 支持的服务管理器。 */
export type ServiceManager = 'systemd' | 'pm2' | 'docker'
/** 服务动作：`status` 只读，其余为写操作（需 `--yes`）。 */
export type ServiceAction = 'status' | 'start' | 'stop' | 'restart' | 'reload'

/** 受支持的服务管理器枚举（CLI 校验用）。 */
export const SERVICE_MANAGERS: ServiceManager[] = ['systemd', 'pm2', 'docker']
/** 受支持的服务动作枚举（CLI 校验用）。 */
export const SERVICE_ACTIONS: ServiceAction[] = ['status', 'start', 'stop', 'restart', 'reload']
/** 写操作动作集合（需确认 + 审计）。 */
const WRITE_ACTIONS: Set<ServiceAction> = new Set(['start', 'stop', 'restart', 'reload'])

/** 该动作是否为写操作（`status` 之外皆为写）。 */
export const isWriteAction = (action: ServiceAction): boolean => WRITE_ACTIONS.has(action)

/** `service` 结果。 */
export interface ServiceResult {
    /** 退出码是否为 0。 */
    ok: boolean
    /** 服务/容器名。 */
    service: string
    /** 执行的动作。 */
    action: ServiceAction
    /** 使用的服务管理器。 */
    manager: ServiceManager
    /** 实际执行的远程命令。 */
    command: string
    stdout: string
    stderr: string
    code: number
}

/**
 * 构造服务管理命令（纯函数，便于单测）。服务名经 {@link shellQuote} 防注入。
 * - systemd：`systemctl <action> <name>`（status 用 `systemctl status --no-pager`）
 * - pm2：`pm2 <action> <name>`（status 用 `pm2 describe`）
 * - docker：start/stop/restart 直接映射，status 用 `docker ps --filter name=`；**不支持 reload**
 */
export const buildServiceCommand = (manager: ServiceManager, action: ServiceAction, name: string): string => {
    const n = shellQuote(name)
    switch (manager) {
        case 'systemd':
            return action === 'status' ? `systemctl status --no-pager ${n}` : `systemctl ${action} ${n}`
        case 'pm2':
            return action === 'status' ? `pm2 describe ${n}` : `pm2 ${action} ${n}`
        case 'docker':
            if (action === 'status') return `docker ps --filter name=${n}`
            if (action === 'reload') throw new ConfigError('docker 不支持 reload 动作（用 restart）')
            return `docker ${action} ${n}`
        default:
            // 类型上不可达（manager 为 ServiceManager 联合）；防御 lib 调用方强转非法字符串
            throw new ConfigError(`未知服务管理器：${String(manager)}`)
    }
}

/**
 * 服务/进程管理：对远程服务执行 status/start/stop/restart/reload。
 *
 * **读写分离**：`status` 只读、默认放行；写动作（start/stop/restart/reload）须 `yes=true`
 * （CLI `--yes`）确认，否则抛 {@link ConfigError}；写动作成功与否都记一条本地审计。
 * 命令退出码非零**不抛**，作为 `ok=false` 的结构化结果返回（便于 agent 诊断）。
 * 需要 connect，不需要 local/remote。
 */
export const service = async (
    name: string,
    action: ServiceAction,
    options?: RunOption,
    { manager = 'systemd', yes = false }: { manager?: ServiceManager; yes?: boolean } = {}
): Promise<ServiceResult> => {
    // 校验收口在核心层（护栏进 core）：CLI 与 lib 编程式调用方都受益，不在 CLI 层重复
    if (!SERVICE_ACTIONS.includes(action)) {
        throw new ConfigError(`未知服务动作：${action}（支持 ${SERVICE_ACTIONS.join('/')}）`)
    }
    if (!SERVICE_MANAGERS.includes(manager)) {
        throw new ConfigError(`未知服务管理器：${manager}（支持 ${SERVICE_MANAGERS.join('/')}）`)
    }
    const write = isWriteAction(action)
    if (write && !yes) {
        throw new ConfigError(`服务写操作 ${action} 需 --yes 确认（只读 status 无需）`)
    }
    // 命令构造可能抛（如 docker reload）——置于连接之前，避免无谓建连
    const command = buildServiceCommand(manager, action, name)
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    return withSession(config.connect, logger, async (session) => {
        const r = await execStructured(session, command)
        const ok = r.code === 0
        if (write) recordAudit(config, logger, `service:${action}`, ok, { service: name, manager, command })
        return { ok, service: name, action, manager, command, stdout: r.stdout, stderr: r.stderr, code: r.code }
    })
}
