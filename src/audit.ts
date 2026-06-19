import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ResolvedConfig } from './core'
import type { Logger } from './logger'

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

/** 默认审计日志路径：`~/.winkops/audit.log`。 */
export const defaultAuditPath = (): string => path.join(os.homedir(), '.winkops', 'audit.log')

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

/**
 * 记录一条写操作审计（部署 / edit / service 等共用）：自配置取主机/用户/路径与开关。
 * 审计关闭时直接跳过；写入失败仅降级为 warn 提示，绝不中断主流程。
 */
export const recordAudit = (
    config: ResolvedConfig,
    logger: Logger,
    action: string,
    ok: boolean,
    detail?: Record<string, unknown>
): void => {
    if (!config.audit) return
    try {
        appendAudit(config.auditLog, {
            time: new Date().toISOString(),
            host: config.connect.host,
            username: config.connect.username,
            action,
            ok,
            detail,
        })
    } catch (e) {
        // 用户已显式启用审计，写入失败需 warn 提示而非静默，但不应中断主流程
        logger.warn('⚠ 审计日志写入失败：' + (e instanceof Error ? e.message : String(e)))
    }
}
