// Runs in a child process so config() can wait for the network synchronously.
// Reads its settings from the environment config() gives it and prints one
// JSON line: { ok: true, pulled } or { ok: false, reason, message }.
import { pull, PullError } from "./pull.ts";

const { SPRINT_TOKEN, SPRINT_API_URL, SPRINT_CERT_PIN } = process.env;

pull({ token: SPRINT_TOKEN!, apiUrl: SPRINT_API_URL!, certPin: SPRINT_CERT_PIN || undefined })
  .then((pulled) => ({ ok: true, pulled }))
  .catch((err: unknown) =>
    err instanceof PullError
      ? { ok: false, reason: err.reason, message: err.message }
      : { ok: false, reason: "unavailable", message: err instanceof Error ? err.message : String(err) }
  )
  .then((out) => process.stdout.write(JSON.stringify(out)));
