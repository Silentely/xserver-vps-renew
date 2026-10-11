import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['xserver-vps-renew.mjs', 'src/**/*.mjs'],
      thresholds: {
        // 按当前实际水位（约 67%）收紧，保留少量余量，防止覆盖率回归
        branches: 60,
        functions: 65,
        lines: 60,
        statements: 60,
      },
    },
  },
});
