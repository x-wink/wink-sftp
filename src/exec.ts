import type { Client } from 'ssh2'
import { RemoteCommandError } from './errors'

/**
 * 把任意字符串安全地转义为单个 POSIX shell 参数。
 *
 * 用单引号包裹，并把内部的单引号替换为 `'\''`（闭合 → 转义单引号 → 重新打开）。
 * 这是所有拼入远程 shell 的路径/文件名的唯一出口，杜绝命令注入。
 */
export const shellQuote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`

/** `execCommand` 的结构化结果：区分标准输出、错误输出与退出码。 */
export interface ExecResult {
    /** 远程命令本身（已转义后的完整字符串）。 */
    command: string
    /** 标准输出，已拼接为完整字符串。 */
    stdout: string
    /** 错误输出，已拼接为完整字符串（非空不代表失败，以退出码为准）。 */
    stderr: string
    /** 退出码，0 表示成功。 */
    code: number
    /** 终止信号（若有）。 */
    signal?: string
}

/**
 * 在已连接的 ssh2 Client 上执行远程命令，返回结构化结果。
 *
 * 与旧实现的关键差异：**stderr 有内容不再判为失败**，仅以退出码为准
 * （许多正常命令会向 stderr 写告警）。失败时抛 {@link RemoteCommandError}，
 * 携带 stdout/stderr/code 以便上层渲染与定退出码。
 */
export const execCommand = (client: Client, command: string): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
            if (err) {
                reject(new RemoteCommandError(`远程命令无法启动：${command}`, { command, cause: err }))
                return
            }
            const out: string[] = []
            const errOut: string[] = []
            stream
                .on('exit', (code: number | null, signal?: string) => {
                    const result: ExecResult = {
                        command,
                        stdout: out.join(''),
                        stderr: errOut.join(''),
                        code: code ?? -1,
                        signal,
                    }
                    if (result.code === 0) {
                        resolve(result)
                    } else {
                        reject(
                            new RemoteCommandError(`远程命令退出码非零（${result.code}）：${command}`, {
                                command,
                                result,
                            })
                        )
                    }
                })
                .on('data', (buffer: Buffer) => out.push(String(buffer)))
                .stderr.on('data', (buffer: Buffer) => errOut.push(String(buffer)))
        })
    })
