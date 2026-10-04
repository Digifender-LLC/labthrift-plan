# Labthrift Plan

Personal lab notebook with a static frontend, Hono Worker and D1 storage.

## Design documentation

[Product, requirements and architecture documents](docs/design/README.md) cover the frontend, supporting backend and the Runs-to-ByteRush consolidation. Release evidence is tracked separately from design intent.

[Universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md) sequences work across all three products, with dependencies, acceptance criteria, and coverage of all 100 numbered requirements.

## Checks

Contract checks run the real Worker under `wrangler dev --local` against a throwaway D1 directory, with software passkeys for the API and a Chromium virtual authenticator for the browser. They never touch the production database, domain or accounts.

```sh
npm ci
npx playwright-core install chromium   # once, for the browser checks
npm test                               # or: npm run test:api / npm run test:browser
```

Node 22.13 or newer is required (`node:sqlite` is used to inspect the disposable database). Set `PLAN_TEST_CHROMIUM` to use an existing Chromium binary instead of installing one. The same checks run in GitHub Actions on every pull request. Physical passkey devices and the production origins still need the manual checks listed in [verification](docs/design/verification-2026-10-04.md).
