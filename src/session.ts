import { Client } from 'ssh2'
import type { ConnectConfig, SFTPWrapper } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { execCommand } from './exec'
import type { ExecResult } from './exec'
import { ConnectionError, RemoteCommandError } from './errors'
import type { Logger } from './logger'

/** 流式执行的回调：分别接收 stdout / stderr 的原始数据块（未按行切分）。 */
export interface StreamHandlers {
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
}

/** {@link SshSession.stream} 的句柄：等待结束 / 主动关闭。 */
export interface StreamHandle {
    /** 远程命令结束（exit）时 resolve 退出码与信号。 */
    done: Promise<{ code: number; signal?: string }>
    /** 主动终止流（关闭通道）；长流（如 `tail -f`）由调用方据此停止。 */
    close(): void
}

/**
 * 通用 SSH 会话抽象：包一个独立的 `ssh2.Client`，统一管理连接生命周期，
 * 暴露 `exec`（结构化远程执行）与 `sftp`（按需开启并缓存的 SFTP 通道）。
 *
 * 这是部署 / 下载 / 浏览 / guard 守护式变更等所有远程能力的共同底座，也是对外
 * **稳定的编程式 API**：调用方可 `new SshSession(connect).open()` 后自由组合 `exec`/`sftp`，
 * 用完 `close()`。多机与并发由「每会话独立 Client」天然支持（非单例）。
 */
export class SshSession {
    private client: Client | null = null
    private sftpWrapper: SFTPWrapper | null = null

    constructor(
        private readonly connectConfig: ConnectConfig,
        private readonly logger?: Logger
    ) {}

    /**
     * 建立连接：`ready` 后 resolve；`error` / `timeout` reject 类型化 {@link ConnectionError}。
     * 只 settle 一次——连接期后续事件不再翻转结果（运行期错误经 {@link exec} / {@link sftp} 自行暴露）。
     */
    open(): Promise<void> {
        return new Promise((resolve, reject) => {
            const client = new Client()
            let settled = false
            const settle = (fn: () => void): void => {
                if (!settled) {
                    settled = true
                    fn()
                }
            }
            client
                .on('ready', () =>
                    settle(() => {
                        this.client = client
                        this.logger?.debug('连接成功')
                        resolve()
                    })
                )
                .on('error', (err) => settle(() => reject(new ConnectionError('SSH 连接失败', { cause: err }))))
                .on('timeout', () => settle(() => reject(new ConnectionError('SSH 会话超时'))))
                .connect(this.connectConfig)
        })
    }

    /** 在会话上执行远程命令，返回结构化结果（退出码非零 reject {@link RemoteCommandError}）。未连接 reject。 */
    exec(command: string): Promise<ExecResult> {
        if (!this.client) return Promise.reject(new ConnectionError('SSH 会话未建立（请先 open）'))
        return execCommand(this.client, command)
    }

    /** 开启（并缓存）SFTP 通道；同一会话多次调用复用同一通道。未连接 / 开启失败 reject {@link ConnectionError}。 */
    sftp(): Promise<SFTPWrapper> {
        if (this.sftpWrapper) return Promise.resolve(this.sftpWrapper)
        const client = this.client
        if (!client) return Promise.reject(new ConnectionError('SSH 会话未建立（请先 open）'))
        return new Promise((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) reject(new ConnectionError('SFTP 开启失败', { cause: err }))
                else {
                    this.sftpWrapper = sftp
                    resolve(sftp)
                }
            })
        })
    }

    /**
     * 流式执行远程命令：实时把 stdout/stderr 数据块交给回调，返回 {@link StreamHandle}
     * （`done` 在 exit 时 resolve 退出码/信号，`close()` 主动关闭通道）。适合 `tail -f`、`top`
     * 等长流——不靠收集全部输出与退出码判定结束。未连接 / 无法启动 reject 类型化错误。
     */
    stream(command: string, handlers: StreamHandlers = {}): Promise<StreamHandle> {
        const client = this.client
        if (!client) return Promise.reject(new ConnectionError('SSH 会话未建立（请先 open）'))
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    reject(new RemoteCommandError(`远程命令无法启动：${command}`, { command, cause: err }))
                    return
                }
                // done 必定 settle：正常以 exit 的退出码为准；连接骤断只来 close/error 时兜底为 -1，
                // 避免 `await handle.done` 永久挂起（致 withSession 不断开、CLI 卡死）。同时挂 error
                // 监听吞掉通道异常——否则 EventEmitter 无 error 监听会抛成 uncaughtException 崩溃进程。
                const done = new Promise<{ code: number; signal?: string }>((res) => {
                    let exited = false
                    stream.on('exit', (code: number | null, signal?: string) => {
                        exited = true
                        res({ code: code ?? -1, signal })
                    })
                    stream.on('close', () => {
                        if (!exited) res({ code: -1 })
                    })
                    stream.on('error', () => {
                        if (!exited) res({ code: -1 })
                    })
                })
                // StringDecoder 跨数据块维护多字节 UTF-8 边界：避免中文/emoji 被网络分片切碎成乱码
                const outDec = new StringDecoder('utf8')
                const errDec = new StringDecoder('utf8')
                stream.on('data', (buf: Buffer) => handlers.onStdout?.(outDec.write(buf)))
                stream.stderr.on('data', (buf: Buffer) => handlers.onStderr?.(errDec.write(buf)))
                resolve({
                    done,
                    // 终止远程命令：尽力发信号 + 销毁本地通道（信号支持因服务端而异，连接关闭亦会终止远程）
                    close: () => {
                        try {
                            stream.signal?.('TERM')
                        } catch {
                            // 信号不支持则忽略，靠 destroy / 连接关闭兜底
                        }
                        stream.destroy?.()
                    },
                })
            })
        })
    }

    /** 底层 `ssh2.Client`（未连接为 null）；供需要直接操作 Client 的高级场景。 */
    get raw(): Client | null {
        return this.client
    }

    /** 断开连接并清空缓存的 SFTP 通道。可重复调用。 */
    close(): void {
        this.client?.end()
        this.client = null
        this.sftpWrapper = null
    }
}

/**
 * 建立会话、运行 `fn`、保证最终断开（无论成败）。连接失败 / 超时 reject 类型化 {@link ConnectionError}。
 * 部署 / 下载 / 浏览共用；也是编程式 API 的便捷入口。
 */
export const withSession = async <T>(
    connect: ConnectConfig,
    logger: Logger,
    fn: (session: SshSession) => Promise<T>
): Promise<T> => {
    const session = new SshSession(connect, logger)
    await session.open()
    try {
        return await fn(session)
    } finally {
        session.close()
    }
}
