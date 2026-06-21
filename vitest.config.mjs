import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['xserver-vps-renew.mjs'],
    },
  },
});
