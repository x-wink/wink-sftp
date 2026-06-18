import { Client } from 'ssh2'
import type { ConnectConfig, SFTPWrapper } from 'ssh2'
import { execCommand } from './exec'
import type { ExecResult } from './exec'
import { ConnectionError } from './errors'
import type { Logger } from './logger'

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
