# Changelog

## 0.3.1

- No token no longer throws under `NODE_ENV=production`. `config()` prints one line and keeps the existing environment, so the integration can be merged before every host has a token. Adding `SPRINT_TOKEN` to a host switches it over; with a token present, every failure still throws.
- New `SPRINT_ENV_REQUIRED=true` / `config({ required: true })` restores the old behaviour: a missing token throws.
- The environment now wins over Sprint for machine tokens too: a variable the host already defines is kept, and Sprint fills in the rest. Delete a key from the host to move it to Sprint. `preserveEnv`, `SPRINT_PRESERVE_ENV` and `--preserve-env` no longer do anything and are still accepted.
- In a Coolify build that passes `SPRINT_TOKEN` as a plain build argument, which prints it in the deploy log, the loader warns to switch the app's Build secrets to Docker BuildKit secrets.
- The CLI still exits 1 without a token: `sprint-env run` / `pull`.

## 0.3.0

- Standalone-safe worker (Next's `output: "standalone"`, bundled `instrumentation.ts`) and build / run time phases.
