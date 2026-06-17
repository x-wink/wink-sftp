import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            // index.ts 为 Commander CLI 接线层，靠端到端冒烟覆盖，不纳入单测覆盖率门槛
            exclude: ['src/index.ts'],
            reporter: ['text', 'json-summary'],
            // 地板设在当前覆盖率略下方，作为防退化门槛
            thresholds: {
                statements: 90,
                branches: 85,
                functions: 85,
                lines: 90,
            },
        },
    },
})
