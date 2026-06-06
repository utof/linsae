// predev guard: rebuild better-sqlite3 for Electron ONLY when the native binding
// is currently Node-ABI (e.g. right after a commit, where lefthook rebuilt it for
// vitest). Avoids the ~2s force-rebuild on every `pnpm dev` when already aligned
// (~80ms to check instead).
//
// Why a CHILD process probes, and the parent rebuilds:
//   - better-sqlite3 loads its .node LAZILY — `require()` succeeds regardless of
//     ABI; only `new Database()` dlopen's it, so that's the only real ABI signal.
//   - But rebuilding the .node while THIS process holds it open segfaults on exit.
//     So a short-lived child opens a DB (exit 1 = dlopen mismatch = already
//     Electron-ABI; exit 0 = opened under Node = Node-ABI, or any other error =>
//     rebuild to be safe), and only the parent — which never loaded it — rebuilds.
//   - We rebuild with the force path: electron-rebuild's no-force skip is
//     unreliable (it trusts a build/Release/.forge-meta marker that `pnpm rebuild`
//     leaves stale), and once we've decided to rebuild, force is correct + ~2s.
import { execFileSync, spawnSync } from 'node:child_process'

const probe = spawnSync(
  process.execPath,
  [
    '-e',
    "try{new(require('better-sqlite3'))(':memory:').close();process.exit(0)}catch(e){process.exit(e.code==='ERR_DLOPEN_FAILED'?1:0)}",
  ],
  { cwd: process.cwd() },
)

if (probe.status === 1) {
  console.log('[predev] better-sqlite3 already Electron-ABI — skipping rebuild')
} else {
  console.log('[predev] better-sqlite3 is Node-ABI — rebuilding for Electron…')
  execFileSync('pnpm', ['rebuild:electron'], { stdio: 'inherit' })
}
