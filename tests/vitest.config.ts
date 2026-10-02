// [test-support] Test track: drivers/contract/storage/northbound (test implementer #2).
// Self-contained vitest project; activates fully once the implementation branch merges.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 20_000,
    include: ['contract/**/*.spec.ts', 'drivers/**/*.spec.ts', 'storage/**/*.spec.ts', 'northbound/**/*.spec.ts'],
    // Suites that import @orch/* cannot resolve before the implementation branch
    // merges; they are expected to fail on the test branch and green afterwards.
  },
});
