# 0063 — A composer never clears its own draft; only a resolved post does

Status: accepted (v0.8.2)
Date: 2026-08-01

## Context

Both thread composers cleared the draft **optimistically**: `setDraft('')` and `onDraftClear?.()`
fired on the keydown stack, before the post had resolved. When `notes.create` rejected, the error line
rendered over an **empty** composer — and since v0.7 also persists the draft, `onDraftClear` had
already dropped the durable `composer.draft.thread.v1` entry, so a restart did not recover the text
either. Reported as #161 (`SimpleComposer`) and #176 (both).

The failure is not hypothetical. `src/main/save-note.ts` throws
``a note named "${slug}" already exists`` on a body-derived slug collision, which two short identical
replies in one thread produce immediately.

**Why this survived from v0.6.4 to v0.8.2.** An optimistic local clear is invisible until the async
path fails, and nothing in the type system flags it: `onPost`/`onSubmit` were declared `=> void`, so a
fire-and-forget call to an async parent type-checks perfectly and the composer has no way to know a
post is still in flight. The bug is only observable on the failure path, which no test exercised. The
`ThreadComposer` TSDoc had asserted *"the draft IS preserved so the user can edit + retry"* the whole
time; it was simply false.

## Decision

**A composer never clears its own draft. The clear is owned by the outcome of the post, and happens on
success only.**

Concretely, in `SimpleComposer.submit` and `ThreadComposer.submit`: `await` the parent's post inside a
`try`; on resolve, clear; on reject, clear **nothing** — not the on-screen draft, not the persisted
`composer.draft.thread.v1` entry, not any state derived from the draft.

### The parent must actually reject — `mutate` vs `mutateAsync`

The same trap exists one layer up, and it is the single most expensive line in this ADR. Before
v0.8.2, `ThreadView` passed:

```tsx
onPost={({ body, t }) => { post.mutate({ body, t }) }}
```

TanStack Query v5's `mutate` returns **`void`** and swallows the promise
(`useMutation.ts`: `observer.mutate(variables, mutateOptions).catch(noop)`); only `mutateAsync`
returns a promise that rejects. So `await onPost(...)` would have awaited `undefined`, resolved on the
next microtask, and run the success branch unconditionally — **the fix would have looked complete and
changed nothing.** `ThreadView` therefore calls `mutateAsync`, and the composer prop docs say so at
the call site.

Generalised: a resolving `onPost`/`onSubmit` is a *promise that the note exists*. A parent that
swallows its own failure re-introduces #176 one layer up, silently.

### Deferred state is guarded by a ref, not by a functional updater

The plan prescribed `setBody((prev) => (prev.trim() === t ? '' : prev))` to handle text typed during
the flight (`docs/plans/v0.8.2-composer-dataloss.md` §2.3 A1). **That is the same data-loss class in a
new location.** A state updater can gate a `setState`, but it cannot gate a *side effect*:
`onDraftClear?.()` still fires unconditionally, so mid-flight typing yields on-screen text with the
persisted entry **deleted**. The reporting effect is keyed on `[body, onDraftChange]` and guarded by
`lastReported`, so with `body` unchanged it never re-reports and the entry stays gone. Moving the
callback inside the updater is not an option either — React may double-invoke updater functions.

Both composers therefore keep a `bodyRef` / `draftRef` written in lockstep with `setState` (in
`onChange` and in the success clear, never during render) and read **after** the await. One check
gates the whole reset block.

### What is deferred, and why each deferral is load-bearing

`SimpleComposer` defers two things (the draft, `onDraftClear`). `ThreadComposer` defers five: `draft`,
`onDraftClear`, `manuallyFrozen`, `anchorless`, `focused`. They are deferred **together** — the
persisted entry and the on-screen draft are cleared together or not at all.

**A retry posts the original `t`, even if the user edits the body.** The anchor tracks the moment the
user chose, not the text; a retry that silently re-anchors to a later second is the subtler
data-loss bug this contract also prevents. Two deferrals do the work: keeping `draft` keeps
`hasDraft` true, which pins `frozenAt` through `nextFrozenAt`'s two `hasDraft` branches; and keeping
`anchorless` stops a restored (timestamp-less) draft from inventing an anchor from the mount-time
playhead on retry.

**`focused` is deferred for a different reason than the code once claimed.** It is *not* needed to
protect the anchor: `composer-chip.ts`'s `nextFrozenAt` returns `prev` in **both** `hasDraft` branches
and `chipTime` returns `frozenAt` whenever `hasDraft`, so while a draft exists `focused` has no effect
on the anchor at all. The real reason is DOM consistency: on the failure path the user is looking at a
textarea that still holds DOM focus, so setting `focused = false` would make React state lie about the
DOM, with no `focus` event ever arriving to correct it — leaving the component in
`!focused && hasDraft`, the state `composer-chip.ts` documents as "should not occur in normal UX".

### Clobbered success: reset nothing

