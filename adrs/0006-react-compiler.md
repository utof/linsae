# 0006 — Adopt the React Compiler for the renderer

## Context

The rolling feed (`@tanstack/react-virtual`, ADR 0005) dropped frames during
fast scroll through dense runs of **small** notes, while scrolling through one
large note stayed smooth. A DevTools performance trace was inconclusive on its
own — ~1.8 s of the recording was `console.createTask` / debugger async-task
overhead that exists only because React dev mode + the profiler were attached,
and real GC was a negligible 169 ms. The signal that survived: app code
(`NoteBubble`, react-markdown) was <0.5 % of sampled time, and the dip tracked
the **number of bubble components reconciled per frame**, not content size. A
viewport of small notes holds many bubbles; each scroll frame `Feed` re-renders
and React reconciles every visible bubble.

The standard fix is component memoization so unchanged bubbles skip reconcile,
turning per-frame cost from "all visible" into "just the few entering/leaving."
That can be hand-rolled (`React.memo` + `useCallback` + an id-callback prop
shape), or delegated to the React Compiler, which auto-memoizes every component
and stabilizes values at build time.

## Decision

Adopt **React Compiler 1.0** (`babel-plugin-react-compiler`) in the renderer
build only, via the classic Babel form of `@vitejs/plugin-react` (we are on
v5.1.1, which still runs Babel):

```ts
react({ babel: { plugins: ['babel-plugin-react-compiler'] } })
```

No `target` or runtime package is needed on React 19 — `react/compiler-runtime`
ships with React. The compiler removes the need for manual `memo`/`useMemo`/
`useCallback` going forward.

The compiler cannot stabilize closures created inside a `.map()` iteration (no
per-iteration memo slot), so the data flow still had to be made memo-friendly:
`NoteBubble`'s action callbacks now take a note id (`(id) => void`) and `Feed`
passes the stable callbacks straight down instead of per-item
`() => onFocus(note.id)` closures. `NoteBubble` binds them to its own `note.id`
in single component-body closures the compiler *can* memoize.

## Alternatives

- **Manual `memo` + `useCallback`** across `App`/`Feed`/`NoteBubble`. No new
  dependency, but fiddlier (ref-stable callbacks, the dangling-link
  `resolveSlug` identity gotcha) and it only fixes this one site — every future
  hot list would need the same hand-work. Rejected as the long-term answer; the
  id-callback prop reshape it required is kept anyway because the compiler needs
  it too.
- **Raise `overscan` further / scroll-seek placeholder.** Overscan is a buffer
  for *blanks*, not a fix for per-frame reconcile cost, and a placeholder hides
  the cost rather than removing it (explicitly rejected by the maintainer).
- **Do nothing / accept dev-only jank.** StrictMode double-render + dev
  instrumentation inflate the dev cost and vanish in production, but the
  reconcile cost is real in production too for dense small-note runs.

## Consequences

- **Positive:** unchanged bubbles skip reconcile during scroll; the optimization
  applies app-wide and to future components with zero per-site work; manual
  memoization is no longer needed.
- **Build:** one dev dependency (`babel-plugin-react-compiler` 1.0.0), added to
  knip `ignoreDependencies` (string-referenced in the Vite config, like
  `@vitejs/plugin-react`). Renderer build time rises modestly (extra Babel
  pass). The compiler runs in `electron-vite` dev + build, **not** in Vitest —
  tests run uncompiled, so they validate behavior, not the memoization.
- **Bail-outs:** the compiler silently skips components that violate the Rules
  of React (e.g. the ref-callback DOM mutation in `markdown.tsx`); those simply
  go un-optimized, no error. `Markdown`'s existing manual `memo` is harmless and
  retained.
- **Upgrade note:** moving to `@vitejs/plugin-react` v6 (Vite 8, oxc) drops the
  inline Babel option — it would then require `@rolldown/plugin-babel` or the
  `reactCompilerPreset()`. Revisit this config at that upgrade.
- **Verification:** the optimization is perf, not behavior, so it is confirmed
  with the dev FPS meter (`DevFpsMeter`), not the unit suite.

## Sources

- React Compiler v1.0 announcement — https://react.dev/blog/2025/10/07/react-compiler-1
- Installation (Vite, classic Babel form) — https://react.dev/learn/react-compiler/installation
- `babel-plugin-react-compiler` — https://www.npmjs.com/package/babel-plugin-react-compiler
- Vite 8 / plugin-react v6 oxc change — https://dev.to/recca0120/react-compiler-10-vite-8-the-right-way-to-install-after-vitejsplugin-react-v6-drops-babel-p0i
