import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfigFile, resolveConfig, interpolateSecrets, parseDotEnv, deepMerge } from '../src/config'

let dir: string

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-config-'))
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
}

const validConfig = {
    connect: { host: 'h', port: 22, username: 'u', password: 'pw' },
    local: './dist',
    remote: '/apps/app',
}

describe('loadConfigFile', () => {
    it('解析 JSON 配置', () => {
        const p = write('sftp.json', JSON.stringify(validConfig))
        expect(loadConfigFile(p)).toMatchObject(validConfig)
    })

    it('解析 YAML 配置（.yaml）', () => {
        const p = write(
            'sftp.yaml',
            [
                'connect:',
                '  host: h',
                '  port: 22',
                '  username: u',
                '  password: pw',
                'local: ./dist',
                'remote: /apps/app',
            ].join('\n')
        )
        expect(loadConfigFile(p)).toMatchObject(validConfig)
    })

    it('解析 YAML 配置（.yml）', () => {
        const p = write('sftp.yml', 'local: ./dist\nremote: /apps/app\n')
        expect(loadConfigFile(p)).toMatchObject({ local: './dist', remote: '/apps/app' })
    })

    it('文件不存在抛 ConfigError（读取失败）', () => {
        expect(() => loadConfigFile(path.join(dir, 'nope.json'))).toThrow(/读取配置文件失败/)
    })

    it('JSON 语法错误抛 ConfigError（解析失败）', () => {
        const p = write('bad.json', '{ not json }')
        expect(() => loadConfigFile(p)).toThrow(/解析配置文件失败/)
    })

    it('字段类型非法抛 ConfigError（校验失败，含字段路径）', () => {
        const p = write('bad.json', JSON.stringify({ connect: { host: 123 } }))
        expect(() => loadConfigFile(p)).toThrow(/校验失败.*connect\.host/s)
    })

    it('数值字段接受可强转的字符串（${ENV_VAR} 注入后必为字符串）', () => {
        const p = write('num.json', JSON.stringify({ connect: { port: '2222' } }))
        expect(loadConfigFile(p).connect?.port).toBe(2222)
    })

    it('未知顶层字段被静默剔除', () => {
        const p = write('extra.json', JSON.stringify({ ...validConfig, unknownField: 1 }))
        expect(loadConfigFile(p)).not.toHaveProperty('unknownField')
    })
})

describe('resolveConfig', () => {
    it('从文件加载并归一化', () => {
        const p = write('sftp.json', JSON.stringify(validConfig))
        const r = resolveConfig({ config: p })
        expect(r.local).toBe('./dist')
        expect(r.connect.host).toBe('h')
        expect(r.audit).toBe(true)
    })

    it('YAML 文件同样可被 resolveConfig 解析', () => {
        const p = write(
            'sftp.yaml',
            'connect:\n  host: h\n  port: 22\n  username: u\n  password: pw\nlocal: ./dist\nremote: /apps/app\n'
        )
        const r = resolveConfig({ config: p })
        expect(r.remote).toBe('/apps/app')
    })

    it('调用级 --no-audit 覆盖文件 audit:true', () => {
        const p = write('sftp.json', JSON.stringify({ ...validConfig, audit: true }))
        expect(resolveConfig({ config: p, audit: false }).audit).toBe(false)
    })

    it('缺认证字段抛 ConfigError', () => {
        const p = write(
            'sftp.json',
            JSON.stringify({ ...validConfig, connect: { host: 'h', port: 22, username: 'u' } })
        )
        expect(() => resolveConfig({ config: p })).toThrow(/connect\.password 或 connect\.privateKey/)
    })
})

describe('interpolateSecrets', () => {
    const env = { PWD_VAR: 's3cret', HOST_VAR: 'example.com', EMPTY: '' }

    it('替换字符串中的 ${VAR}（整值与内嵌）', () => {
        const { value, missing } = interpolateSecrets({ a: '${PWD_VAR}', b: 'pre-${HOST_VAR}-post' }, env)
        expect(value).toEqual({ a: 's3cret', b: 'pre-example.com-post' })
        expect(missing).toEqual([])
    })

    it('递归处理嵌套对象与数组', () => {
        const { value } = interpolateSecrets({ connect: { password: '${PWD_VAR}' }, list: ['${HOST_VAR}'] }, env)
        expect(value).toEqual({ connect: { password: 's3cret' }, list: ['example.com'] })
    })

    it('空字符串环境变量视为已定义（不算缺失）', () => {
        const { value, missing } = interpolateSecrets({ a: '${EMPTY}' }, env)
        expect(value).toEqual({ a: '' })
        expect(missing).toEqual([])
    })

    it('未定义变量被收集进 missing', () => {
        const { missing } = interpolateSecrets({ a: '${NOPE}', b: '${PWD_VAR}' }, env)
        expect(missing).toEqual(['NOPE'])
    })

    it('非字符串值原样保留', () => {
        const { value } = interpolateSecrets({ port: 22, flag: true, nil: null }, env)
        expect(value).toEqual({ port: 22, flag: true, nil: null })
    })
})

