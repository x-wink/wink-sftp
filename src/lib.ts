/**
 * 库入口（编程式 API）：供 Node 脚本 `import { ... } from '@xwink/sftp'` 集成。
 *
 * 与 CLI 入口 `index.ts` 分离——本文件**不解析 argv、不执行任何命令**，仅导出
 * 稳定的能力面：会话抽象、部署 / 下载 / 浏览、守护式变更、配置解析与类型化错误。
 */
export { SshSession, withSession } from './session'
export { run, runMany, runAuto, pull, ls, rollback } from './core'
export type {
    RunOption,
    SftpOption,
    ResolvedConfig,
    DeployResult,
    MultiDeployResult,
    HostDeployResult,
    PullResult,
    LsResult,
    RemoteEntry,
    RollbackResult,
    EnvOverride,
    StackValue,
    StackSpec,
} from './core'
export { guard, backupRemote, restoreRemote, existsRemote } from './guard'
export type { GuardOptions, GuardResult } from './guard'
export { runExec, status, tailLogs, ps, service } from './ops'
export type {
    ExecRunResult,
    StatusResult,
    LogsResult,
    DiskUsage,
    PsResult,
    ProcessInfo,
    ServiceResult,
    ServiceManager,
    ServiceAction,
} from './ops'
export { edit } from './edit'
export type { EditOptions, EditResult } from './edit'
export { provision, versionSatisfies, normalizeDesired, RECIPES } from './provision'
export type { ProvisionResult, ComponentResult, Recipe, DetectState, PlanStep, ConvergePlan } from './provision'
export { resolveConfig, loadConfigFile } from './config'
export { execCommand, shellQuote } from './exec'
export type { ExecResult } from './exec'
export { Logger } from './logger'
export { WinkSftpError, ConfigError, ConnectionError, RemoteCommandError, TransferError, exitCodeOf } from './errors'
