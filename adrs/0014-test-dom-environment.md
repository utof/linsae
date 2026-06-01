# 0014 — happy-dom over jsdom for the Vitest DOM environment

## Context

Component tests run under a simulated DOM via Vitest's `environment` option. The
suite (53 files, 383 tests) was on **jsdom**. Measured on this machine:

- One `.tsx` component file reported **`environment 4.14s`** — jsdom window
  construction, paid once per file.
- Full suite: **~100s** wall clock, with `environment` summing to **559s** across
  files (the single largest bucket; actual test bodies were only ~28s).

So the dominant cost was standing up DOM environments, not running assertions.
DB / media / integration tests already pin `// @vitest-environment node` per-file
(native `better-sqlite3` needs a real Node env), so only the ~25 component files
paid the DOM cost.

## Decision

Switch the global Vitest `environment` from `jsdom` to **`happy-dom`**, and convert
the 8 files that explicitly pinned `// @vitest-environment jsdom` to `happy-dom`
(the `node`-pinned files are unchanged). Remove the `jsdom` devDependency.

**Result (measured): ~100s → ~49s wall clock, 383/383 green**; `environment`
aggregate 559s → 165s.

One compatibility fix was required. happy-dom defaults the document to **quirks
mode**, and KaTeX (`rehype-katex`, used by `markdown.test.tsx`) throws
`"KaTeX doesn't work in quirks mode"` unless `document.compatMode === 'CSS1Compat'`.
jsdom reported standards mode. We force parity with a guarded stub in
`tests/setup.tsx`:

```js
if (typeof document !== 'undefined') {
  Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true })
}
```

The `typeof document` guard matters: `setup.tsx` also loads for `node`-env tests,
where `document` is undefined (an unguarded version crashed every node test).

## Alternatives

- **Stay on jsdom.** Most "browser-accurate" and the ecosystem default, but pays
  the ~4s/file construction cost we measured. No correctness need for the extra
  fidelity surfaced in this suite.
- **Hybrid (happy-dom default, jsdom docblock on a few files).** Considered, but
  empirically only one assertion differed (KaTeX quirks mode) and it was fixable
  with a 3-line stub — so a blanket switch was cleaner than maintaining two DOM
  engines and the jsdom dep.
- **`@vitejs/...` browser mode / Playwright component testing.** Real browser,
  highest fidelity, but far heavier per-test and a bigger harness change. Visual
  regression already uses Playwright (per CLAUDE.md) — unit/component stays in-process.

## Consequences

- **Positive:** test step roughly halved (~100s → ~49s), directly cutting
  precommit time; one fewer dependency (`jsdom` removed).
- **Fidelity tradeoff:** happy-dom is less browser-accurate than jsdom. Known weak
  spots — `getComputedStyle` returning `""` for CSS custom properties, no layout
  (`getBoundingClientRect` → zeros, same as jsdom), pseudo-elements. No current
  test asserts on computed style; layout-zero behavior is unchanged from jsdom and
  already handled in tests.
- **Future fragility — the one to remember:** this suite drives **100% of its
  interactions through `fireEvent`** and does **not** use
  `@testing-library/user-event` (not installed). happy-dom has open issues around
  `user-event` (clipboard/`DataTransfer`, capricorn86/happy-dom#1770). **If we adopt
  `user-event` later, re-run the full suite before trusting it** — that's where
  happy-dom's gaps live. Our `fireEvent`-only usage was verified green on the switch.
- **ResizeObserver stub** in `setup.tsx` is now effectively dead: happy-dom ships a
  real `ResizeObserver`, so the `typeof … === 'undefined'` guard no longer fires.
  Left in place as a harmless fallback.

## Follow-up: `isolate: false` on the dom project

Profiling showed the dom project paid env+setup re-init **per file** (53× teardown/
rebuild). Setting `isolate: false` on the dom project reuses one happy-dom context
per worker: dom project 34s→17s, full suite ~38s→~20s, stable across repeated and
`--sequence.shuffle` runs (223/223). Safe because RTL `cleanup()` resets the DOM per
test and component tests use `renderWithProviders`' fresh QueryClient, not the
module-level `queryClient` singleton. The **node** project keeps isolation (real
better-sqlite3 + tmpdir DBs must not share state). Reversible: drop the one flag.

## Sources

- Vitest test environment: https://vitest.dev/guide/environment · https://vitest.dev/config/environment
- happy-dom: https://github.com/capricorn86/happy-dom
- KaTeX quirks-mode guard: https://github.com/KaTeX/KaTeX
- happy-dom + RTL `fireEvent`/`user-event` open issues: https://github.com/capricorn86/happy-dom/issues/1770 · https://github.com/testing-library/user-event/issues/1167
- In-repo: `vitest.config.ts` (`environment`), `tests/setup.tsx` (compatMode stub), the 8 files converted from `// @vitest-environment jsdom`.
