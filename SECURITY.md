# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Contact the maintainer,
[@zemdregon](https://github.com/zemdregon), directly on GitHub with:

- what is affected (URL, endpoint, or file),
- steps to reproduce or a proof of concept,
- the impact you expect.

You should get an acknowledgement within a few days. Please give us a reasonable
chance to fix the issue before disclosing it.

## Supported versions

Only the current `main` branch, which is what is deployed, receives fixes.

## Automated checks

Every pull request and a weekly scheduled run check dependencies with `npm audit`
and scan the git history for leaked secrets with gitleaks
(`.github/workflows/security.yml`). Dependabot opens update PRs weekly.
