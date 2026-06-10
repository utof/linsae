# 0024 — Dev-tools HUD: single `mod+shift+d` overlay store

Status: accepted (v0.2.4)

## Context

Four DEV-only overlays existed before this milestone, each gated differently:

| Overlay | Gate | Toggle UX |
| --- | --- | --- |
| `DevFpsMeter` | `import.meta.env.DEV` only | always on — no way to hide it |
| `DevBootMeter` | `DEV && localStorage.devbootmeter` | edit localStorage in DevTools, reload |
| `WaveTuner` | `DEV && localStorage.wavetuner` | edit localStorage in DevTools, reload |
| `RevealPlayground` | `DEV_PLAYGROUND` + `playgroundOpen` React state | `mod+shift+r` dedicated hotkey |

The inconsistency has a compounding problem: each new dev tool either eats a global hotkey
(finite mnemonic namespace) or invents another ad-hoc localStorage flag requiring a page
reload to observe. Two of the four also had a subtle backward-compat bug — `localStorage.x`
is truthy even when the stored string is `'0'` or `''`, so setting a flag to `'0'` did not
mean "off".

## Decision

A single **`mod+shift+d`** HUD (`dev/DevToolsHud.tsx`) lists every overlay with a live
checkbox. All overlay state is owned by a hand-rolled external store
(`dev/devOverlays.ts`, `useSyncExternalStore`) — one boolean per key
(`fps` | `boot` | `wave` | `reveal`), read by both of `main.tsx`'s render roots and `App.tsx`
with no reload needed.

Persistence split:
- `fps` / `boot` / `wave` persist to localStorage (`devfpsmeter` / `devbootmeter` / `wavetuner`)
  so a choice survives a dev reload. Encoding: `'1'` = on, `'0'` or absent = off. Backward
  compat: any stored string that is neither `'0'` nor `''` reads as on, so a pre-existing
  hand-set `wavetuner = 1` or `= "true"` keeps working (`src/renderer/src/dev/devOverlays.ts:44`).
- `reveal` is **session-ephemeral** (in-memory only) — a modal must not resurrect itself on
  reload.

Defaults on a fresh dev boot (no stored value): `fps` on, all others off — preserving the
previous always-on fps behavior while adding a way to hide it.

`mod+shift+r` is retained as a `reveal` alias (`App.tsx:301-308`) so the Playwright
`VITE_PLAYGROUND` harness, which drives the reveal via that hotkey, is unchanged.

Gate wrappers (`dev/overlayGates.tsx`) replace the inline booleans in `main.tsx` — extracting
them to a separate importable module means tests can import the gates without executing
`ReactDOM.createRoot(...)`, which `main.tsx` calls at module top level.

## Alternatives

- **One hotkey per tool:** scales to O(N) consumed global combos and runs out of mnemonic
  letters. The HUD is one hotkey forever — adding a tool is adding a row, not a keybinding.
- **Leader chord (`mod+shift+d` then a letter):** two-step interaction, less discoverable,
  requires a cheatsheet. A checkbox panel is immediately self-documenting.
- **React context store:** would require threading a provider across `main.tsx`'s two sibling
  subtrees (`FpsMeterGate` is outside `QueryClientProvider`, `BootMeterGate` is inside).
  `useSyncExternalStore` works across multiple `createRoot` calls without a provider.
- **Zustand:** new dep with no benefit over the hand-rolled approach here; the store is four
  booleans and a `Set<listener>`.

## Consequences

- **Store ships in prod.** `App.tsx` calls `useDevOverlay('reveal')` and
  `toggleOverlay('reveal')` unconditionally (rules of hooks; `mod+shift+r` handler is
  statically reachable). Those cannot be `import.meta.env.DEV`-gated because the
  `VITE_PLAYGROUND` harness builds with `DEV=false` and still needs them. The store module is
  tiny and inert in prod; the overlay *components* remain tree-shaken via
  `import.meta.env.DEV ? lazy(...) : null` / `import.meta.env.DEV && ...`.
- **Boot meter mid-session.** Toggling `boot` on during a live session shows already-elapsed
  timings. Acceptable — the persisted value means it will be on from boot on the next reload,
  which is the useful path.
- **Hotkey untested in Vitest.** `mod` resolution under happy-dom is platform-dependent.
  `DevToolsHud` exposes a `defaultOpen` prop as a test affordance so component tests can render
  the open panel without simulating `mod+shift+d`. Covered by that path + manual smoke.

## Sources

- `src/renderer/src/dev/devOverlays.ts` — store, `useSyncExternalStore` subscriber
- `src/renderer/src/dev/overlayGates.tsx` — `FpsMeterGate` / `BootMeterGate`
- `src/renderer/src/dev/DevToolsHud.tsx` — HUD panel, `defaultOpen` test affordance
- `src/renderer/src/main.tsx:54,62-63` — gate + HUD mounts
- `src/renderer/src/App.tsx:85-86,301-308` — unconditional store hooks + reveal hotkey alias
- `useSyncExternalStore` React docs — https://react.dev/reference/react/useSyncExternalStore
- `docs/specs/v0.2.4-dev-tools-hud.md` — problem statement + architecture
- `docs/plans/v0.2.4-dev-tools-hud.md` — TDD task breakdown
