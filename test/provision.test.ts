import { describe, it, expect } from 'vitest'
import { versionSatisfies, normalizeDesired, parseConfigs, RECIPES } from '../src/provision'

describe('versionSatisfies', () => {
    it('点分前缀匹配：目标为检测版本的前缀段即满足', () => {
        expect(versionSatisfies('20', '20.11.0')).toBe(true)
        expect(versionSatisfies('3.11', '3.11.5')).toBe(true)
        expect(versionSatisfies('20.11.0', '20.11.0')).toBe(true)
    })
    it('前缀不匹配则不满足', () => {
        expect(versionSatisfies('20', '18.19.0')).toBe(false)
        expect(versionSatisfies('3.11', '3.9.7')).toBe(false)
    })
    it('剥离 vendor 后缀比数字段（sdkman 标识）', () => {
        expect(versionSatisfies('17.0.9-tem', '17.0.9')).toBe(true)
        expect(versionSatisfies('17', '17.0.9')).toBe(true)
    })
    it('检测为 null / 目标无数字段 → false', () => {
        expect(versionSatisfies('20', null)).toBe(false)
        expect(versionSatisfies('true', '24.0.7')).toBe(false)
    })
})

describe('normalizeDesired', () => {
    it('false 关闭组件返回 null', () => {
        expect(normalizeDesired('docker', false)).toBeNull()
    })
    it('true → "true"（布尔开关组件）', () => {
        expect(normalizeDesired('docker', true)).toBe('true')
    })
    it('字符串/数字 → 字符串', () => {
        expect(normalizeDesired('nodejs', '20')).toBe('20')
        expect(normalizeDesired('nodejs', 20)).toBe('20')
    })
    it('对象取 version 字段', () => {
        expect(normalizeDesired('redis', { version: 7, mode: 'docker' })).toBe('7')
    })
    it('对象缺 version → 抛错', () => {
        expect(() => normalizeDesired('redis', { mode: 'docker' } as never)).toThrow(/version/)
    })
    it('空字符串 / 纯空白版本 → 抛错（防 nvm install ""）', () => {
        expect(() => normalizeDesired('nodejs', '')).toThrow(/为空/)
        expect(() => normalizeDesired('nodejs', '   ')).toThrow(/为空/)
    })
})

describe('parseConfigs（守护式写配置声明）', () => {
    it('缺省 configure → 空数组', () => {
        expect(parseConfigs({})).toEqual([])
        expect(parseConfigs({ mode: 'docker' })).toEqual([])
    })
    it('解析 file/remote 与可选 validate/reload', () => {
        const specs = parseConfigs({
            configure: [
                {
                    file: './nginx.conf',
                    remote: '/etc/nginx/nginx.conf',
                    validate: 'nginx -t',
                    reload: 'systemctl reload nginx',
                },
                { file: './redis.conf', remote: '/etc/redis/redis.conf' },
            ],
        })
        expect(specs).toHaveLength(2)
        expect(specs[0]).toEqual({
            file: './nginx.conf',
            remote: '/etc/nginx/nginx.conf',
            validate: 'nginx -t',
            reload: 'systemctl reload nginx',
        })
        expect(specs[1]).toEqual({ file: './redis.conf', remote: '/etc/redis/redis.conf' })
    })
    it('configure 非数组 → 抛错', () => {
        expect(() => parseConfigs({ configure: { file: 'a', remote: 'b' } })).toThrow(/数组/)
    })
    it('缺 file / 缺 remote → 抛错', () => {
        expect(() => parseConfigs({ configure: [{ remote: '/x' }] })).toThrow(/file/)
        expect(() => parseConfigs({ configure: [{ file: './a' }] })).toThrow(/remote/)
        expect(() => parseConfigs({ configure: [{ file: '  ', remote: '/x' }] })).toThrow(/file/)
    })
    it('validate/reload 非字符串 → 抛错', () => {
        expect(() => parseConfigs({ configure: [{ file: './a', remote: '/x', validate: 1 }] })).toThrow(/validate/)
        expect(() => parseConfigs({ configure: [{ file: './a', remote: '/x', reload: true }] })).toThrow(/reload/)
    })
    it('file/remote 前后空白被裁剪（避免带空格路径的迷惑性失败）', () => {
        const specs = parseConfigs({ configure: [{ file: '  ./a.conf  ', remote: '  /etc/a.conf  ' }] })
        expect(specs[0]).toEqual({ file: './a.conf', remote: '/etc/a.conf' })
    })
})

