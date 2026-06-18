import { shellQuote } from './exec'
import type { ExecResult } from './exec'
import type { Logger } from './logger'

/**
 * 守护式变更只依赖「能在远程执行命令」这一能力。用结构化接口而非具体 {@link SshSession}，
 * 既让 {@link SshSession} 天然满足，也便于单测直接传 stub。
 */
export interface ExecCapable {
    exec(command: string): Promise<ExecResult>
}

/** 远程路径是否存在（`test -e`）。绝不抛错：命令失败（非零退出）即视为不存在。 */
export const existsRemote = async (session: ExecCapable, target: string): Promise<boolean> => {
    try {
        const r = await session.exec(`test -e ${shellQuote(target)}`)
        return r.code === 0
    } catch {
        return false
    }
}

/**
 * 备份远程文件/目录到同级的 `${target}.wink-bak.<suffix>`（`cp -a` 保留属性、递归）。
 * 目标不存在则不备份、返回 null。返回备份路径供 {@link restoreRemote} / 清理使用。
 */
export const backupRemote = async (session: ExecCapable, target: string, suffix?: string): Promise<string | null> => {
    if (!(await existsRemote(session, target))) return null
    const backup = `${target}.wink-bak.${suffix ?? new Date().getTime()}`
    await session.exec(`cp -a ${shellQuote(target)} ${shellQuote(backup)}`)
    return backup
}

/** 从备份恢复：删除当前 `target`，再把 `backup` 移回原位（一条命令内 `&&` 串联，均经转义）。 */
export const restoreRemote = async (session: ExecCapable, target: string, backup: string): Promise<void> => {
    await session.exec(`rm -rf ${shellQuote(target)} && mv ${shellQuote(backup)} ${shellQuote(target)}`)
}

export interface GuardOptions {
    /** 受守护的远程路径（文件或目录）。 */
    target: string
    /** 应用变更（写入新内容 / 部署文件等），在备份之后执行。 */
    apply: () => Promise<void>
    /** 可选校验命令（如 `nginx -t`）；退出码非零（抛错）触发回滚。 */
    validate?: string
    /** 可选 reload 命令（如 `systemctl reload nginx`）；失败同样回滚。 */
    reload?: string
    /** 成功后是否保留备份（默认 false：成功即删除备份）。 */
    keepBackup?: boolean
    /** 备份路径后缀（默认当前时间戳毫秒），便于测试注入确定值。 */
    backupSuffix?: string
}

/** 守护式变更结果。 */
export interface GuardResult {
    /** 变更是否成功（应用 + 校验 + reload 全过）。 */
    ok: boolean
    /** 受守护的目标路径。 */
    target: string
    /** 备份路径（目标原先存在才有；成功且未保留时为 null）。 */
    backup: string | null
    /** 失败后是否已回滚到备份。 */
    rolledBack: boolean
    /** 失败原因（ok=false 时有）。 */
    error?: string
}

/**
 * 守护式远程变更原语：**备份 → 应用 → 校验 → reload**，任一步失败自动**回滚**到备份。
 *
 * 是 `edit`（改 nginx 等）、`clear`、provision `configure`、部署回滚的共同底座——一处实现、处处复用。
 * 不抛错：把成败收进 {@link GuardResult}（失败含 `error`、是否 `rolledBack`），由上层定退出码。
 *
 * 边界：目标原先不存在（无备份）时若 apply 后校验失败，无法回滚（`rolledBack=false`），
 * 仅如实反映在结果中——清理新建产物由调用方决定。回滚为**文件级**，不撤销 reload 等副作用。
 */
export const guard = async (session: ExecCapable, options: GuardOptions, logger?: Logger): Promise<GuardResult> => {
    const { target, apply, validate, reload, keepBackup = false, backupSuffix } = options
    const backup = await backupRemote(session, target, backupSuffix)
    try {
        await apply()
        if (validate) await session.exec(validate)
        if (reload) await session.exec(reload)
    } catch (e) {
        let rolledBack = false
        if (backup) {
            logger?.warn(`⚠ 变更失败，回滚到备份：${target}`)
            await restoreRemote(session, target, backup)
            rolledBack = true
        }
        return { ok: false, target, backup, rolledBack, error: e instanceof Error ? e.message : String(e) }
    }
    if (backup && !keepBackup) await session.exec(`rm -rf ${shellQuote(backup)}`)
    return { ok: true, target, backup: keepBackup ? backup : null, rolledBack: false }
}
