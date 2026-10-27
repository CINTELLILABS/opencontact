# Contributing

Thanks for helping put business agents in people's Messages apps. This guide covers the mechanics; the
[architecture doc](docs/architecture.md) covers how the pieces fit.

## Ground rules

- **Be kind.** The [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere in this project.
- **Open an issue first for anything non-trivial.** A short issue saves everyone a rewritten PR.
- **Keep PRs focused.** One change per PR. Refactors travel separately from behavior changes.
- **Safety defaults never loosen silently.** `opencontact` ships with send caps, owner takeover, a dry-run mode one
  key away, and a restriction list for testing. A change that weakens any of those needs an explicit discussion.

## Development setup

Requirements: Node 24 or newer, [pnpm](https://pnpm.io) (via `corepack enable`), and for end-to-end runs a Mac
signed into Messages with [`imsg`](https://github.com/openclaw/imsg) installed.

```sh
git clone https://github.com/CINTELLILABS/opencontact.git
cd opencontact
corepack enable
pnpm install --frozen-lockfile
pnpm check        # lint + typecheck + tests
```

Run the bridge from source against your own Mac:

```sh
cd packages/opencontact
pnpm dev doctor
pnpm dev run --dry-run
```

## Project layout

| Path                        | What lives there                                                              |
| --------------------------- | ----------------------------------------------------------------------------- |
| `skills/`                   | Agent skills (`SKILL.md`), installable with `npx skills add CINTELLILABS/opencontact` |
| `packages/opencontact/` | The local bridge: `imsg rpc` on one side, the Bland API chat endpoints on the other |
| `docs/`                     | Architecture, safety model, demo script, API notes, roadmap                   |
| `.claude-plugin/`           | Claude Code plugin manifest so `/plugin install` works too                   |

## Skills

A skill is a directory under `skills/<name>/` with a `SKILL.md` whose frontmatter has `name` (lowercase,
hyphens) and `description`. `pnpm lint:skills` checks that. Write skills for the agent reading them: state
when to use the skill, then numbered steps, then what to tell the human. Never put an API key in a skill.

## Code

- Biome formats and lints (`pnpm format`, `pnpm lint`); CI fails on either. Markdown is left alone.
- TypeScript, strict mode, ESM, zero runtime dependencies in the bridge. Add a runtime dependency only
  with a reason in the PR.
- Every exact version is pinned (`.npmrc` has `save-exact=true`). CI installs with `--frozen-lockfile`.
- Tests use [Vitest](https://vitest.dev). Pure logic (policy, framing, state) is unit tested; the bridge
  loop is tested with fakes for `imsg` and the Bland API. Please add tests with behavior changes.
- GitHub Actions are pinned to full commit SHAs.

## Commit messages

Conventional-commit style, imperative mood, scoped when useful:

```
feat(bridge): pause the agent when the owner replies from Messages
fix(skills): point the phone-number skill at the v2 attach endpoint
docs: add the 90-second demo script
```

## Verifying on a real Mac

CI runs the suite against a stub `imsg`, because a Mac signed into Messages cannot exist in GitHub Actions.
Before tagging a release, a maintainer runs the real thing once:

1. `pnpm build`, then `npm link` inside `packages/opencontact` so `opencontact` on PATH is this build.
2. `opencontact doctor` on a Mac signed into a test iMessage line: every line green.
3. `opencontact run` (dry-run). Text the line from another phone; the reply shows as `DRY RUN →`.
4. Press **L**. Text again; the reply lands on the other phone. Reply from Messages yourself; the agent pauses.
5. `opencontact text <that phone> "say hi"`: the opener and the contact card arrive.
6. `opencontact stop`. Paste the `doctor` output and the audit lines into the release PR.

## Releasing

The bridge is published to npm as `opencontact`. Bump the version in
`packages/opencontact/package.json`, add a `CHANGELOG.md` entry, tag `vX.Y.Z`, and the
release workflow publishes with provenance. Skills need no release; `npx skills add` reads `main`.
