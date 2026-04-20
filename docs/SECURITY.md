# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue.** Email `security@rebarlabs.io` with:

- A description of the issue and its impact.
- Steps to reproduce (or a proof-of-concept).
- Affected commit / version.
- Whether the issue is already public anywhere.

You should get an acknowledgement within 5 business days. If the report is in scope and reproducible, we'll work with you on a fix and coordinate disclosure.

## Scope

In scope:

- The API server (`src/`), MCP wrapper (`mcp/`), and helper scripts (`scripts/`).
- Anything that handles OAuth tokens, JWTs, or could leak email content across user namespaces.

Out of scope:

- Self-inflicted misconfiguration (e.g. running with `JWT_SECRET=replace-me`).
- Findings in third-party dependencies — please report those upstream.
- DoS via unbounded ingestion (cap is documented and tunable).

## What this project handles that you should know about

- **OAuth refresh tokens for Gmail/Outlook** — encrypted at rest with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`. If that key leaks, every stored refresh token is compromised.
- **Long-lived JWTs** — minted via `npm run mint-token` for the MCP integration. Treat them like passwords.
- **Per-user namespace isolation** — enforced server-side from the JWT `sub`, never from request bodies. Any path that lets a user influence the namespace is a high-severity bug.
- **Raw email text is never persisted** in Postgres — only metadata + the vector in Pinecone. A bug that writes raw bodies to the DB or logs is a bug.

## What we do not promise

This is a hobbyist / self-hosted project. There is no bug bounty, no SLA, and no guarantee of a fix timeline. Responsible disclosure is appreciated but not contractually rewarded.
