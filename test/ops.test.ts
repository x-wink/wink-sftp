import { describe, it, expect } from 'vitest'
import { parseLoadavg, parseMeminfo, parseDf, parsePs, buildServiceCommand, isWriteAction } from '../src/ops'

describe('parseLoadavg', () => {
    it('取前三个数为 [1,5,15] 负载', () => {
        expect(parseLoadavg('0.52 0.58 0.59 1/823 12345')).toEqual([0.52, 0.58, 0.59])
    })
    it('字段不足/非数字返回 null', () => {
        expect(parseLoadavg('')).toBeNull()
        expect(parseLoadavg('x y z')).toBeNull()
    })
})

describe('parseMeminfo', () => {
    const FIXTURE = ['MemTotal:       16384000 kB', 'MemFree:         2048000 kB', 'MemAvailable:    8192000 kB'].join(
        '\n'
    )
    it('用 MemTotal 与 MemAvailable 算已用', () => {
        expect(parseMeminfo(FIXTURE)).toEqual({ totalKb: 16384000, usedKb: 8192000, availableKb: 8192000 })
    })
    it('无 MemAvailable 时回退 MemFree（老内核）', () => {
        expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 300 kB')).toEqual({
            totalKb: 1000,
            usedKb: 700,
            availableKb: 300,
        })
    })
    it('连 MemFree 都缺才返回 null', () => {
        expect(parseMeminfo('MemTotal:  100 kB')).toBeNull()
    })
})

describe('parseDf', () => {
    const FIXTURE = [
        'Filesystem     1024-blocks      Used Available Capacity Mounted on',
        '/dev/sda1         51200000  20480000  30720000      40% /',
        '/dev/sdb1        102400000  10240000  92160000      10% /data',
        'tmpfs              8192000         0   8192000       0% /run',
    ].join('\n')
    it('跳过表头，解析每个挂载点用量', () => {
        const disks = parseDf(FIXTURE)
        expect(disks).toHaveLength(3)
        expect(disks[0]).toEqual({
            filesystem: '/dev/sda1',
            sizeKb: 51200000,
            usedKb: 20480000,
            availKb: 30720000,
            usePercent: 40,
            mountedOn: '/',
        })
        expect(disks[1].mountedOn).toBe('/data')
    })
    it('空输入返回空数组', () => {
        expect(parseDf('')).toEqual([])
    })
})

describe('parsePs', () => {
    const FIXTURE = [
        '  PID  PPID USER     %CPU %MEM   RSS COMMAND',
        '    1     0 root      0.0  0.1  1024 /sbin/init',
        '  812     1 www-data  1.5  2.3 51200 nginx: worker process',
        '  900     1 node     12.0  5.0 88000 node /app/server.js --port 3000',
    ].join('\n')
    it('跳过表头，解析每个进程；末列命令行保留空格', () => {
        const procs = parsePs(FIXTURE)
        expect(procs).toHaveLength(3)
        expect(procs[0]).toEqual({
            pid: 1,
            ppid: 0,
            user: 'root',
            cpu: 0,
            mem: 0.1,
            rssKb: 1024,
            command: '/sbin/init',
        })
        expect(procs[1].command).toBe('nginx: worker process')
        expect(procs[2].command).toBe('node /app/server.js --port 3000')
    })
    it('空输入返回空数组', () => {
        expect(parsePs('')).toEqual([])
    })
})

describe('buildServiceCommand', () => {
    it('systemd：status 用 --no-pager，写动作直接映射，名称经 shellQuote 转义', () => {
        expect(buildServiceCommand('systemd', 'status', 'nginx')).toBe("systemctl status --no-pager 'nginx'")
        expect(buildServiceCommand('systemd', 'restart', 'nginx')).toBe("systemctl restart 'nginx'")
        expect(buildServiceCommand('systemd', 'restart', 'a; rm -rf /')).toBe("systemctl restart 'a; rm -rf /'")
    })
    it('pm2：status 用 describe，写动作直接映射', () => {
        expect(buildServiceCommand('pm2', 'status', 'api')).toBe("pm2 describe 'api'")
        expect(buildServiceCommand('pm2', 'reload', 'api')).toBe("pm2 reload 'api'")
    })
    it('docker：status 用 ps --filter，写动作映射，reload 不支持则抛', () => {
        expect(buildServiceCommand('docker', 'status', 'redis')).toBe("docker ps --filter name='redis'")
        expect(buildServiceCommand('docker', 'restart', 'redis')).toBe("docker restart 'redis'")
        expect(() => buildServiceCommand('docker', 'reload', 'redis')).toThrow()
    })
    it('未知管理器（强转）：default 分支抛错', () => {
        expect(() => buildServiceCommand('k8s' as never, 'status', 'x')).toThrow(/未知服务管理器/)
    })
})

describe('isWriteAction', () => {
    it('status 只读，其余为写', () => {
        expect(isWriteAction('status')).toBe(false)
        expect(isWriteAction('start')).toBe(true)
        expect(isWriteAction('stop')).toBe(true)
        expect(isWriteAction('restart')).toBe(true)
        expect(isWriteAction('reload')).toBe(true)
    })
})
