import path from 'node:path'
import fs from 'node:fs'

export interface ScanOptions {
    /** 忽略隐藏文件/目录（任意以 `.` 开头的路径段），默认 true。 */
    ignoreHidden?: boolean
    /** 要排除的绝对路径（全字匹配），默认空。 */
    excludes?: string[]
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
    const { ignoreHidden = true, excludes = [] } = options
    const excludeSet = new Set(excludes)
    const res: ScanResult = { dirs: [], files: [] }

    const isHidden = (abs: string): boolean => {
        if (!ignoreHidden) return false
        const rel = path.relative(root, abs)
        if (rel === '') return false // root 自身不参与隐藏判定
        return rel.split(path.sep).some((seg) => seg.startsWith('.'))
    }

    const walk = (abs: string): void => {
        if (excludeSet.has(abs) || isHidden(abs)) return
        if (!fs.existsSync(abs)) return
        if (fs.statSync(abs).isDirectory()) {
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
