# @sprint-logger/env

Load a project's Sprint secrets into a command's environment. Nothing is written to disk.

```sh
export SPRINT_TOKEN=sprint_dev_…          # from the project's Secrets page
export SPRINT_API_URL=https://sprint.hortensia-agency.com
npx @sprint-logger/env run -- pnpm dev
```

Works with any command and any language: the loader starts your command with the secrets in its environment, forwards signals to it, and exits with its exit code.

## Commands

- `sprint-env run [--explain] [--preserve-env=KEY,…] -- <command> [args…]`: start `<command>` with the secrets loaded.
- `sprint-env pull [--preserve-env=KEY,…]`: check access and print what `run` would load, as `KEY SOURCE KIND`. Never prints values.
- `--explain`: print the same table to stderr before starting the command.

## Tokens and precedence

The token's prefix decides how values are merged.

**Personal dev token (`sprint_dev_…`)**, one per developer per project, created on the Secrets page:

1. Your shell environment
2. `.env`, `.env.local`, `.env.development`, `.env.development.local` in the current directory
3. Your personal override, if you set one in Sprint
4. The team's shared value

Keys you already define locally are left alone, so your framework loads them as usual. Keys you have no access to are listed by `--explain` as `none` and never loaded. If Sprint is unreachable, the loader prints a warning and starts your command with local values only.

**Machine token (`sprint_svc_…`)**, for CI and servers: Sprint's value wins over the environment, so a stale container variable cannot silently shadow the vault. `--preserve-env=KEY,…` keeps listed keys from the environment and logs one line per key on every start. If Sprint is unreachable or rejects the token, the loader exits 1 without starting the command.

`--explain` sources: `shell`, `file`, `override`, `shared`, `proxy`, `dynamic`, `none`, `error`.

## Environment

| Variable | |
|---|---|
| `SPRINT_TOKEN` | Personal or machine token. `SPRINT_SERVICE_TOKEN` is read if it is unset. |
| `SPRINT_API_URL` | Defaults to `https://sprint.hortensia-agency.com`. |
| `SPRINT_CERT_PIN` | Optional base64 sha256 of the server's public key. The loader checks it before sending the token and refuses on mismatch. |

## Not included

There is no command that writes a `.env` file or prints values. Tools that need secrets on disk are out of scope: a plaintext file is exactly what this package exists to avoid.

## License

MIT
