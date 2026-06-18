import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan, loadIgnorePatterns, IGNORE_FILE } from '../src/scanner'

// 注意：前缀含 `.`，且 tmpdir 路径本身常含 `.`（如 /var/folders/.../T）。
// 这正是旧实现的 bug 触发条件——它检查整个绝对路径的每个段是否含 `.`，会误跳整棵树。
let root: string
const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/')

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wink.sftp.test-'))
    fs.writeFileSync(path.join(root, 'a.js'), '')
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'sub', 'b.js'), '')
    fs.mkdirSync(path.join(root, '.hidden'))
    fs.writeFileSync(path.join(root, '.hidden', 'c.js'), '')
    fs.writeFileSync(path.join(root, '.secret.txt'), '')
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'node_modules', 'd.js'), '')
})

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
})

describe('scan', () => {
    it('默认忽略隐藏文件/目录，且不因 root 路径含点而误跳整棵树（回归）', () => {
        const { files } = scan(root)
        const got = files.map(rel).toSorted()
        expect(got).toContain('a.js')
        expect(got).toContain('sub/b.js')
        expect(got).toContain('node_modules/d.js')
        expect(got).not.toContain('.hidden/c.js')
        expect(got).not.toContain('.secret.txt')
    })

    it('ignoreHidden=false 时包含隐藏文件/目录', () => {
        const { files } = scan(root, { ignoreHidden: false })
        const got = files.map(rel).toSorted()
        expect(got).toContain('.hidden/c.js')
        expect(got).toContain('.secret.txt')
    })

    it('excludes 按绝对路径全字匹配排除目录', () => {
        const { files } = scan(root, { excludes: [path.join(root, 'node_modules')] })
        const got = files.map(rel)
        expect(got).not.toContain('node_modules/d.js')
        expect(got).toContain('a.js')
    })

    it('返回的目录列表含 root 与子目录', () => {
        const { dirs } = scan(root)
        const got = dirs.map(rel)
        expect(got).toContain('')
        expect(got).toContain('sub')
    })

    it('ignorePatterns 按 gitignore 风格忽略（glob + 目录剪枝）', () => {
        const { files, dirs } = scan(root, {
            ignorePatterns: ['*.txt', 'node_modules/', 'sub/b.js'],
            ignoreHidden: false,
        })
        const gotFiles = files.map(rel).toSorted()
        expect(gotFiles).toContain('a.js')
        expect(gotFiles).not.toContain('node_modules/d.js') // 目录整体剪枝
        expect(gotFiles).not.toContain('sub/b.js') // 精确路径
        expect(gotFiles).not.toContain('.secret.txt') // *.txt
        // 仅匹配目录的规则（node_modules/）应连空目录一起剪掉，不留在 dirs（否则会被建到远程）
        expect(dirs.map(rel)).not.toContain('node_modules')
    })
})

describe('loadIgnorePatterns', () => {
    let dir: string
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-ignore-'))
        fs.writeFileSync(path.join(dir, IGNORE_FILE), '# 注释\n\n*.log\ntmp/\n')
    })
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('读取 .winksftpignore 并合并内联规则，追加忽略文件自身', () => {
        const patterns = loadIgnorePatterns(dir, ['dist/'])
        expect(patterns).toContain('dist/')
        expect(patterns).toContain('*.log')
        expect(patterns).toContain('tmp/')
        expect(patterns).toContain(IGNORE_FILE)
    })

    it('忽略文件不存在时仅返回内联规则 + 自身', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wink-noignore-'))
        try {
            expect(loadIgnorePatterns(empty)).toEqual([IGNORE_FILE])
        } finally {
            fs.rmSync(empty, { recursive: true, force: true })
        }
    })

    it('.winksftpignore 规则经 scan 端到端生效', () => {
        fs.writeFileSync(path.join(dir, 'keep.js'), '')
        fs.writeFileSync(path.join(dir, 'drop.log'), '')
        const { files } = scan(dir, { ignorePatterns: loadIgnorePatterns(dir) })
        const got = files.map((f) => path.relative(dir, f).split(path.sep).join('/'))
        expect(got).toContain('keep.js')
        expect(got).not.toContain('drop.log')
        expect(got).not.toContain(IGNORE_FILE) // 忽略文件自身不传
    })
})
