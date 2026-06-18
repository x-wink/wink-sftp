import fs from 'node:fs'
import { withSession } from './session'
import { resolveConfig } from './config'
import { Logger } from './logger'
import { resolveLocal } from './pathmap'
import { guard } from './guard'
import type { GuardResult } from './guard'
import { ConfigError, TransferError } from './errors'
import type { RunOption } from './core'

export interface EditOptions {
    /** 远程目标文件。 */
    remote: string
    /** 本地新内容文件路径（相对启动目录）；其内容将原子替换远程文件。 */
    file: string
    /** 可选校验命令（如 `nginx -t`），退出码非零触发回滚。 */
    validate?: string
    /** 可选 reload 命令（如 `systemctl reload nginx`），失败同样回滚。 */
    reload?: string
}

/** `edit` 结果（即 {@link guard} 的结果：含 `ok`/`target`/`backup`/`rolledBack`/`error`）。 */
export type EditResult = GuardResult

/**
 * 守护式远程配置编辑：用本地 `file` 的内容**原子替换**远程 `remote`，复用 {@link guard} 流水线——
 * 备份 → 写入新内容 → 校验（`validate`）→ reload → 任一步失败自动回滚到备份。
 *
 * 「编辑主体」采用「本地文件提供新内容」模型（agent / 脚本直接给出目标内容，最确定、可重放）；
 * 交互式 `$EDITOR` 拉取-编辑模型按需再加。需要 connect，不需要 config 的 local/remote。
 */
export const edit = async (opts: EditOptions, options?: RunOption): Promise<EditResult> => {
    const config = resolveConfig(options, { requireLocal: false, requireRemote: false })
    const logger = new Logger({ debug: config.debug, json: config.json })
    const localFile = resolveLocal(opts.file)
    if (!fs.existsSync(localFile)) throw new ConfigError(`本地内容文件不存在：${localFile}`)
    return withSession(config.connect, logger, async (session) => {
        const sftp = await session.sftp()
        return guard(
            session,
            {
                target: opts.remote,
                validate: opts.validate,
                reload: opts.reload,
                apply: () =>
                    new Promise<void>((resolve, reject) => {
                        sftp.fastPut(localFile, opts.remote, (err) =>
                            err
                                ? reject(new TransferError(`写入远程文件失败：${opts.remote}`, { cause: err }))
                                : resolve()
                        )
                    }),
            },
            logger
        )
    })
}
