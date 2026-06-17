import { describe, it, expect } from 'vitest'
import { linuxPath, remoteIsDir, buildRemoteTarget, buildRemoteDir, findFlatCollisions } from '../src/pathmap'

describe('linuxPath', () => {
    it('始终用 / 拼接，归一反斜杠', () => {
        expect(linuxPath('/apps/app', 'sub\\a.js')).toBe('/apps/app/sub/a.js')
    })
    it('用 posix 语义折叠多余分隔符', () => {
        expect(linuxPath('/apps/app/', '/sub/', 'a.js')).toBe('/apps/app/sub/a.js')
    })
})

describe('remoteIsDir', () => {
    it('文件列表为空时返回 false（不崩溃）', () => {
        expect(remoteIsDir([], '/apps/app')).toBe(false)
        expect(remoteIsDir([], '/apps/app.js')).toBe(false)
    })
    it('多于一个文件时视为目录', () => {
        expect(remoteIsDir(['/a/x.js', '/a/y.js'], '/apps/app')).toBe(true)
    })
    it('单文件有扩展名而远程无扩展名时视为目录', () => {
        expect(remoteIsDir(['/a/x.js'], '/apps/app')).toBe(true)
    })
    it('单文件且远程也有扩展名时视为文件（重命名）', () => {
        expect(remoteIsDir(['/a/x.js'], '/apps/app.js')).toBe(false)
    })
    it('单文件无扩展名时视为文件', () => {
        expect(remoteIsDir(['/a/README'], '/apps/app')).toBe(false)
    })
})

describe('buildRemoteTarget', () => {
    const local = '/local/proj'
    it('非目录时直接用 remote', () => {
        expect(
            buildRemoteTarget('/local/proj/a.js', {
                local,
                remote: '/apps/app.js',
                remoteIsDir: false,
                flat: false,
            })
        ).toBe('/apps/app.js')
    })
    it('目录 + 保留结构时按相对路径映射', () => {
        expect(
            buildRemoteTarget('/local/proj/sub/a.js', {
                local,
                remote: '/apps/app',
                remoteIsDir: true,
                flat: false,
            })
        ).toBe('/apps/app/sub/a.js')
    })
    it('目录 + flat 时只取文件名', () => {
        expect(
            buildRemoteTarget('/local/proj/sub/a.js', {
                local,
                remote: '/apps/app',
                remoteIsDir: true,
                flat: true,
            })
        ).toBe('/apps/app/a.js')
    })
})

describe('buildRemoteDir', () => {
    it('按相对路径映射远程目录', () => {
        expect(buildRemoteDir('/local/proj/sub', '/local/proj', '/apps/app')).toBe('/apps/app/sub')
    })
    it('根目录自身映射到 remote', () => {
        expect(buildRemoteDir('/local/proj', '/local/proj', '/apps/app')).toBe('/apps/app')
    })
})

describe('findFlatCollisions', () => {
    it('无同名目标时返回空数组', () => {
        expect(
            findFlatCollisions([
                { file: '/l/a.js', target: '/r/a.js' },
                { file: '/l/b.js', target: '/r/b.js' },
            ])
        ).toEqual([])
    })
    it('同一远程目标对应多个源文件时报告冲突', () => {
        expect(
            findFlatCollisions([
                { file: '/l/x/a.js', target: '/r/a.js' },
                { file: '/l/y/a.js', target: '/r/a.js' },
                { file: '/l/b.js', target: '/r/b.js' },
            ])
        ).toEqual([{ target: '/r/a.js', files: ['/l/x/a.js', '/l/y/a.js'] }])
    })
    it('空列表安全', () => {
        expect(findFlatCollisions([])).toEqual([])
    })
})
