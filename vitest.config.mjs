import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['xserver-vps-renew.mjs', 'src/**/*.mjs'],
      thresholds: {
        branches: 25,
        functions: 28,
        lines: 28,
        statements: 28,
      },
    },
  },
});
