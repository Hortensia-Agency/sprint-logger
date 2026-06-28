# Sprint Logger SDKs

Client SDKs for **Sprint Signals** — error capture for web, Node, and React Native apps. Errors are grouped, enriched with non-identifying device/OS/browser/timezone context, and surfaced in your Sprint project's inbox.

| Package | Runtime | Install |
|---|---|---|
| [`@sprint-logger/web`](./packages/web) | Browser (Next.js, Vite, CRA, Astro, …) | `npm i @sprint-logger/web` |
| [`@sprint-logger/node`](./packages/node) | Node services | `npm i @sprint-logger/node` |
| [`@sprint-logger/rn`](./packages/rn) | React Native / Expo | `npm i @sprint-logger/rn` |

Plain-HTML / no-build sites don't need a package — use the hosted script:
`<script src="https://sprint.hortensia-agency.com/signals.js" data-sprint-signals-key="sk_sig_…" defer></script>`

## Quick start (web)

```ts
import { init, capture } from "@sprint-logger/web";

init("sk_sig_xxx", { release: "1.2.3" });   // once, at app start

// uncaught errors are captured automatically; for handled ones:
try { await chargeCard(order); }
catch (e) { capture(e, { route: "/checkout", severity: "high" }); }
```

## What it sends

Pseudonymous only — **no PII, ever**. Each event carries the message, normalized stack, an opaque per-browser `userToken` (never an email/name/IP), the route/release, and non-identifying environment context (platform, OS, browser, device model, timezone, locale, viewport, network, `handled`, error type). The server rejects anything that looks like an email or IP.

The `sk_sig_…` key is a **project selector**, not a secret — it ships in client code by design and grants only "send errors to this one project." Mint it in your Sprint project's Signals settings.

## Security & supply chain

- Published with **npm provenance** (`--provenance`) via GitHub Actions **trusted publishing (OIDC)** — no long-lived npm token exists. Verify any release on npm shows the provenance badge linking back to this repo + commit.
- Packages ship compiled `dist/` (`.js` + `.d.ts`) only; no build scripts run on install.
- Zero runtime dependencies.

## Repo layout

This is an independent public repo, also embedded in the private Sprint monorepo as a git submodule. The server (ingest endpoint, contract, inbox) lives in Sprint and is **not** here.

## License

MIT
