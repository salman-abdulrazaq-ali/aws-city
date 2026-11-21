import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // The heaviest tests (zoning every real city, rendering the linking steps) take ~5 s when the whole suite runs in
    // parallel on a laptop; vitest's 5 s default then fails them at random. 20 s still catches a real hang.
    testTimeout: 20_000,
  },
});
