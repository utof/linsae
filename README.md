# linsae

Personal thinking tool. It starts as a Telegram-style chronological feed of markdown notes with
Obsidian-style `[[wikilinks]]`, and grows sideways from there: a spatial canvas you can place those
notes on, a PDF reader that captures excerpts straight onto the canvas, and a YouTube player you can
annotate at a timestamp.

Local-first, and literally so: your notes are `.md` files with YAML frontmatter in a directory on
disk, and that directory is the source of truth. SQLite is a **derived index** — it is rebuilt from
the files by a reconciler on every launch, so editing a note in another editor between sessions is a
supported workflow, not a corruption. Everything lives under Electron's `userData` directory:
`notes/`, `attachments/`, `logs/`, and `linsae.db`
([`src/main/index.ts:159`](src/main/index.ts)).

## What's in it

| Surface | What it does | Shipped |
| --- | --- | --- |
| **Feed** | Virtualized chronological feed; enter-to-send composer; `[[wikilinks]]` resolved against note slugs; expand/collapse; multi-select; a note can be opened as a **thread** with its own replies | v0.1 → v0.6.4 |
| **Search & command palette** | `cmdk` palette over FTS5 — slug-weighted `bm25()` ranking with `snippet()` highlighting, plus frecency-ordered recents | v0.5 |
| **Canvas** | A pannable spatial surface (zoom clamped 0.5–2×) as a peer view of the same notes: place them as cards, draw edges between them, semantic LOD tiers with rbush culling | v0.4, v0.4.1 |
| **PDF reader** | Continuous-scroll reader in the right dock across all pages of a document; select text to capture an **excerpt** as a note carrying a page + rect + quote locator; that note can re-open the reader at the exact place it came from | v0.6, v0.8 |
| **YouTube** | Annotate a video at a timestamp; comments anchor to a time, screenshot-at-timestamp capture, ink annotation over the captured frame | v0.2, v0.2.5, v0.3 |
| **Dock shell** | Ordered right-dock panes with tabs; media surfaces (PDF, video) are panes; layout and reader position survive a restart | v0.6.2, v0.7 |

## Stack

Electron 42 via electron-vite · React 19 + TypeScript strict, with React Compiler
(`babel-plugin-react-compiler` through `@rolldown/plugin-babel`) · better-sqlite3 with raw SQL
migrations and FTS5 · zustand for client state · `@tanstack/react-query` for main-process data ·
`@tanstack/react-virtual` for the feed · motion for animation · pdfjs-dist for the reader ·
perfect-freehand for ink · rbush for canvas culling · cmdk · react-markdown + remark-gfm/math +
rehype-katex + a custom `remark-wikilinks` plugin · Zod at the IPC boundary · Vitest + React Testing
Library + happy-dom · Biome · knip · lefthook.

Exact versions live in [`package.json`](package.json); the reasoning behind most of these choices is
in [`adrs/`](adrs/).

## Quickstart

```bash
pnpm install            # also installs the lefthook hooks (via the `prepare` script)
pnpm dev                # probes the native ABI, then starts Vite + launches Electron
```

Other commands:

```bash
pnpm test               # vitest — unit + component + integration
pnpm typecheck          # tsc --noEmit over both tsconfigs
pnpm lint               # biome check --write
pnpm knip               # unused exports / files / deps
pnpm build              # electron-vite build && electron-builder
pnpm smoke:pdf          # one of several scripts/*.mjs smokes that drive a real Electron window
```

### The better-sqlite3 ABI dance

`better-sqlite3` is a native module, and Node and Electron compile against different ABIs. The same
`.node` binary cannot serve both, so it has to be rebuilt whenever you cross between `pnpm dev`
(Electron ABI) and `vitest` (Node ABI).

**This is automatic — you should not normally have to think about it.** Both directions are
probe-gated:

- `pnpm dev` runs [`scripts/ensure-electron-abi.mjs`](scripts/ensure-electron-abi.mjs) first.
- The lefthook pre-commit hook runs [`scripts/ensure-node-abi.mjs`](scripts/ensure-node-abi.mjs)
  before the test suite.

Each spawns a short-lived child process that tries to open an in-memory database. `require()` alone
proves nothing — better-sqlite3 loads its binding lazily, so only `new Database()` actually
`dlopen`s it. An `ERR_DLOPEN_FAILED` means the binding is built for the *other* runtime, and only
then does the parent rebuild. Costs ~80 ms when already aligned, versus ~2–4 s of unconditionally
re-extracting a correct tarball. The probe runs in a child because rebuilding the `.node` while the
current process holds it open segfaults on exit.

The manual escape hatches still work if a probe ever guesses wrong:

```bash
pnpm rebuild:electron   # re-target the binding for Electron, before pnpm dev
pnpm rebuild:node       # re-target it for system Node, before running vitest directly
```

Note that `pnpm test` invokes `vitest run` with no probe of its own — the probe is wired into the
commit hook, not the script. If you run the suite directly right after `pnpm dev`, run
`pnpm rebuild:node` (or `node scripts/ensure-node-abi.mjs`) first.

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

## Docs

- **Where this is going:** [docs/canvas-vision.md](docs/canvas-vision.md) — the living direction
  document. Read this first if you want to know what the app is *for*.
- **ADRs:** [adrs/](adrs/) — every decision that someone might otherwise reverse by accident.
- **Specs and plans:** [docs/specs/](docs/specs/) and [docs/plans/](docs/plans/), one pair per
  milestone. The original is
  [v0.1-rolling-feed-and-search](docs/specs/v0.1-rolling-feed-and-search.md)
  ([plan](docs/plans/v0.1-rolling-feed-and-search.md)).
- **Agent / contributor instructions:** [CLAUDE.md](CLAUDE.md) — workflow, the precommit gate, and
  the house rules. There is no CI; lefthook is the authoritative gate.

## License

MIT — see [LICENSE](LICENSE).
