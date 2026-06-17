#! /usr/bin/env node
import { Command } from 'commander'
import { name, version, description } from '../package.json'
import type { RunOption, SftpOption, DeployResult } from './core'
import { run } from './core'
import { exitCodeOf, WinkSftpError } from './errors'

const program = new Command()
program.name(name).version(version).description(description)
// 释放 -h 给 connect-host（沿用本工具历史用法），help 仅保留 --help
program.helpOption('--help', '显示帮助信息')

/** 把结构化部署结果渲染为人类可读摘要（走 stderr）。 */
const renderHuman = (r: DeployResult): void => {
    console.error(r.dryRun ? '【预演】以下动作将执行但不会落地：' : '部署完成：')
    if (r.commands.length) {
        console.error(`  远程命令（${r.commands.length}）：`)
        r.commands.forEach((c) => console.error('    $ ' + c))
    }
    if (r.dirs.length) console.error(`  远程目录（${r.dirs.length}）`)
    console.error(`  传输 ${r.transferred.length} / 跳过 ${r.skipped.length} / 失败 ${r.failed.length}`)
    r.failed.forEach((f) => console.error(`    ✗ ${f.target}：${f.error}`))
}

program
    .option(
        '-c --config <path>',
        '指定配置文件路径，相对于本命令启动入口文件目录，一般是在package.json中启动，会覆盖命令行参数'
    )
    .option('-l --local <local>', '本地路径')
    .option('-r --remote <remote>', '远程路径')
    .option('-h --connect-host <host>', '远程服务器地址，必填')
    .option('-p --connect-port <port>', '远程服务器端口，必填')
    .option('-u --connect-username <user>', '远程服务器用户名，必填')
    .option('--connect-password <pwd>', '远程服务器密码，必填')
    .option('--debug', '输出调试日志，默认false')
    .option('--json', '以 JSON 结构化结果输出到 stdout（人类日志走 stderr），便于脚本/agent 解析')
    .option('--dry-run', '预演：打印将执行的动作但不建立连接、不落地')
    .option('-e --sftp-excludes <paths>', '要排除的本地目录，暂时只支持全字匹配，多个目录用英文逗号分隔，默认为空')
    .option('-f --sftp-flat', '是否扁平化目录（本地文件夹下任意深度的文件都直接传输到远程文件夹下），默认为false')
    .option('--sftp-clear', '是否在传输开始前清空远程文件夹，默认为false。慎用！删错了你别怪我！')
    .option('-o --sftp-override', '是否覆盖远程文件夹中已存在的文件，默认为false')
    .option('-i --sftp-ignore-hidden', '是否忽略隐藏文件夹，默认为true')
    .option('-m --sftp-mode <mode>', '远程文件mode，默认为0o777')
    .option('--sftp-concurrency <n>', '传输与建目录的并发上限，默认为5')
    .option('--sftp-retries <n>', '单文件传输失败的额外重试次数，默认为2')
    .option('--before-run-command <command>', '传输开始前要执行的命令，别瞎写！')
    .option('--after-run-command <command>', '传输完成后要执行的命令，别瞎写！')
    .action(async (options: Record<string, unknown>) => {
        const json = Boolean(options.json)
        const port = options.connectPort !== undefined ? Number(options.connectPort) : undefined
        const mode = options.sftpMode !== undefined ? parseInt(String(options.sftpMode), 8) : undefined
        const concurrency = options.sftpConcurrency !== undefined ? Number(options.sftpConcurrency) : undefined
        const retries = options.sftpRetries !== undefined ? Number(options.sftpRetries) : undefined
        const config = {
            local: options.local,
            remote: options.remote,
            config: options.config,
            debug: options.debug,
            json,
            dryRun: Boolean(options.dryRun),
            connect: {
                host: options.connectHost,
                port,
                username: options.connectUsername,
                password: options.connectPassword,
            },
            sftpOptions: {
                excludes: (options.sftpExcludes as string | undefined)?.split(','),
                flat: options.sftpFlat,
                clear: options.sftpClear,
                override: options.sftpOverride,
                ignoreHidden: options.sftpIgnoreHidden,
                mode,
                concurrency,
                retries,
                debug: options.debug,
                beforeRunCommand: options.beforeRunCommand,
                afterRunCommand: options.afterRunCommand,
            } as SftpOption,
        } as RunOption

        try {
            const result = await run(config)
            if (json) {
                process.stdout.write(JSON.stringify(result) + '\n')
            } else {
                renderHuman(result)
            }
            if (!result.ok) process.exitCode = 5
        } catch (e) {
            const kind = e instanceof WinkSftpError ? e.kind : 'error'
            const message = e instanceof Error ? e.message : String(e)
            if (json) {
                process.stdout.write(JSON.stringify({ ok: false, kind, error: message }) + '\n')
            } else {
                console.error('执行失败：', message)
            }
            process.exitCode = exitCodeOf(e)
        }
    })

program.parse()
