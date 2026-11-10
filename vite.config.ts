import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base: the build works from any subpath, including
  // https://<user>.github.io/seismic-navigator/
  base: './',
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
