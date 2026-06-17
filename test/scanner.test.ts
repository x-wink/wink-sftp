import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan } from '../src/scanner'

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
})
