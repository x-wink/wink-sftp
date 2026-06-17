import path from 'node:path'

/** 相对 `process.cwd()` 解析本地路径为绝对路径。 */
export const resolveLocal = (...paths: string[]): string => path.resolve(process.cwd(), ...paths)

/**
 * 拼接远程（POSIX）路径：把各段的反斜杠归一为 `/` 后用 posix 语义 join。
 * 远程路径必须始终用 `/`，绝不能用宿主机的 `path.sep`。
 */
export const linuxPath = (...paths: string[]): string => path.posix.join(...paths.map((p) => p.replaceAll('\\', '/')))

/**
 * 远程路径是否应被视为目录：
 * - 待传文件多于一个；或
 * - 仅一个文件且该文件有扩展名、而远程路径没有扩展名。
 *
 * 文件列表为空时返回 false——修正了旧实现对空列表取 `extname(files[0])` 的崩溃。
 */
export const remoteIsDir = (files: string[], remote: string): boolean => {
    if (files.length === 0) return false
    if (files.length > 1) return true
    return Boolean(path.extname(files[0])) && !path.extname(remote)
}

/** 计算单个本地文件对应的远程目标路径（POSIX）。 */
export const buildRemoteTarget = (
    file: string,
    options: { local: string; remote: string; remoteIsDir: boolean; flat: boolean }
): string => {
    const { local, remote, remoteIsDir: isDir, flat } = options
    if (!isDir) return remote
    if (flat) return linuxPath(remote, path.basename(file))
    return linuxPath(remote, path.relative(local, file))
}

/** 计算单个本地目录对应的远程目录路径（POSIX），用于 `mkdir -p`。 */
export const buildRemoteDir = (dir: string, local: string, remote: string): string =>
    linuxPath(remote, path.relative(local, dir))
