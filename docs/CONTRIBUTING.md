# Contributing

Thanks for your interest. This is a small project — issues and PRs are welcome.

## Before you open a PR

1. Fork and branch from `main`.
2. `npm install` (this also installs the lefthook git hooks via the `prepare` script).
3. Make your changes. Local hooks will run on commit/push:
   - **pre-commit**: Biome (lint + format + organize-imports) on staged files, plus `npm run typecheck` if any `.ts` file changed.
   - **pre-push**: full `typecheck`, `npm test`, and `npm run check`.
4. CI runs the same three checks on every PR — if it's green locally it should be green in CI.

## What I'm looking for

- **Bug fixes** — especially anything in the OAuth / sync / token-refresh path.
- **Provider parity** — Outlook (Microsoft Graph) and IMAP adapters. The shape is sketched in [src/providers/](src/providers/) but Gmail is the only fully-wired provider today.
- **Tests** — particularly integration coverage for the sync pipeline against a real Postgres + a fake Pinecone.
- **Attachment extraction** — see [TECH-SPEC.md §13](TECH-SPEC.md).

## What to skip

- Drive-by formatting PRs. Biome runs on commit; the tree should already be clean.
- Adding new vector DB providers before the existing Pinecone path is well-tested.
- Renaming or restructuring without an issue first — the layout is intentional.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and your `node --version`. Redact any tokens before pasting logs.

## Security

See [SECURITY.md](SECURITY.md). Do **not** open public issues for vulnerabilities.
