import { describe, it, expect } from 'vitest'
import { shellQuote } from '../src/exec'

describe('shellQuote', () => {
    it('用单引号包裹普通字符串', () => {
        expect(shellQuote('abc')).toBe(`'abc'`)
    })

    it('包裹含空格的路径，使其成为单个参数', () => {
        expect(shellQuote('/apps/my app')).toBe(`'/apps/my app'`)
    })

    it('转义内部单引号（闭合→转义→重开）', () => {
        expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`)
    })

    it('中和命令注入元字符（不被 shell 解释）', () => {
        const malicious = '$(rm -rf /); `whoami`; a && b | c > d'
        const quoted = shellQuote(malicious)
        // 整体被单引号包裹，内部无裸单引号可逃逸
        expect(quoted.startsWith(`'`)).toBe(true)
        expect(quoted.endsWith(`'`)).toBe(true)
        expect(quoted).toBe(`'${malicious}'`)
    })

    it('处理文件名注入：分号与反引号被中和', () => {
        expect(shellQuote('file;rm -rf ~')).toBe(`'file;rm -rf ~'`)
    })
})