A **clobbered success** — the post resolved, but the user typed during the flight — resets nothing, so
the newer text, the persisted entry and the freeze state all stay in agreement. The measured cost is
that a restored (anchorless) draft's follow-on note stays anchorless and is silently untimestamped
(#200). That is deliberate here: resetting `anchorless` alone would create a hybrid state nothing
tests, and the failure it trades for — inventing an anchor for text whose moment is genuinely unknown
— is worse. The "+ time" affordance stays visible for the user to fix it by hand.

### Two mechanisms coexist, deliberately

The feed `Composer.submit` also never clears — but by a different mechanism: `App` remounts it via a
`key` change (`` key={`${draftBody ?? 'fresh'}-${successCount}`} ``) on success only, so a failed
create leaves the key alone and the text plus cursor survive. Settled by #23. **Both mechanisms
satisfy this ADR's contract; neither is wrong.**

The feed composer was **not** converted, and should not be: `ThreadView` does not re-key its
composers, and adding that means lifting per-thread draft state into `App` through v0.7's persistence
wiring (plan §2.2). This is worth stating explicitly because `ThreadComposer`'s `error` docblock says
it "Mirrors the feed Composer's UX" — true of the error surface, false of the clearing mechanism.
Someone reading that line and "unifying" the two would regress #23.

## Alternatives

- **#176's own proposed fix: move the clear into the mutation's `onSuccess` in `ThreadView`.** Not
  taken. It works for the youtube branch but needs the parent to reach into composer-local state
  (`manuallyFrozen`, `anchorless`, `focused`, the clobber comparison) that has no business leaving the
  composer, and it leaves the plain branch — which has no mutation object — without an answer.
  Composer-awaits-and-clears-on-resolve keeps the whole reset in one place. #176's "Fix" section is
  therefore *not* what shipped; do not reopen it on that basis.
- **A shared `useComposerSubmit` hook.** Rejected. The deferral set differs per composer (two vs
  five), so the shared part is the trivial scaffolding — the in-flight ref, the try, the clobber
  compare — while the hard part, *which* state may be deferred and why each deferral is safe, would
  stay duplicated behind an `onCleared` callback, one indirection further from the state it governs.
  Consistent with the repo's existing stance for these three components: they "share patterns, not
  code" (`src/renderer/src/composer/SendButton.tsx`).
- **Keep clearing optimistically and re-seed the draft on failure.** Rejected: it needs the parent to
  hand the text back, restoring cursor position and the freeze state from outside, and it is
  observably wrong for the window between the clear and the rejection.
- **Convert the feed `Composer` to the await-and-clear mechanism for uniformity.** Rejected — see
  above; pure regression risk against #23 for no user-visible gain.

## Consequences

- **Both thread composers drop out of React Compiler memoization (#197).** Measured against the pinned
  `babel-plugin-react-compiler@1.0.0` with the repo's own options (`reactCompilerPreset()` in
  `electron.vite.config.ts` passes `{}`, so defaults apply), running the compiler over the real files
  after the oxc TS/JSX transform:

  | variant | result |
  |---|---|
  | both composers at the parent commits (`8576598` / `066fe0c`) | `CompileSuccess` |
  | both as shipped (`dc05dbe`) | skipped — `Todo: (BuildHIR::lowerStatement) Handle TryStatement with a finalizer ('finally') clause` |
  | both with the `finally` removed | skipped — `Refs: Cannot access refs during render` (×2) |
  | parent + an in-flight `useRef` and nothing else | skipped — same refs error |

  **There are two independent bails, not one.** The `finally` merely masks the refs one; deleting it
  recovers nothing. The refs diagnostic is a conservative false positive — `submit` is *defined*
  during render but the ref is only ever read inside it — and there is no way to satisfy this contract
  under 1.0.0 and stay compiled, because the double-submit guard must flip on the same stack as the
  first keydown, which requires a ref. No correctness or build impact: no `panicThreshold` is set, so
  the compiler logs and emits the original code. **Do not "clean up" the `try`/`finally` expecting
  memoization back.**
- **No in-flight affordance (#198).** `inFlight` is a ref, so a second Enter during the flight is a
  silent no-op and the send button stays enabled (`SendButton` has no `disabled` prop). Deliberate:
  making the flag observable means making it state, which reintroduces the per-keystroke render churn
  the ref avoids. The gap widened when the clear moved behind a full IPC round-trip, so a slow disk
  now reads as "nothing happened".
- **Every message thrown by `postPlain` is user-facing copy.** The plain branch gained a `role="alert"`
  line that renders the thrown message verbatim, so `'note not loaded'` is now UI text. Phrase throws
  in that path accordingly.
- **Post-submit assertions must be deferred past a microtask.** `submit()` is async, so state lands at
  least one microtask later and `fireEvent`-adjacent assertions go red. Negative assertions in
  particular cannot use `waitFor` — see `tests/flush.ts`.

## Sources

- `src/renderer/src/thread/SimpleComposer.tsx`, `src/renderer/src/thread/ThreadComposer.tsx` (`submit`)
- `src/renderer/src/thread/ThreadView.tsx` (`post` mutation, `postPlain`, the `mutateAsync` call site)
- `src/renderer/src/thread/composer-chip.ts` (`chipTime`, `nextFrozenAt`)
- `src/renderer/src/composer/Composer.tsx` (`submit`) + `src/renderer/src/App.tsx` (the `key` remount)
- `src/main/save-note.ts` (the duplicate-slug `collision` throw)
- `docs/plans/v0.8.2-composer-dataloss.md` §2.2 (the contract), §2.3 A1/A4
- Issues: utof/linsae#161, #176, #23, #197, #198, #200
- TanStack Query v5 — `mutate` returns `void`, `mutateAsync` returns `Promise<TData>`:
  https://tanstack.com/query/latest/docs/framework/react/reference/useMutation
- `adrs/0006-react-compiler.md` (the compiler pipeline), `adrs/0001-enter-key-sends.md`
