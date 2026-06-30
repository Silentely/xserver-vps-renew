import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['xserver-vps-renew.mjs', 'src/**/*.mjs'],
      thresholds: {
        branches: 25,
        functions: 30,
        lines: 30,
        statements: 30,
      },
    },
  },
});
