# linsae

Personal note-taking app: a Telegram-style chronological feed of markdown notes with Obsidian-style `[[wikilinks]]`. Local-first; markdown files on disk are the source of truth, SQLite is a derived index.

- **Spec:** [docs/specs/v0.1-rolling-feed-and-search.md](docs/specs/v0.1-rolling-feed-and-search.md)
- **Plan:** [docs/plans/v0.1-rolling-feed-and-search.md](docs/plans/v0.1-rolling-feed-and-search.md)
- **ADRs:** [adrs/](adrs/)
- **Agent / contributor instructions:** [CLAUDE.md](CLAUDE.md)

## Stack

Electron 39 (via electron-vite) · React 19 + TypeScript strict · better-sqlite3 + FTS5 · `react-virtuoso` · cmdk · `react-markdown` + KaTeX · TanStack Query · Vitest · Biome · lefthook.

## Quickstart

```bash
pnpm install
pnpm rebuild:electron   # build native better-sqlite3 binding for Electron's ABI
pnpm dev                # starts Vite renderer + launches Electron window
```

Other commands:

```bash
pnpm rebuild:node       # before pnpm test (re-target the native binding for system Node)
pnpm test               # vitest
pnpm typecheck
pnpm lint               # biome check --write
pnpm knip               # unused exports / files / deps
pnpm build              # electron-vite build && electron-builder
```

> **ABI gotcha:** `better-sqlite3` is a native binding. Node and Electron use different ABIs, so flipping between `pnpm dev` and `pnpm test` needs a rebuild each way (`rebuild:electron` / `rebuild:node`). The `lefthook` precommit hook runs `pnpm test`, so commits implicitly leave the binding in Node mode — run `pnpm rebuild:electron` again before the next `pnpm dev`.

## Linux 24.04+ dev setup (AppArmor)

Ubuntu 24.04+ enables `kernel.apparmor_restrict_unprivileged_userns=1` by default, which blocks Electron's user-namespace sandbox. Without a workaround, `pnpm dev` silently exits after `starting electron app...` with no window.

The Canonical-recommended fix is an AppArmor profile that grants the dev electron binary `userns` capability (preserves the kernel sandbox for production builds, only relaxes it for this exact binary path):

```bash
ELECTRON_PATH="$(realpath node_modules/electron/dist/electron)"

sudo tee /etc/apparmor.d/electron-dev > /dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

profile electron-dev "$ELECTRON_PATH" flags=(unconfined) {
  userns,
  include if exists <local/electron-dev>
}
EOF

sudo apparmor_parser -r /etc/apparmor.d/electron-dev
```

> The profile is keyed to the resolved binary path. If your `node_modules` lives behind a pnpm content-addressable store with a hashed path, `realpath` resolves it correctly — but a fresh `pnpm install` may change the path. Re-run the snippet if `pnpm dev` starts silently exiting again.

This is the same path Canonical, the Electron maintainers, and shipping Electron apps (Jitsi, Joplin, Teleport) have converged on. `--no-sandbox` works but disables an internal security feature; don't use it.

## License

See [LICENSE](LICENSE).
