import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 一条审计记录：何时 / 哪台 / 什么动作 / 结果。 */
export interface AuditRecord {
    /** ISO 时间戳。 */
    time: string
    /** 目标主机。 */
    host?: string
    /** 登录用户名。 */
    username?: string
    /** 动作类型，如 `deploy`。 */
    action: string
    /** 是否成功。 */
    ok: boolean
    /** 结构化补充字段（传输/失败计数、是否清空、执行的命令等）。 */
    detail?: Record<string, unknown>
}

/** 默认审计日志路径：`~/.wink-sftp/audit.log`。 */
export const defaultAuditPath = (): string => path.join(os.homedir(), '.wink-sftp', 'audit.log')

/** 把审计记录序列化为单行 JSON（含结尾换行）。纯函数，便于测试。 */
export const formatAuditLine = (record: AuditRecord): string => JSON.stringify(record) + '\n'

/**
 * 向审计日志文件**追加**一条记录（自动创建父目录）。
 * 写入失败由调用方决定如何处理——审计不应中断主流程。
 */
export const appendAudit = (file: string, record: AuditRecord): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, formatAuditLine(record))
}
