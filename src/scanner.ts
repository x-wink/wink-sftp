import path from 'node:path'
import fs from 'node:fs'
import ignore from 'ignore'

/** 本地根目录下的忽略规则文件名（gitignore 风格）。 */
export const IGNORE_FILE = '.winkignore'

export interface ScanOptions {
    /** 忽略隐藏文件/目录（任意以 `.` 开头的路径段），默认 true。 */
    ignoreHidden?: boolean
    /** 要排除的绝对路径（全字匹配），默认空。 */
    excludes?: string[]
    /** gitignore 风格忽略规则（相对扫描根，按 POSIX 路径匹配），默认空。 */
    ignorePatterns?: string[]
}

/**
 * 汇集忽略规则：读取本地根目录下的 `.winkignore`（若存在）并拼上 `inline` 规则，
 * 再追加忽略文件自身（不上传）。空行与 `#` 注释交由 `ignore` 处理。读失败仅静默返回内联规则。
 */
export const loadIgnorePatterns = (root: string, inline: string[] = []): string[] => {
    const patterns = [...inline]
    try {
        const file = path.join(root, IGNORE_FILE)
        if (fs.existsSync(file)) patterns.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/))
    } catch {
        // 读取忽略文件失败不应中断扫描
    }
    patterns.push(IGNORE_FILE)
    return patterns
}

export interface ScanResult {
    /** 命中的目录绝对路径列表（含根目录）。 */
    dirs: string[]
    /** 命中的文件绝对路径列表。 */
    files: string[]
}

/**
 * 递归扫描本地目录，返回目录与文件的绝对路径列表。纯函数（仅读本地 fs，不触网）。
 *
 * `ignoreHidden` 的判定**只针对 root 之下的相对路径段**，且要求段名以 `.` 开头——
 * 修正了旧实现「检查整个绝对路径、匹配任意含点名字」导致的误判
 * （例如项目位于 `/Users/me/my.app` 时整棵树被误跳过）。
 *
 * @param root 已解析为绝对路径的扫描根目录
 */
export const scan = (root: string, options: ScanOptions = {}): ScanResult => {
    const { ignoreHidden = true, excludes = [], ignorePatterns = [] } = options
    // excludes（绝对路径全字匹配）统一折叠为锚定到根的 gitignore 规则，与 ignorePatterns 共用一个匹配器
    const excludePatterns = excludes.map((abs) => '/' + path.relative(root, abs).split(path.sep).join('/'))
    const allPatterns = [...excludePatterns, ...ignorePatterns]
    const ig = allPatterns.length ? ignore().add(allPatterns) : null
    const res: ScanResult = { dirs: [], files: [] }

    const isHidden = (abs: string): boolean => {
        if (!ignoreHidden) return false
        const rel = path.relative(root, abs)
        if (rel === '') return false // root 自身不参与隐藏判定
        return rel.split(path.sep).some((seg) => seg.startsWith('.'))
    }

    // gitignore 规则匹配相对根的 POSIX 路径；根自身不参与匹配。
    // 目录用尾斜杠测试，使「dir/」这类仅匹配目录的规则能整目录剪枝（否则空目录仍会被建到远程）。
    const isIgnored = (abs: string, isDir: boolean): boolean => {
        if (!ig) return false
        const rel = path.relative(root, abs)
        if (rel === '') return false
        const posix = rel.split(path.sep).join('/')
        return ig.ignores(isDir ? posix + '/' : posix)
    }

    const walk = (abs: string): void => {
        if (!fs.existsSync(abs)) return
        const isDir = fs.statSync(abs).isDirectory()
        if (isHidden(abs) || isIgnored(abs, isDir)) return
        if (isDir) {
            res.dirs.push(abs)
            for (const name of fs.readdirSync(abs)) {
                walk(path.join(abs, name))
            }
        } else {
            res.files.push(abs)
        }
    }

    walk(root)
    return res
}
