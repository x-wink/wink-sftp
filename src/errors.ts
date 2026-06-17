/**
 * 类型化错误：核心层抛出，由 CLI 层据 `exitCode` 决定进程退出码。
 *
 * 退出码约定（便于脚本与 agent 分支）：
 * - 1 通用错误
 * - 2 配置错误
 * - 3 连接失败
 * - 4 远程命令失败
 * - 5 文件传输失败
 */
export abstract class WinkSftpError extends Error {
    /** 进程退出码。 */
    abstract readonly exitCode: number
    /** 机器可读的错误种类。 */
    abstract readonly kind: string
    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = new.target.name
        if (options?.cause !== undefined) {
            ;(this as { cause?: unknown }).cause = options.cause
        }
    }
}

/** 配置缺失或非法。 */
export class ConfigError extends WinkSftpError {
    readonly exitCode = 2
    readonly kind = 'config'
}

/** SSH 连接失败 / 超时。 */
export class ConnectionError extends WinkSftpError {
    readonly exitCode = 3
    readonly kind = 'connection'
}

/** 远程命令执行失败（退出码非零或无法启动）。 */
export class RemoteCommandError extends WinkSftpError {
    readonly exitCode = 4
    readonly kind = 'remote-command'
    readonly command: string
    readonly result?: { stdout: string; stderr: string; code: number }
    constructor(
        message: string,
        options: {
            command: string
            result?: { stdout: string; stderr: string; code: number }
            cause?: unknown
        }
    ) {
        super(message, options)
        this.command = options.command
        this.result = options.result
    }
}

/** 文件传输失败。 */
export class TransferError extends WinkSftpError {
    readonly exitCode = 5
    readonly kind = 'transfer'
}

/** 从任意抛出值推导退出码：识别类型化错误，否则按通用错误返回 1。 */
export const exitCodeOf = (e: unknown): number => (e instanceof WinkSftpError ? e.exitCode : 1)
