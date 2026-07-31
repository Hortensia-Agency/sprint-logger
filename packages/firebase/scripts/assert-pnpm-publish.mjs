/**
 * Refuse to publish this package with npm.
 *
 * This package depends on `@sprint-logger/node` via the `workspace:^` protocol.
 * `pnpm publish` rewrites that to a real semver range in the published
 * manifest; `npm publish` ships the literal string, producing a package that
 * npm itself cannot install (EUNSUPPORTEDPROTOCOL) for every consumer.
 *
 * That failure is silent at publish time — npm reports success — and only
 * surfaces when someone installs. Version numbers cannot be reused, so each
 * occurrence permanently burns one. v0.1.0 was lost this way.
 *
 * Detection: pnpm sets npm_config_user_agent to a string beginning with
 * "pnpm/". Both npm and yarn set their own, so anything else is rejected.
 */

const agent = process.env.npm_config_user_agent ?? "";

if (!agent.startsWith("pnpm/")) {
  const tool = agent.split("/")[0] || "an unknown tool";
  console.error(`
╭──────────────────────────────────────────────────────────────╮
│  Publish blocked: use pnpm, not ${tool.padEnd(28)}│
╰──────────────────────────────────────────────────────────────╯

@sprint-logger/firebase depends on @sprint-logger/node with:

    "@sprint-logger/node": "workspace:^"

Only pnpm rewrites that to a real version range when publishing. Publishing
with ${tool} ships the literal "workspace:^", and every
\`npm install @sprint-logger/firebase\` then fails with EUNSUPPORTEDPROTOCOL.

Run instead:

    pnpm publish --access public

If you are certain you want to bypass this, publish with:

    npm_config_user_agent="pnpm/manual-override" npm publish
`);
  process.exit(1);
}
