import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pull, ls } from '../src/core'

// 虚拟远程文件树
const h = vi.hoisted(() => ({
    state: { gets: [] as { remote: string; local: string }[] },
}))

type Node = { type: 'dir'; children: string[] } | { type: 'file'; size: number }
const TREE: Record<string, Node> = {
    '/remote/app': { type: 'dir', children: ['a.txt', 'sub', 'z.txt'] },
    '/remote/app/a.txt': { type: 'file', size: 1 },
    '/remote/app/z.txt': { type: 'file', size: 3 },
    '/remote/app/sub': { type: 'dir', children: ['b.txt'] },
    '/remote/app/sub/b.txt': { type: 'file', size: 2 },
}

const makeAttrs = (node: Node) => ({
    size: node.type === 'file' ? node.size : 0,
    mtime: 1700000000,
    isDirectory: () => node.type === 'dir',
    isFile: () => node.type === 'file',
    isSymbolicLink: () => false,
})

vi.mock('ssh2', () => {
    class Emitter {
        private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
        on(event: string, cb: (...args: unknown[]) => void) {
            ;(this.handlers[event] ||= []).push(cb)
            return this
        }
        emit(event: string, ...args: unknown[]) {
            for (const cb of this.handlers[event] ?? []) cb(...args)
        }
    }
    class FakeClient extends Emitter {
        connect() {
            setTimeout(() => this.emit('ready'), 0)
            return this
        }
        end() {}
        sftp(cb: (err: unknown, sftp: unknown) => void) {
            cb(null, {
                stat(p: string, done: (err: unknown, stats?: unknown) => void) {
                    const node = TREE[p]
                    if (node) done(null, makeAttrs(node))
                    else done(new Error('no such file'))
                },
                readdir(p: string, done: (err: unknown, list?: unknown) => void) {
                    const node = TREE[p]
                    if (!node || node.type !== 'dir') {
                        done(new Error('not a dir'))
                        return
                    }
                    done(
                        null,
                        node.children.map((name) => ({ filename: name, attrs: makeAttrs(TREE[`${p}/${name}`]) }))
                    )
                },
                fastGet(remote: string, local: string, done: (err?: unknown) => void) {
                    h.state.gets.push({ remote, local })
                    fs.writeFileSync(local, 'x')
                    done()
                },
            })
        }
    }
    return { Client: FakeClient }
})

let localDir: string
beforeEach(() => {
    h.state.gets = []
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-pull-'))
})
afterEach(() => fs.rmSync(localDir, { recursive: true, force: true }))

const conn = { host: 'h', port: 22, username: 'u', password: 'pw' }

describe('ls（mock ssh2）', () => {
    it('列出远程目录，按名称排序、标注类型与大小', async () => {
        const r = await ls({ connect: conn, remote: '/remote/app' })
        expect(r.ok).toBe(true)
        expect(r.remote).toBe('/remote/app')
        expect(r.entries.map((e) => e.name)).toEqual(['a.txt', 'sub', 'z.txt'])
        expect(r.entries.find((e) => e.name === 'sub')?.type).toBe('dir')
        expect(r.entries.find((e) => e.name === 'a.txt')).toMatchObject({ type: 'file', size: 1 })
    })

    it('不需要 local 也可运行（只读）', async () => {
        await expect(ls({ connect: conn, remote: '/remote/app' })).resolves.toBeTruthy()
    })

    it('列出不存在的目录抛错', async () => {
        await expect(ls({ connect: conn, remote: '/remote/nope' })).rejects.toThrow(/读取远程目录失败/)
    })
})

describe('pull（mock ssh2）', () => {
    it('目录递归下载，镜像本地结构', async () => {
        const r = await pull({ connect: conn, local: localDir, remote: '/remote/app' })
        expect(r.ok).toBe(true)
        const rel = r.downloaded.map((p) => path.relative(localDir, p).split(path.sep).join('/')).toSorted()
        expect(rel).toEqual(['a.txt', 'sub/b.txt', 'z.txt'])
        expect(fs.existsSync(path.join(localDir, 'sub', 'b.txt'))).toBe(true)
    })

    it('单文件下载到本地目录下（local 为已存在目录）', async () => {
        const r = await pull({ connect: conn, local: localDir, remote: '/remote/app/a.txt' })
        expect(r.ok).toBe(true)
        expect(r.downloaded).toEqual([path.join(localDir, 'a.txt')])
        expect(fs.existsSync(path.join(localDir, 'a.txt'))).toBe(true)
    })

    it('单文件下载到指定文件路径（local 不存在）', async () => {
        const target = path.join(localDir, 'nested', 'renamed.txt')
        const r = await pull({ connect: conn, local: target, remote: '/remote/app/a.txt' })
        expect(r.downloaded).toEqual([target])
        expect(fs.existsSync(target)).toBe(true)
    })

    it('远程路径不存在抛 TransferError', async () => {
        await expect(pull({ connect: conn, local: localDir, remote: '/remote/missing' })).rejects.toThrow(
            /远程路径不存在/
        )
    })
})
