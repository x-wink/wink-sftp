import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfigFile, resolveConfig } from '../src/config'

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
