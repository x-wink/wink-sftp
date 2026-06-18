// 仅供 e2e 测试：进程内起一个 SSH/SFTP 服务端，绑定 127.0.0.1 随机端口、接受任意认证，
// SFTP 直接透传到真实文件系统、exec 直接跑 /bin/sh。因「远程路径」用的就是本机临时目录，
// 故无需 chroot 转换。切勿用于生产——它故意不做任何鉴权与隔离。
import { Server, utils } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'

const { STATUS_CODE, flagsToString } = utils.sftp

/**
 * 生成一把测试用 RSA 私钥（PEM/PKCS8）。
 * 用 node:crypto 而非 ssh2 的 `utils.generateKeyPairSync('ed25519')`——后者偶发产出
 * ssh2 自身无法解析的 OpenSSH 私钥（`Malformed OpenSSH private key`），会让 e2e 随机失败。
 * RSA PEM 被 ssh2 服务端 hostKey 与客户端 privateKey 稳定接受。仅测试用。
 */
export const generateTestKey = (): string =>
    generateKeyPairSync('rsa', {
        modulusLength: 2048,
        // ssh2 接受 PKCS1 PEM（`BEGIN RSA PRIVATE KEY`），不接受 PKCS8（`BEGIN PRIVATE KEY`）
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey

interface FileHandle {
    type: 'file'
    fd: number
}
interface DirHandle {
    type: 'dir'
    location: string
    done: boolean
}

const toAttrs = (st: fs.Stats) => ({
    mode: st.mode, // 含类型位，客户端据此还原 isDirectory()/isFile()
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
})

export interface TestServer {
    port: number
    close: () => Promise<void>
}

/** 起一个一次性测试 SSH 服务端，resolve 出监听端口与关闭函数。 */
export const startTestServer = (): Promise<TestServer> =>
    new Promise((resolve) => {
        const hostKey = generateTestKey()
        const server = new Server({ hostKeys: [hostKey] }, (client) => {
            client.on('authentication', (ctx) => {
                // 拒绝 none，逼客户端走它配置的 password / publickey，从而真实验证两条认证路径
                if (ctx.method === 'none') return ctx.reject(['password', 'publickey'])
                ctx.accept()
            })
            client.on('ready', () => {
                client.on('session', (acceptSession) => {
                    const session = acceptSession()
                    session.on('exec', (acceptExec, _reject, info) => {
                        const stream = acceptExec()
                        const cp = spawn('/bin/sh', ['-c', info.command])
                        cp.stdout.on('data', (d) => stream.write(d))
                        cp.stderr.on('data', (d) => stream.stderr.write(d))
                        cp.on('close', (code) => {
                            stream.exit(code ?? 0)
                            stream.end()
                        })
                    })
                    session.on('sftp', (acceptSftp) => {
                        const sftp = acceptSftp()
                        const handles = new Map<number, FileHandle | DirHandle>()
                        let nextId = 0
                        const makeHandle = (state: FileHandle | DirHandle): Buffer => {
                            const id = nextId++
                            handles.set(id, state)
                            const buf = Buffer.alloc(4)
                            buf.writeUInt32BE(id, 0)
                            return buf
                        }
                        const getHandle = (buf: Buffer) => handles.get(buf.readUInt32BE(0))

                        sftp.on('REALPATH', (reqid, location) => {
                            let resolved: string
                            try {
                                resolved = fs.realpathSync(location)
                            } catch {
                                resolved = path.resolve(location)
                            }
                            sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as never }])
                        })
                        sftp.on('OPEN', (reqid, filename, flags, attrs) => {
                            fs.open(filename, flagsToString(flags) || 'r', attrs?.mode ?? 0o666, (err, fd) => {
                                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
                                sftp.handle(reqid, makeHandle({ type: 'file', fd }))
                            })
                        })
                        sftp.on('READ', (reqid, handle, offset, length) => {
                            const h = getHandle(handle)
                            if (h?.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
                            const buf = Buffer.alloc(length)
                            fs.read(h.fd, buf, 0, length, offset, (err, bytesRead) => {
                                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
                                if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF)
                                sftp.data(reqid, buf.subarray(0, bytesRead))
                            })
                        })
                        sftp.on('WRITE', (reqid, handle, offset, data) => {
                            const h = getHandle(handle)
                            if (h?.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
                            fs.write(h.fd, data, 0, data.length, offset, (err) =>
                                sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK)
                            )
                        })
                        sftp.on('FSTAT', (reqid, handle) => {
                            const h = getHandle(handle)
                            if (h?.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
                            fs.fstat(h.fd, (err, st) =>
                                err ? sftp.status(reqid, STATUS_CODE.FAILURE) : sftp.attrs(reqid, toAttrs(st))
                            )
                        })
                        sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
                        sftp.on('CLOSE', (reqid, handle) => {
                            const id = handle.readUInt32BE(0)
                            const h = handles.get(id)
                            if (h?.type === 'file') fs.close(h.fd, () => {})
                            handles.delete(id)
                            sftp.status(reqid, STATUS_CODE.OK)
                        })
                        const onStat = (reqid: number, location: string) =>
                            fs.stat(location, (err, st) =>
                                err ? sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) : sftp.attrs(reqid, toAttrs(st))
                            )
                        sftp.on('STAT', onStat)
                        sftp.on('LSTAT', onStat)
                        sftp.on('SETSTAT', (reqid, location, attrs) => {
                            try {
                                if (attrs?.atime != null && attrs?.mtime != null) {
                                    fs.utimesSync(location, attrs.atime, attrs.mtime)
                                }
                                if (attrs?.mode != null) fs.chmodSync(location, attrs.mode)
                                sftp.status(reqid, STATUS_CODE.OK)
                            } catch {
                                sftp.status(reqid, STATUS_CODE.FAILURE)
                            }
                        })
                        sftp.on('MKDIR', (reqid, location) =>
                            fs.mkdir(location, { recursive: true }, (err) =>
                                sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK)
                            )
                        )
                        sftp.on('OPENDIR', (reqid, location) => {
                            fs.stat(location, (err, st) => {
                                if (err || !st.isDirectory()) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                                sftp.handle(reqid, makeHandle({ type: 'dir', location, done: false }))
                            })
                        })
                        sftp.on('READDIR', (reqid, handle) => {
                            const h = getHandle(handle)
                            if (h?.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
                            if (h.done) return sftp.status(reqid, STATUS_CODE.EOF)
                            h.done = true
                            fs.readdir(h.location, (err, names) => {
                                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
                                const list = names.map((name) => {
                                    const st = fs.statSync(path.join(h.location, name))
                                    return { filename: name, longname: name, attrs: toAttrs(st) as never }
                                })
                                sftp.name(reqid, list)
                            })
                        })
                    })
                })
            })
        })
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port
            resolve({
                port,
                close: () => new Promise<void>((res) => server.close(() => res())),
            })
        })
    })
