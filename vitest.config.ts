import { defineConfig } from 'vitest/config';

// Two vitest projects (architecture doc §6.4 / Q1):
//  - `embedded`: runs everywhere (kernel + embedded storage; zero containers).
//  - `db`: Postgres/Timescale tests; requires POSTGRES_TEST_DSN. Run by the CI
//    `db` job (GitHub Actions service container) or locally with a DSN set.
//    Filled by ticket #9; the empty skeleton must pass (passWithNoTests).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'embedded',
          environment: 'node',
          include: [
            'packages/*/test/**/*.test.ts',
            'packages/drivers/*/test/**/*.test.ts',
            'packages/simulators/*/test/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', 'packages/storage-timescale/**'],
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['packages/storage-timescale/test/**/*.test.ts'],
        },
      },
    ],
  },
});
