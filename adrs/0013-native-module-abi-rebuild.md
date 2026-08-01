# 0013 — Rebuilding the native SQLite addon between Electron and Node ABIs

Status: accepted (v0.2.1)

> Self-contained for external review. The open question (is this sound or a
> smell?) is stated explicitly at the end.

## Context

linsae stores notes in SQLite via **`better-sqlite3@12.10.0`** — a **native**
Node addon. Verified (`nm -D better_sqlite3.node`) that it links the **classic
V8 module ABI** (`node_module_register`), **not** N-API
(`napi_register_module_v1`). Classic-ABI addons compile against a specific
`NODE_MODULE_VERSION`, so the built `.node` is tied to one runtime ABI.

Electron and Node are different runtimes with different ABIs. On this machine:
- **Node 22.22.3 → `NODE_MODULE_VERSION` 127**
- **Electron 39.8.10 → ABI 140** (`node-abi` `getAbi('39.8.10','electron')`)

Only one compiled `.node` exists at a time, and it must match whatever
`dlopen`s it:
- `pnpm dev` and the packaged app open the DB in Electron's **main** process → need **140**.
- The test suite (`vitest`, jsdom) opens real SQLite in `mkdtempSync` tmpdirs under **Node** → need **127**.

So the two workflows fight: after `pnpm dev` the binding is 140, and the next
`git commit`'s test step crashes (`NODE_MODULE_VERSION 140 … requires 127`);
after a commit (rebuilt to 127) the next `pnpm dev` crashes the other way.

**Why a plain web-React app never sees this** (the "I just `bun dev` and walk
away" instinct): a web app has (a) no native dependency and (b) one runtime (the
browser, via the dev server). linsae has both a native module **and** two
runtimes (Electron for the app, Node for the tests). That combination is the
entire source of the friction — nothing exotic, just the cost of a native DB in
an Electron app that unit-tests under Node.

## Decision

Automate both directions so neither workflow needs a manual rebuild.

1. **Test side** (issue #24): the lefthook pre-commit runs
   `pnpm rebuild better-sqlite3` (→ Node-ABI) before `vitest`, unconditionally
   (~2–3s, a no-op-cost when already aligned). Commits always test against a
   Node-ABI binding.
2. **Dev side** (this ADR, commit `45888ab`): `"dev"` runs
   `scripts/ensure-electron-abi.mjs` before `electron-vite dev`. It probes the
   binding and rebuilds for Electron **only when mismatched** (~80ms to check vs
   ~2s to force-rebuild every start):

   ```js
   // child process probes; exit 1 = dlopen mismatch (already Electron-ABI, skip)
   const probe = spawnSync(process.execPath, ['-e',
     "try{new(require('better-sqlite3'))(':memory:').close();process.exit(0)}" +
     "catch(e){process.exit(e.code==='ERR_DLOPEN_FAILED'?1:0)}"], { cwd: process.cwd() })
   if (probe.status === 1) { /* skip */ }
   else execFileSync('pnpm', ['rebuild:electron'], { stdio: 'inherit' })  // electron-rebuild -f
   ```

The probe's shape encodes three facts found by testing the real binary (not
docs), each of which broke a simpler version:
- **`require()` is a lazy, useless ABI signal.** `require('better-sqlite3')`
  succeeds regardless of ABI; only `new Database()` actually `dlopen`s the
  `.node`. A `require`-only probe always "passes" → always rebuilds.
- **`electron-rebuild` no-force is unreliable.** Its skip decision is a string
  compare of `build/Release/.forge-meta` (`<arch>--<ABI>`), which
  `pnpm rebuild` leaves **stale** (it rewrites the `.node` but not the marker).
  So no-force skipped a genuinely-mismatched binding in testing. Once we decide
  to rebuild, we therefore **force** (`-f`) — correct, and only ~2s because
  better-sqlite3 ships **prebuilt** Electron binaries (no source compile).
- **Rebuilding a loaded `.node` segfaults the holder on exit.** So the probe
  runs in a short-lived **child**; the parent (which runs the rebuild) never
  loads the binding. An in-process probe segfaulted, which would short-circuit
  the `&&` and stop `pnpm dev` from launching.

## Alternatives

- **Force-rebuild on every `pnpm dev`** (`pnpm rebuild:electron && …`, commit
  `2cc85c7`). Simplest, dead-reliable, but pays ~2s on every start including the
  common no-commit restart. Superseded by the conditional probe.
- **`electron-rebuild` no-force as the conditional.** Rejected — unreliable
  (stale `.forge-meta`, above).
- **Run the test suite under Electron** (e.g. an Electron-hosted test runner) so
  both workflows use ABI 140 and nothing ever switches. Removes the dance
  entirely, but means a heavier/slower test harness and losing the
  vitest + jsdom setup the whole suite (383 tests) is built on. Not now.
- **Migrate to an N-API SQLite binding** (or Node's built-in `node:sqlite`,
  Node 22+ — though it isn't present in Electron's bundled Node). N-API is
  ABI-stable across runtimes, so the rebuild would be unnecessary. This is a
  dependency/architecture change and needs its own evaluation.
- **WASM SQLite** (`sql.js` / `wa-sqlite`). No native code at all → no rebuild,
  identical in renderer and Node. Tradeoffs: perf, persistence ergonomics, API
  shape. The "make the problem disappear" option.
- **Prebuilt binaries.** Already in play — it's why `electron-rebuild` is ~2s,
  not a 20–40s source compile.

## Consequences

- **Positive:** dev↔commit friction is gone and automatic in both directions;
  aligned dev starts cost ~80ms; the actual rebuild is ~2s (prebuilds).
- **Cost / surface:** one small script (`scripts/ensure-electron-abi.mjs`) + one
  lefthook step + a `dev` script that's no longer a bare `electron-vite dev`.
- **Coupling:** the entire mechanism exists only because better-sqlite3 is a
  classic-ABI native module tested under Node. If it ever ships N-API, or we move
  to WASM SQLite, or run tests under Electron, **all of this can be deleted.**
- **Portability caveat:** ABI numbers (127/140) and `.forge-meta` format are
  version/platform specific; the probe avoids hard-coding them by testing the
  real binary.

## Open question for external review

Is the **rebuild-on-runtime-switch + conditional probe** the standard, sound way
to ship a native SQLite addon in an Electron app that unit-tests under Node — or
is it a code smell that argues for one of: (a) running tests under Electron,
(b) moving to an N-API binding / `node:sqlite`, or (c) WASM SQLite? Is anything
here non-idiomatic, fragile, or reinventing something the ecosystem already
solves (e.g. an electron-vite/Forge feature we're missing)?

## Sources

- Electron — Using Native Node Modules: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- `@electron/rebuild` (4.0.4): https://github.com/electron/rebuild — skip logic in `lib/module-rebuilder.js` (`alreadyBuiltByRebuild()` string-compares `.forge-meta`).
- `better-sqlite3` (12.10.0): https://github.com/WiseLibs/better-sqlite3 — classic-ABI, ships prebuilds.
- `node-abi`: https://github.com/electron/node-abi — runtime→ABI mapping.
- Node `process.versions.modules` (NODE_MODULE_VERSION): https://nodejs.org/api/process.html#processversions
- In-repo: `scripts/ensure-electron-abi.mjs`, `lefthook.yml` (rebuild step), `package.json` (`dev`/`rebuild:electron`/`rebuild:node`); commits #24, `2cc85c7`, `45888ab`.