describe('recipe: nodejs (nvm)', () => {
    const r = RECIPES.nodejs
    it('parse 取 node --version 的 vX.Y.Z', () => {
        expect(r.parse('v20.11.0\n')).toEqual({ installed: true, version: '20.11.0' })
        expect(r.parse('')).toEqual({ installed: false, version: null })
    })
    it('已满足目标版本 → satisfied、无步骤', () => {
        expect(r.converge('20', { installed: true, version: '20.11.0' })).toEqual({ satisfied: true, steps: [] })
    })
    it('未安装/版本不符 → 装 nvm + 装 node 两步，版本经 shellQuote', () => {
        const plan = r.converge('20', { installed: false, version: null })
        expect(plan.satisfied).toBe(false)
        expect(plan.steps).toHaveLength(2)
        expect(plan.steps[1].command).toContain("nvm install '20'")
        expect(plan.steps[1].command).toContain("nvm alias default '20'")
    })
})

describe('recipe: jdk (sdkman)', () => {
    const r = RECIPES.jdk
    it('parse 取 java -version 引号内版本（openjdk / 老 1.8 两式）', () => {
        expect(r.parse('openjdk version "17.0.9" 2023-10-17')).toEqual({ installed: true, version: '17.0.9' })
        // 老式 1.8.0_292 归一为 8.0.292（旧 1.X 编号的 X 才是真实大版本，下划线补丁位转点）
        expect(r.parse('java version "1.8.0_292"')).toEqual({ installed: true, version: '8.0.292' })
        expect(r.parse('')).toEqual({ installed: false, version: null })
    })
    it('已满足（前缀匹配）→ satisfied', () => {
        expect(r.converge('17', { installed: true, version: '17.0.9' }).satisfied).toBe(true)
    })
    it('旧式 Java 8 归一后 jdk:8 能命中已装版本（幂等，不重装）', () => {
        const state = r.parse('openjdk version "1.8.0_292"')
        expect(state.version).toBe('8.0.292')
        expect(r.converge('8', state).satisfied).toBe(true)
    })
    it('未满足 → 装 sdkman + sdk install java，版本经 shellQuote', () => {
        const plan = r.converge('17.0.9-tem', { installed: false, version: null })
        expect(plan.steps).toHaveLength(2)
        expect(plan.steps[1].command).toContain("sdk install java '17.0.9-tem'")
    })
})

describe('recipe: python (pyenv)', () => {
    const r = RECIPES.python
    it('parse 取 Python X.Y.Z', () => {
        expect(r.parse('Python 3.11.9\n')).toEqual({ installed: true, version: '3.11.9' })
        expect(r.parse('python: command not found')).toEqual({ installed: false, version: null })
    })
    it('未满足 → 装 pyenv + install -s + global，版本经 shellQuote', () => {
        const plan = r.converge('3.11.9', { installed: true, version: '3.9.7' })
        expect(plan.satisfied).toBe(false)
        expect(plan.steps[1].command).toContain("pyenv install -s '3.11.9'")
        expect(plan.steps[1].command).toContain("pyenv global '3.11.9'")
    })
})

describe('recipe: docker', () => {
    const r = RECIPES.docker
    it('parse 取 Docker version X.Y.Z', () => {
        expect(r.parse('Docker version 24.0.7, build afdd53b')).toEqual({ installed: true, version: '24.0.7' })
        expect(r.parse('')).toEqual({ installed: false, version: null })
    })
    it('已安装即满足（布尔开关，不比版本）', () => {
        expect(r.converge('true', { installed: true, version: '24.0.7' })).toEqual({ satisfied: true, steps: [] })
    })
    it('未安装 → 官方脚本一步', () => {
        const plan = r.converge('true', { installed: false, version: null })
        expect(plan.steps).toHaveLength(1)
        expect(plan.steps[0].command).toContain('get.docker.com')
    })
})

