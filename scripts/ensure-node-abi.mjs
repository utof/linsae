// pre-commit guard: rebuild better-sqlite3 for Node ONLY when the native binding
// is not already Node-ABI (e.g. right after `pnpm dev`, which leaves it Electron-
// ABI). In the normal commit loop the binding is already Node-ABI, so this turns
// the unconditional `pnpm rebuild:node` (~2–4s of re-extracting an already-correct
// tarball) into an ~80ms probe — and, crucially, it stops re-writing the shared
// `.node` on every commit, which removes the race where a concurrent vitest can
// dlopen a binary mid-rewrite. Mirror/inverse of scripts/ensure-electron-abi.mjs.
//
// Why a CHILD process probes, and the parent rebuilds:
//   - better-sqlite3 loads its .node LAZILY — `require()` succeeds regardless of
//     ABI; only `new Database()` dlopen's it, so that's the only real ABI signal.
//   - Rebuilding the .node while THIS process holds it open segfaults on exit, so
//     a short-lived child opens a DB under Node (exit 0 = opened = already Node-ABI
//     → skip; exit 1 = ERR_DLOPEN_FAILED = Electron-ABI → rebuild; exit 2 = any
//     other error → rebuild to be safe), and only the parent — which never loaded
//     it — rebuilds.
import { execFileSync, spawnSync } from 'node:child_process'

const probe = spawnSync(
  process.execPath,
  [
    '-e',
    "try{new(require('better-sqlite3'))(':memory:').close();process.exit(0)}catch(e){process.exit(e.code==='ERR_DLOPEN_FAILED'?1:2)}",
  ],
  { cwd: process.cwd() },
)

if (probe.status === 0) {
  console.log('[precommit] better-sqlite3 already Node-ABI — skipping rebuild')
} else {
  console.log(
    `[precommit] better-sqlite3 not Node-ABI (probe status ${probe.status}) — rebuilding for Node…`,
  )
  execFileSync('pnpm', ['rebuild:node'], { stdio: 'inherit' })
}
