import { describe, it, expect } from 'vitest'
import { parseLoadavg, parseMeminfo, parseDf } from '../src/ops'

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
    it('缺 MemAvailable 返回 null', () => {
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