describe('recipe detect 命令稳定（防回归改动）', () => {
    it('docker detect 以 || true 兜底退出码', () => {
        expect(RECIPES.docker.detect({})).toBe('docker --version 2>/dev/null || true')
    })
})

describe('recipe: nginx（原生，已装即满足）', () => {
    const r = RECIPES.nginx
    it('parse 取 nginx/X.Y.Z', () => {
        expect(r.parse('nginx version: nginx/1.24.0')).toEqual({ installed: true, version: '1.24.0' })
        expect(r.parse('')).toEqual({ installed: false, version: null })
    })
    it('已安装即满足；未安装 → apt 安装 + nginx -t 校验', () => {
        expect(r.converge('latest', { installed: true, version: '1.24.0' }, {}).satisfied).toBe(true)
        const plan = r.converge('latest', { installed: false, version: null }, {})
        expect(plan.steps).toHaveLength(2)
        expect(plan.steps[0].command).toContain('apt-get install -y nginx')
        expect(plan.steps[1].command).toBe('nginx -t')
    })
})

describe('recipe: redis（docker|native）', () => {
    const r = RECIPES.redis
    it('parse 取 Redis server v=X.Y.Z', () => {
        expect(r.parse('Redis server v=7.0.11 sha=00000000:0')).toEqual({ installed: true, version: '7.0.11' })
    })
    it('docker detect 走容器内 redis-server；native 走本机', () => {
        expect(r.detect({ mode: 'docker' })).toContain('docker exec wink-redis redis-server --version')
        expect(r.detect({})).toBe('redis-server --version 2>/dev/null || true')
    })
    it('docker 模式按版本匹配；未满足 → run 容器（含 maxmemory）+ ping 校验，值经 shellQuote', () => {
        expect(r.converge('7', { installed: true, version: '7.0.11' }, { mode: 'docker' }).satisfied).toBe(true)
        const plan = r.converge('7', { installed: false, version: null }, { mode: 'docker', maxmemory: '512mb' })
        expect(plan.steps[0].command).toContain('docker run -d --name wink-redis')
        expect(plan.steps[0].command).toContain("redis:'7'") // desired 经 shellQuote（shell 去引号后传 redis:7）
        expect(plan.steps[0].command).toContain("--maxmemory '512mb'")
        expect(plan.steps[1].command).toBe('docker exec wink-redis redis-cli ping')
    })
    it('native 模式已装即满足；未装 → apt 安装 + ping', () => {
        expect(r.converge('7', { installed: true, version: '6.0.16' }, {}).satisfied).toBe(true)
        const plan = r.converge('7', { installed: false, version: null }, {})
        expect(plan.steps[0].command).toContain('apt-get install -y redis-server')
        expect(plan.steps[plan.steps.length - 1].command).toBe('redis-cli ping')
    })
})

describe('recipe: mysql（docker|native，rootPassword 脱敏）', () => {
    const r = RECIPES.mysql
    it('parse 取 Ver X.Y.Z', () => {
        expect(r.parse('mysqld  Ver 8.0.35 for Linux on x86_64')).toEqual({ installed: true, version: '8.0.35' })
    })
    it('docker 模式：run 容器命令含明文密码（脱敏由编排层按 secret 值统一处理）', () => {
        const plan = r.converge('8', { installed: false, version: null }, { mode: 'docker', rootPassword: 's3cret' })
        expect(plan.steps[0].command).toContain("MYSQL_ROOT_PASSWORD='s3cret'")
        expect(plan.steps[0].command).toContain("mysql:'8'")
        expect(plan.steps[1].command).toBe('docker exec wink-mysql mysqladmin ping')
    })
    it('docker 模式缺 rootPassword → 抛错', () => {
        expect(() => r.converge('8', { installed: false, version: null }, { mode: 'docker' })).toThrow(/rootPassword/)
    })
    it('native 模式：apt 安装 + 设密码 + ping', () => {
        const plan = r.converge('8', { installed: false, version: null }, { rootPassword: 'pw' })
        expect(plan.steps[0].command).toContain('apt-get install -y mysql-server')
        expect(plan.steps.some((s) => s.command.includes("mysqladmin -u root password 'pw'"))).toBe(true)
    })
})
