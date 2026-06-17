import { describe, it, expect } from 'vitest'
import { ConfigError, ConnectionError, RemoteCommandError, TransferError, exitCodeOf } from '../src/errors'

describe('类型化错误', () => {
    it('各错误携带约定的退出码与 kind', () => {
        expect(new ConfigError('x').exitCode).toBe(2)
        expect(new ConnectionError('x').exitCode).toBe(3)
        expect(new RemoteCommandError('x', { command: 'ls' }).exitCode).toBe(4)
        expect(new TransferError('x').exitCode).toBe(5)
        expect(new ConfigError('x').kind).toBe('config')
        expect(new RemoteCommandError('x', { command: 'ls' }).command).toBe('ls')
    })

    it('保留 cause', () => {
        const cause = new Error('root')
        expect((new ConfigError('x', { cause }) as { cause?: unknown }).cause).toBe(cause)
    })
})

describe('exitCodeOf', () => {
    it('类型化错误返回其退出码', () => {
        expect(exitCodeOf(new TransferError('x'))).toBe(5)
        expect(exitCodeOf(new ConnectionError('x'))).toBe(3)
    })
    it('非类型化错误返回通用码 1', () => {
        expect(exitCodeOf(new Error('plain'))).toBe(1)
        expect(exitCodeOf('string error')).toBe(1)
    })
})
