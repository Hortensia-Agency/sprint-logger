# @sprint-logger/env

Load a project's Sprint secrets into `process.env`, the way dotenv loads a `.env` file. Nothing is written to disk.

```sh
pnpm add @sprint-logger/env
```

Put your token in `.env.local` (gitignored). Create it on the project's **Secrets** page:

```sh
SPRINT_TOKEN=sprint_dev_…
```

Then load the secrets once, before anything reads the environment:

```ts
// next.config.ts: covers next dev, next build and next start
import "@sprint-logger/env/config";
```

Next.js also needs it in `instrumentation.ts` (project root, or `src/` if the app uses one). With `output: "standalone"` the production server never runs `next.config`, so this is what loads the secrets when the container starts; elsewhere it's a harmless no-op, since the values are already loaded:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("@sprint-logger/env/config");
}
```

Any other Node app: the same import as the first line of its server entry, or `require("@sprint-logger/env/config")`. Other config files work too (`vite.config.ts`, `astro.config.mjs`).

`config()` is synchronous: it fetches in a short-lived child process, so the values are in `process.env` when the import returns. It runs once per process tree; child processes inherit the values. It works when bundled (Next's instrumentation) and in Next's standalone output, since it needs no file besides itself. Use it in config files, `instrumentation.ts` and server entry points, not in code that runs in the browser.

```ts
import { config } from "@sprint-logger/env";
const rows = config(); // [{ key, source, kind }], never values
```

## Build-time public variables

`NEXT_PUBLIC_*`, `VITE_*` and similar are inlined into the client bundle at build time. With the import in `next.config`, `next build` already has them. Never store a real secret under a public prefix.

## Build time and run time

On the project's Secrets page a variable can be limited to the build or to the running app (Build / run time in its menu). The loader tells Sprint which phase it's pulling for:

1. `SPRINT_PHASE=build|runtime`, when set.
2. The framework command: `next build`, `vite build` → build; `next start`, `vite preview` → runtime; `dev` → everything.
3. A Next.js standalone server (`node server.js`, loaded via `instrumentation.ts`) → runtime.
4. The package script name: `build` → build, `start` → runtime.

When none of these apply, the loader asks for everything. A server started some other way can set `SPRINT_PHASE=runtime` in its environment. Loaders before 0.3.0 always get everything.

## CLI

For non-Node apps and CI steps, wrap the command instead:

- `sprint-env run [--explain] -- <command> [args…]`: start `<command>` with the secrets loaded. Forwards signals and exits with the command's exit code.
- `sprint-env pull`: check access and print what would load, as `KEY SOURCE KIND`. Never prints values.

## Tokens and precedence

A key already in the environment always wins over Sprint's value, whichever token loads it.

**Personal dev token (`sprint_dev_…`)**, one per developer per project, created on the Secrets page:

1. Your shell environment
2. `.env`, `.env.local`, `.env.development`, `.env.development.local` in the current directory
3. Your personal override, if you set one in Sprint
4. The team's shared value

Keys you already define locally are left alone, so your framework loads them as usual. Keys you have no access to come back as `none` and are never loaded. If Sprint is unreachable, the loader prints a warning and continues with local values only. With no token at all it prints one line and loads nothing, so teammates without a token can still run the app.

**Machine token (`sprint_svc_…`)**, for CI and servers, set as the host's `SPRINT_TOKEN` variable: the host's own variables win over Sprint and the local `.env` files are not read, so Sprint fills in only what the host doesn't define. To move a key to Sprint, delete it from the host. If Sprint is unreachable or rejects the token, `config()` throws and the CLI exits 1, so the app never starts half-configured.

**No token on a host** (production included): `config()` prints one line and loads nothing, and the app runs on the environment it already has. That makes the integration safe to merge before any host has a token; adding `SPRINT_TOKEN` to a host is what switches it over to Sprint, and from then on it fails closed as above. To make a missing token an error instead, set `SPRINT_ENV_REQUIRED=true` or pass `config({ required: true })`. The CLI (`sprint-env run` / `pull`) always exits 1 without a token.

`--explain` sources: `shell`, `file`, `override`, `shared`, `proxy`, `dynamic`, `none`, `error`.

## Environment

| Variable | |
|---|---|
| `SPRINT_TOKEN` | Personal or machine token, from the environment or the local `.env` files. `SPRINT_SERVICE_TOKEN` is read if it is unset. A token found in `.env` or `.env.development`, which projects often commit, gets a warning. |
| `SPRINT_API_URL` | Defaults to `https://sprint.hortensia-agency.com`. |
| `SPRINT_ENV_REQUIRED` | `true` makes a missing token throw instead of keeping the existing environment. Same as `required`. |
| `SPRINT_CERT_PIN` | Optional base64 sha256 of the server's public key. The loader checks it before sending the token and refuses on mismatch. |

## Build logs

The loader never prints a value, only keys. What leaks is the host's own build variables: Coolify writes them into the Dockerfile as `ARG KEY=value` lines and prints that in the deploy log. In the Coolify app's **Environment Variables**, set **Build secrets** to **Docker BuildKit secrets**. Coolify then passes them with `--secret` and mounts them on each `RUN`, so they reach the build without being printed or baked into the image. In a Coolify build without it, the loader prints a reminder. With `SPRINT_TOKEN` as the host's only variable, it is the only one at stake.

## Not included

There is no command that writes a `.env` file or prints values. Tools that need secrets on disk are out of scope: a plaintext file is exactly what this package exists to avoid.

## License

MIT
