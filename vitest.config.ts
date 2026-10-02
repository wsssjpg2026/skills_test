import { defineConfig } from 'vitest/config';

// doc-derived test stub — rewired to @orch/* at merge.
// Every test file boots its own kernel on an ephemeral port with a temp data dir,
// so full file parallelism is safe (spec Testing Decisions: black-box via public API only).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 10_000,
    // WAL/engine timing tests rely on short configured timeouts, never on wall-clock luck.
    sequence: { concurrent: false },
  },
});