describe('deepMerge', () => {
    it('普通对象递归合并、标量与数组整体替换', () => {
        const merged = deepMerge(
            { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
            { a: 9, nested: { y: 20, z: 30 }, list: [3] }
        )
        expect(merged).toEqual({ a: 9, nested: { x: 1, y: 20, z: 30 }, list: [3] })
    })

    it('override 中 undefined 不覆盖 base', () => {
        expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
    })
})

describe('多环境 --env', () => {
    const multiEnv = {
        ...validConfig,
        connect: { host: 'base', port: 22, username: 'u', password: 'pw' },
        environments: {
            prod: { connect: { host: 'prod-host' }, remote: '/prod' },
            dev: { connect: { host: 'dev-host' } },
        },
    }

    it('选中环境深合并到基础配置之上', () => {
        const p = write('sftp.json', JSON.stringify(multiEnv))
        const r = resolveConfig({ config: p, env: 'prod' })
        expect(r.connect.host).toBe('prod-host')
        expect(r.connect.username).toBe('u') // 基础配置保留
        expect(r.remote).toBe('/prod')
    })

    it('未选环境时使用基础配置', () => {
        const p = write('sftp.json', JSON.stringify(multiEnv))
        expect(resolveConfig({ config: p }).connect.host).toBe('base')
    })

    it('选了不存在的环境抛 ConfigError 并列出可用环境', () => {
        const p = write('sftp.json', JSON.stringify(multiEnv))
        expect(() => resolveConfig({ config: p, env: 'staging' })).toThrow(/未找到环境配置.*prod.*dev/s)
    })

    it('配置文件可设默认 env，未传 --env 时生效', () => {
        const p = write('sftp.json', JSON.stringify({ ...multiEnv, env: 'prod' }))
        expect(resolveConfig({ config: p }).connect.host).toBe('prod-host')
    })

    it('CLI/编程式 --env 覆盖文件默认 env', () => {
        const p = write('sftp.json', JSON.stringify({ ...multiEnv, env: 'prod' }))
        expect(resolveConfig({ config: p, env: 'dev' }).connect.host).toBe('dev-host')
    })
})

describe('统一深度合并优先级（文件 ← 环境 ← 显式参数）', () => {
    it('显式 remote 覆盖配置文件 remote', () => {
        const p = write('sftp.json', JSON.stringify(validConfig))
        expect(resolveConfig({ config: p, remote: '/override' }).remote).toBe('/override')
    })

    it('显式 connect.host 覆盖，文件其余 connect 字段保留', () => {
        const p = write('sftp.json', JSON.stringify(validConfig))
        const r = resolveConfig({ config: p, connect: { host: 'cli-host' } })
        expect(r.connect.host).toBe('cli-host')
        expect(r.connect.username).toBe('u') // 来自文件
        expect(r.connect.password).toBe('pw') // 来自文件
    })

    it('未显式设置的字段不覆盖文件值', () => {
        const p = write('sftp.json', JSON.stringify(validConfig))
        // connect 全 undefined 不应抹掉文件的 host
        const r = resolveConfig({ config: p, connect: { host: undefined } })
        expect(r.connect.host).toBe('h')
    })

    it('显式参数优先于选中环境覆盖', () => {
        const p = write(
            'sftp.json',
            JSON.stringify({
                ...validConfig,
                environments: { prod: { remote: '/prod', connect: { host: 'prod-host' } } },
            })
        )
        const r = resolveConfig({ config: p, env: 'prod', remote: '/cli' })
        expect(r.remote).toBe('/cli') // 显式覆盖 env 的 /prod
        expect(r.connect.host).toBe('prod-host') // env 覆盖未被显式参数触及
    })
})

describe('parseDotEnv', () => {
    it('解析键值、忽略注释与空行、去除引号、支持 export', () => {
        const parsed = parseDotEnv(
            ['# comment', '', 'A=1', 'export B = two', 'C="quoted"', "D='single'", 'bad line'].join('\n')
        )
        expect(parsed).toEqual({ A: '1', B: 'two', C: 'quoted', D: 'single' })
    })
})

describe('loadConfigFile + secrets', () => {
    it('从 process.env 注入 ${VAR}', () => {
        process.env.WINK_TEST_PWD = 'injected-pw'
        const p = write(
            'sftp.json',
            JSON.stringify({ ...validConfig, connect: { ...validConfig.connect, password: '${WINK_TEST_PWD}' } })
        )
        try {
            expect(loadConfigFile(p).connect?.password).toBe('injected-pw')
        } finally {
            delete process.env.WINK_TEST_PWD
        }
    })

    it('引用未定义变量抛 ConfigError', () => {
        const p = write(
            'sftp.json',
            JSON.stringify({ ...validConfig, connect: { ...validConfig.connect, password: '${WINK_UNDEFINED_VAR}' } })
        )
        expect(() => loadConfigFile(p)).toThrow(/未定义的环境变量.*WINK_UNDEFINED_VAR/s)
    })

    it('.env 作为环境变量回退（cwd 下）', () => {
        const cwd = process.cwd()
        process.chdir(dir)
        fs.writeFileSync(path.join(dir, '.env'), 'WINK_DOTENV_PWD=from-dotenv\n')
        const p = write(
            'sftp.json',
            JSON.stringify({ ...validConfig, connect: { ...validConfig.connect, password: '${WINK_DOTENV_PWD}' } })
        )
        try {
            expect(loadConfigFile(p).connect?.password).toBe('from-dotenv')
        } finally {
            process.chdir(cwd)
        }
    })
})
