# Labthrift Plan

A personal home-lab notebook at [plan.labthrift.com](https://plan.labthrift.com): what you own, which services run where, a rack sketch, house hostnames, later buys and a first-weekend checklist that links to the [Labthrift guides](https://labthrift.com/guides/). Capacity and power numbers are your own estimates, not live measurements.

It is a static frontend (`public/`) served by a Hono Worker (`src/worker/index.ts`) with D1 storage, deployed as the `lab-plan` Worker.

## Accounts and passkeys

Sign-in is a username plus a passkey. There is no email and no account recovery, so add a second passkey or enroll another device from Settings. Plan accounts are separate from ByteRush: passkeys use the shared `labthrift.com` RP ID, so a device may offer them on other Labthrift apps, but Plan's users, sessions and notebooks live only in Plan's database.

Notebooks autosave. If another device saved first, the app shows a conflict and lets you reload or force your version. Export and import use versioned JSON (schema 2; v1 and legacy files import too). Importing replaces the whole notebook and never brings in credentials.

## Local development

```sh
npm ci
npm run db:migrate:local
npm run dev
```

`npm run deploy` publishes the Worker. Apply new migrations with `npm run db:migrate:remote` first if a release adds any.

## Checks

Contract checks run the real Worker under `wrangler dev --local` against a throwaway D1 directory, with software passkeys for the API and a Chromium virtual authenticator for the browser. They never touch the production database, domain or accounts.

```sh
npm ci
npx playwright-core install chromium   # once, for the browser checks
npm test                               # or: npm run test:api / npm run test:browser
```

Node 22.13 or newer is required (`node:sqlite` is used to inspect the disposable database). Set `PLAN_TEST_CHROMIUM` to use an existing Chromium binary instead of installing one. The same checks run in GitHub Actions on every pull request. Physical passkey devices and the production origins still need the manual checks listed in [verification](docs/design/verification-2026-10-04.md).

## Design documentation

[Product, requirements and architecture documents](docs/design/README.md) cover the frontend, supporting backend and the Runs-to-ByteRush consolidation. Release evidence is tracked separately from design intent in [release status](docs/design/release-status.md).

[Universal completion roadmap](https://github.com/zemdregon/tech-dose/blob/main/docs/ROADMAP.md) sequences work across all three products, with dependencies, acceptance criteria, and coverage of all numbered requirements.
