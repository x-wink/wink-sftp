import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfigFile, resolveConfig, interpolateSecrets, parseDotEnv } from '../src/config'

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
        const p = write('bad.json', JSON.stringify({ connect: { port: '22' } }))
        expect(() => loadConfigFile(p)).toThrow(/校验失败.*connect\.port/s)
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
