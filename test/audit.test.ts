import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatAuditLine, appendAudit, defaultAuditPath } from '../src/audit'

describe('formatAuditLine', () => {
    it('序列化为单行 JSON 且以换行结尾', () => {
        const line = formatAuditLine({ time: 'T', host: 'h', action: 'deploy', ok: true })
        expect(line.endsWith('\n')).toBe(true)
        expect(JSON.parse(line)).toEqual({ time: 'T', host: 'h', action: 'deploy', ok: true })
    })
})

describe('defaultAuditPath', () => {
    it('位于用户主目录下的 .winkops/audit.log', () => {
        expect(defaultAuditPath()).toBe(path.join(os.homedir(), '.winkops', 'audit.log'))
    })
})

describe('appendAudit', () => {
    it('创建父目录并追加记录', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-audit-'))
        const file = path.join(dir, 'nested', 'audit.log')
        appendAudit(file, { time: 'T1', action: 'deploy', ok: true })
        appendAudit(file, { time: 'T2', action: 'deploy', ok: false })
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
        expect(lines).toHaveLength(2)
        expect(JSON.parse(lines[0]).time).toBe('T1')
        expect(JSON.parse(lines[1]).ok).toBe(false)
        fs.rmSync(dir, { recursive: true, force: true })
    })
})
