# Escape precedence: is there an architecture that retires the class?

Research doc, 2026-08-02. Scope: issue #18 as an instance of a class, not as a 5-line diff.
Trigger: `docs/canvas-vision.md:212` mandates an esc-precedence re-audit *every canvas milestone* —
a standing manual audit is the smell that the design, not the code, is wrong.

No source file was modified in producing this document.

---

## Verdict

- **16 independent Escape consumers exist today**, spread across 5 different attachment
  mechanisms (2 on `window`, 3 on `document` bubble, 2 on `document` capture, 1 element-capture,
  8 React `onKeyDown`). Precedence between them is an *emergent* property of DOM position ×
  event phase × mount order — it is nowhere written down as data, and three of the five
  mechanisms have no defined order relative to each other.
- **At least four live conflicts, not one.** #18 is real and confirmed at `Composer.tsx:163`, but
  it is the least severe of them. The worst is `SettingsPanel.tsx:253`, whose blanket
  `onKeyDown={(e) => e.stopPropagation()}` makes App's rung-1 "Escape closes settings"
  **dead whenever focus is inside the dialog** — the feature the ladder's first rung exists for.
- **`CloseWatcher` is available** in our runtime (verified first-hand: Electron 42.5.0 /
  Chromium 148.0.7778.271 exposes it) **and is the wrong tool anyway.** Verified in that runtime:
  two watchers created without an intervening user gesture are **grouped, and a single Escape
  closes both** — the exact bug class we are trying to kill, re-introduced at the platform level
  and made timing-dependent by the 5s transient-activation window. Additionally, synthetic
  `KeyboardEvent`s do not trigger it at all, so **no Vitest/RTL test could ever exercise it.**
- **`react-hotkeys-hook` does not solve this and cannot be made to.** Read at source: it has
  `scopes` (a global on/off set, not a stack), an `enabled` predicate, and element-`ref` scoping —
  but **zero notion of priority or stacking**. Two `useHotkeys('esc')` on `document` both fire, in
  `addEventListener` registration order. `CanvasStage.tsx:1504` already says exactly this.
- **All four surveyed headless libraries converge on the same algorithm**, and it is not
  `defaultPrevented`-passing: an **explicit LIFO registry** + **`keydown` capture-phase** +
  *"only the top entry runs at all"*. Radix, Headless UI, Ariakit and Base UI differ only in how
  they represent the stack (Set / state machine / DOM marking / floating tree).
- **Recommendation: option (b), an in-house registry — but tiered LIFO, not plain LIFO, and with
  the ordering logic extracted as a pure function.** Plain mount-order LIFO is insufficient for
  linsae because two of our consumers (App's 4-rung ladder, CanvasStage's 8-step cascade) are
  *ladders inside a single layer*, and several layers are long-lived panes rather than transient
  popups. ~4 new files / ~180 new lines + ~14 touched files. This is milestone work, not an
  inline fix — it breaches the `CLAUDE.md` §Inline-fix gate on every capability axis.

---

## Inventory of Escape consumers in linsae

Sixteen consumers act on Escape. Two further sites are not consumers but distort the picture and
are listed below the table.

| # | file:line | attachment | what it dismisses | gate | stops propagation? |
|---|---|---|---|---|---|
| 1 | `src/renderer/src/App.tsx:795-824` | `useHotkeys('esc')` → `document`, bubble | 4-rung ladder: settings → palette (⌘K/⌘O/⌘P) → one-shot placement → focused note | each rung guards its own state bool | no |
| 2 | `src/renderer/src/canvas/CanvasStage.tsx:1520-1566` | native `keydown` **capture** on the canvas viewport node | 8-step cascade: create/edit composer → edge-drag → drag-or-marquee → edge-target picker → edge label → picker → placement → edge selection → note selection | viewport subtree only | `stopPropagation()` when it consumes |
| 3 | `src/renderer/src/composer/Composer.tsx:162-176` | React `onKeyDown` on the `<textarea>` | question-mode pill, then edit-mode cancel | — | yes, in both branches |
| 4 | `src/renderer/src/canvas/Picker.tsx:145-149` | React `onKeyDown` on the cmdk input | the `/` picker | — | `stopPropagation()` |
| 5 | `src/renderer/src/canvas/EdgeTargetPicker.tsx:138-142` | React `onKeyDown` on the cmdk input | the drop-in-empty edge-target picker | — | `stopPropagation()` |
| 6 | `src/renderer/src/canvas/RecentPopover.tsx:130-140` | `document`, **capture** | the ⌘J recent popover | `if (!open) return` | `stopPropagation()` |
| 7 | `src/renderer/src/feed/ContextMenu.tsx:128-157` | `document`, **capture** | the note context menu | mounted only while open | `stopImmediatePropagation()` |
| 8 | `src/renderer/src/feed/Feed.tsx:334-344` | `document`, bubble | feed selection mode (clears `selectedIds` + `selMenu`) | `if (!selectionMode) return` | **no** — and no typing-target guard |
| 9 | `src/renderer/src/palette/CommandMenu.tsx:115-119` | React `onKeyDown` on the cmdk input | the ⌘K command palette | — | `stopPropagation()` |
| 10 | `src/renderer/src/palette/QuickSwitcher.tsx:123-127` | React `onKeyDown` on the cmdk input | the ⌘O quick switcher | — | `stopPropagation()` |
| 11 | `src/renderer/src/palette/ContentSearch.tsx:169-173` | React `onKeyDown` on the cmdk input | the ⌘P content search | — | `stopPropagation()` |
| 12 | `src/renderer/src/pdf/PageIndicator.tsx:169-180` | React `onKeyDown` on the page input | the page-jump draft (`setDraft(null)`) | rendered only while editing | `stopPropagation()` **on every key**, not just Escape |
| 13 | `src/renderer/src/pdf/useExcerptCapture.ts:162-166` | **`window`**, bubble | a pending PDF excerpt | mounted whenever a PDF pane has a scroller | **no** |
| 14 | `src/renderer/src/annotate/AnnotateEditor.tsx:487-503` | **`window`**, bubble | 2-state: opens the discard/keep prompt, or dismisses that prompt | mounted only while the editor is open | **no** (it `preventDefault()`s only) |
| 15 | `src/renderer/src/thread/ThreadComposer.tsx:338-347` | React `onKeyDown` on the chip input | the timestamp-chip manual entry | rendered only while `chipEditing` | **no** |
| 16 | `src/renderer/src/dev/RevealPlayground.tsx:373` | `useHotkeys('escape')` → `document`, bubble | the DEV reveal playground | `DEV_PLAYGROUND` only | no |

Not consumers, but they shape the outcome:

- **`src/renderer/src/settings/SettingsPanel.tsx:253`** — `onKeyDown={(e) => e.stopPropagation()}`
  on the `role="dialog"` div. Blanket, unconditional, all keys. It has no Escape handler of its
  own. See conflict **G**.
- **`src/renderer/src/yt/inject/youtube-guest.ts:208`** —
  `document.addEventListener('keydown', function (e) { e.stopPropagation(); }, true)` inside the
  YouTube guest frame, to stop YouTube's own shortcuts fighting host hotkeys. See Q4 §Electron.

**Attachment-mechanism census.** `window` bubble: 2 (#13, #14). `document` bubble: 3 (#1, #8, #16).
`document` capture: 2 (#6, #7). Element capture: 1 (#2). React `onKeyDown` (which React 19 attaches
at the root container, *below* `document`): 8 (#3, #4, #5, #9, #10, #11, #12, #15).

### Which pairs can be simultaneously active, and which actually conflict

Bubble order is `target → … → document → window`. So a `window` listener runs **after** a
`document` one; a `document`-**capture** listener runs before everything, including every React
`onKeyDown`. `PageIndicator.tsx:172-178` states this in-repo: *"React's `stopPropagation` calls the
NATIVE one too … and React's root listener sits below `document` … Capture-phase listeners still
run — they fire before this."*

**A — #18, the filed one. Real.** `Composer.tsx:163` tests `mode === 'question'` before line 169's
`editMode`. `docs/specs/v0.1-rolling-feed-and-search.md:271-272` orders them the other way:

> 3. Else if the composer is in edit mode → cancel edit, revert composer to empty paragraph mode.
> 4. Else if the composer is in question mode → drop back to paragraph mode (clear `?` promotion).

Symptom as filed: Escape on a question-typed note opened for edit clears the pill instead of
cancelling the edit. Confirmed by reading, not inferred.

**B — AnnotateEditor vs App's ladder. Real, double-fire.** #14 is on `window`; #1 is on `document`;
neither calls `stopPropagation`. `document` runs first. `App.tsx:1511` keeps `<CommandMenu>` mounted
app-wide and `App.tsx:724-731` binds ⌘K with `enableOnFormTags`, so the palette can be opened while
a thread — and inside it an open `AnnotateEditor` (`ThreadView.tsx:1041`) — is up. One Escape then
closes the palette (#1 rung 2) **and** opens the annotate discard prompt (#14). Two consumers, one
press.

**C — `useExcerptCapture` vs App's ladder. Real, same shape.** #13 is a bare `window` listener with
no gate beyond "a PDF pane is mounted" and no `stopPropagation`. Escape aimed at the ⌘K palette also
runs `clear()` on a pending excerpt. Damage is bounded (the excerpt is only *pending*), but it is
the same "one press, two consumers" violation.

**D — `useExcerptCapture` vs App's `placing` rung. Real, arguably benign.**
`App.tsx:810-817` documents that Escape cancels one-shot placement when focus is outside the canvas
viewport — i.e. in the PDF pane. #13's `window` listener fires immediately after, clearing the
excerpt too. Probably the desired *combined* effect, but it is nowhere stated, and it violates
`docs/specs/v0.4-canvas-mvp.md:355`'s "exactly one consumer per press".

**E — ContextMenu shadows the Composer silently. Real.** #7 is `document`-capture with
`stopImmediatePropagation()`; #3 is a React `onKeyDown` below `document`. With a note context menu
open and focus in a question-mode composer, Escape closes the menu and the composer's question-clear
**never runs at all** — its `stopPropagation` is moot because it is never reached. This may be the
right UX; it is not written down anywhere, and nothing tests it.

**F — ContextMenu vs RecentPopover. Latent, not live.** Both are `document`-capture (#6, #7) and #7
calls `stopImmediatePropagation()`, so between them the winner is whichever
`addEventListener` ran first — i.e. React effect order between two independently mounted
components, which is undefined. They are **not co-active today**: `RecentPopover` is gated
`enabled: viewMode === 'canvas'` (`App.tsx:775-783`) and `NoteContextMenu` is imported only by feed
components (`NoteBubble.tsx:8`, `MediaFeedNote.tsx:10`, `PdfFeedNote.tsx:10`, `Feed.tsx:10`), and
feed/canvas are mutually exclusive views. A canvas card right-click menu — a plausible next
milestone — makes this live with undefined ordering.

**G — Settings Escape is dead when the dialog has focus. Real, and the worst of them.**
`SettingsPanel.tsx:253` stops *all* keydown propagation at the dialog div. `#1`'s rung 1
(`if (settingsOpen) { setSettingsOpen(false); return }`, `App.tsx:798-801`) is a `document`-bubble
listener, so it never sees the event once focus is inside the dialog. The panel has no Escape
handler of its own — `rg` over the file finds only `onClick={onClose}` at `:238` and `:280`.
So Escape closes settings **only** while focus is still outside the dialog. The ladder's first rung
is conditionally dead, and no test covers it.

**H — two `document`-bubble `useHotkeys` for the same key. Latent, DEV-only.** #16
(`RevealPlayground.tsx:373`) and #1 (`App.tsx:795`) both bind Escape on `document`; both fire, order
undefined. Gated behind `DEV_PLAYGROUND`, so it is not a shipping bug.

**Not a conflict:** the Composer (#3) vs Feed's selection-Esc (#8). #8 has no typing-target guard,
but #3's React `stopPropagation` does reach the native event *below* `document`, so #8 is shielded.
The shielding is accidental — it depends on React 19's root-container attachment — but it holds.

---

## Q1. The layer-stack pattern in mature headless libraries

### Radix UI — `DismissableLayer`

Package layout verified 2026-08-02: source lives at
`packages/react/dismissable-layer/src/dismissable-layer.tsx` on `radix-ui/primitives@main`
(confirmed via `gh api repos/radix-ui/primitives/git/trees/main`). Both the unified `radix-ui`
package (v1.6.7) and the granular `@radix-ui/react-dismissable-layer` (v1.1.19) are published
today, so the restructure did not orphan the old path.

The stack is a `Set` in context:

```js
const DismissableLayerContext = React.createContext({
  layers: new Set<DismissableLayerElement>(),
  layersWithOutsidePointerEventsDisabled: new Set<DismissableLayerElement>(),
  branches: new Set<DismissableLayerBranchElement>(),
  dismissableSurfaces: new Set<DismissableLayerBranchElement>(),
});
```

Topmost is computed by index, exploiting `Set`'s insertion order:

```js
const layers = Array.from(context.layers);
const index = node ? layers.indexOf(node) : -1;
const isHighestLayer = node ? index === layers.length - 1 : false;
```

The decisive detail — **non-top layers do not even subscribe**:

```js
React.useEffect(() => {
  if (!isHighestLayer) { return; }
  ownerDocument.addEventListener('keydown', handleKeyDown, { capture: true });
  return () =>
    ownerDocument.removeEventListener('keydown', handleKeyDown, { capture: true });
}, [ownerDocument, isHighestLayer, handleKeyDown]);
```

and the handler treats `defaultPrevented` as a veto the *consumer* can exercise:

```js
const handleKeyDown = useCallbackRef((event: KeyboardEvent) => {
  if (event.key !== 'Escape') { return; }
  onEscapeKeyDown?.(event);
  if (!event.defaultPrevented && onDismiss) {
    event.preventDefault();
    onDismiss();
  }
});
```

So `onEscapeKeyDown` is a *hook for the consumer to cancel the dismissal* (call
`event.preventDefault()` inside it and `onDismiss` is skipped) — not a competition channel between
layers. `disableOutsidePointerEvents` is orthogonal to Escape: it only drives
`document.body.style.pointerEvents = 'none'` and the derived
`isPointerEventsEnabled = index >= highestLayerWithOutsidePointerEventsDisabledIndex`.

### Headless UI (Tailwind Labs)

`packages/@headlessui-react/src/hooks/use-escape.ts` is 19 lines and delegates the whole question:

```ts
export function useEscape(enabled, view = document.defaultView, cb) {
  let isTopLayer = useIsTopLayer(enabled, 'escape')
  useEventListener(view, 'keydown', (event) => {
    if (!isTopLayer) return
    if (event.defaultPrevented) return
    if (event.key !== Keys.Escape) return
    cb(event)
  })
}
```

`useIsTopLayer(enabled, scope)` is a **named-scope LIFO stack machine** — the closest published
analogue to what linsae needs:

```ts
export function useIsTopLayer(enabled: boolean, scope: string | null) {
  let id = useId()
  let stackMachine = stackMachines.get(scope)
  let [isTop, onStack] = useSlice(stackMachine, /* selectors.isTop / .inStack */)
  useIsoMorphicEffect(() => {
    if (!enabled) return
    stackMachine.actions.push(id)
    return () => stackMachine.actions.pop(id)
  }, [stackMachine, enabled, id])
  if (!enabled) return false
  if (onStack) return isTop
  return true   // optimistic: assume top until the push lands
}
```

Its own doc comment states the goal in our terms:

> `<Dialog><Menu>…` — *"Pressing escape on an open `Menu` should close the `Menu` and not the `Dialog`."*

Note it is `window`-level and **bubble** phase (`useEventListener(view, 'keydown', …)`), unlike
Radix's document-capture. It gets away with it because the stack, not the phase, decides.

### Ariakit

Ariakit uses neither a Set nor a stack machine, but two DOM-derived mechanisms
(`packages/ariakit-react-components/src/dialog/dialog.tsx`):

1. **DOM marking** for topmost-ness — `isElementMarked(dialog)`, maintained by
   `markTreeOutside()` / `walkTreeOutside()` in `dialog/utils/mark-tree-outside.ts`. The comment
   is explicit:

   ```ts
   // Ignore the event if the current dialog is marked by another dialog.
   // This guarantees that only the topmost dialog will close on Escape.
   if (isElementMarked(dialog)) return false;
   ```

2. **A per-event `WeakMap` memo** so a single physical Escape is decided exactly once no matter how
   many listeners see it:

   ```ts
   const [escapeEvents] = useState(
     () => new WeakMap<KeyboardEvent, { accepted: boolean; defaultPrevented: boolean }>(),
   );
   const acceptEscape = useEvent((event: KeyboardEvent) => {
     if (event.key !== "Escape") return false;
     if (!event.bubbles) return false;
     const result = escapeEvents.get(event);
     if (result) {
       if (event.defaultPrevented && !result.defaultPrevented) return false;
       return result.accepted;
     }
     if (event.defaultPrevented) return false;
     …
   });
   ```

   It runs the decision from a `document` **capture** listener, a React `onKeyDownCapture`, and a
   React `onKeyDown`, all funnelling into `hideOnEscapeEvent` — the WeakMap is what keeps three
   entry points from triple-firing.

### Base UI (MUI)

`packages/react/src/floating-ui-react/hooks/useDismiss.ts`. Precedence comes from the
**FloatingTree** (parent/child popup relationships), not mount order:

```ts
const hasBlockingChild = useStableCallback(
  (bubbleKey: '__escapeKeyBubbles' | '__outsidePressBubbles') => {
    const nodeId = dataRef.current.floatingContext?.nodeId;
    const children = tree ? getNodeChildren(tree.nodesRef.current, nodeId) : [];
    return children.some(
      (child) => child.context?.open && !child.context.dataRef.current[bubbleKey],
    );
  },
);
```

```ts
const closeOnEscapeKeyDown = useStableCallback((event) => {
  if (!open || !enabled || !escapeKey || event.key !== 'Escape') { return; }

  // Wait until IME is settled. Pressing `Escape` while composing should
  // close the compose menu, but not the floating element.
  if (isComposingRef.current) { return; }

  if (!escapeKeyBubbles && hasBlockingChild('__escapeKeyBubbles')) { return; }
  …
  store.setOpen(false, eventDetails);
  if (!eventDetails.isCanceled) { event.preventDefault(); }
  if (!escapeKeyBubbles && !eventDetails.isPropagationAllowed) { event.stopPropagation(); }
});
```

Listener registration (`:665-667`) — note the composition listeners riding alongside:

```ts
addEventListener(doc, 'keydown', closeOnEscapeKeyDown),
addEventListener(doc, 'compositionstart', handleCompositionStart),
addEventListener(doc, 'compositionend', handleCompositionEnd),
```

Base UI is the only one of the four that handles IME. See Q4.

### The common algorithm

Strip the four implementations of their representation choices and the same four steps remain:

1. **Maintain an explicit ordered registry of dismissable layers**, pushed on mount / popped on
   unmount. Representation varies (insertion-ordered `Set`, `useId` stack machine, DOM marking,
   parent/child tree) — the *existence* of the registry does not.
2. **Exactly one entry — the top — is eligible.** Radix and Headless UI make the non-top entries
   inert (Radix does not even attach their listener). Ariakit and Base UI let all listeners run but
   have every non-top entry return early.
3. **One `keydown` listener does the deciding**, at a single well-known node (`document` or
   `window`), so the outcome does not depend on where in the tree the event originated.
4. **`defaultPrevented` is a veto, not a race.** It is how a *consumer* says "I want to keep this
   layer open"; it is never how two layers decide which of them wins. Every library uses the
   registry for that.

linsae currently has none of (1)–(3) and uses `stopPropagation` as an ad-hoc, position-dependent
substitute for (2).

---

## Q2. Does `react-hotkeys-hook` already solve this?

Installed version: **5.3.2** (`package.json` devDependencies; `node_modules` confirms `5.3.2`).
Source read at `packages/react-hotkeys-hook/src/lib/useHotkeys.ts` on `main` via `gh api`.

**Attachment node and phase:**

```ts
const domNode = ref || _options?.document || document
domNode.addEventListener('keyup', handleKeyUp, _options?.eventListenerOptions)
domNode.addEventListener('keydown', handleKeyDown, _options?.eventListenerOptions)
```

Default is `document`, **bubble**. `eventListenerOptions` is a real, typed escape hatch —
`types.ts` declares `EventListenerOptions = { capture?, once?, passive?, signal? } | boolean`, so
`{ eventListenerOptions: { capture: true } }` is supported. linsae uses it **nowhere**
(`rg eventListenerOptions src/` → no hits).

**Ref scoping** — the hook's return value is a ref callback; attach it and the listener moves to
that element, plus this guard:

```ts
if (ref !== null) {
  const rootNode = ref.getRootNode()
  if ((rootNode instanceof Document || rootNode instanceof ShadowRoot) &&
      rootNode.activeElement !== ref && !ref.contains(rootNode.activeElement)) {
    stopPropagation(e)
    return
  }
}
```

where `stopPropagation` is the module-local helper that does **all three**:

```ts
const stopPropagation = (e: KeyboardEvent): void => {
  e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation()
}
```

This is the mechanism behind the docs' *"the innermost focused element takes precedence"* claim for
nested scoped hotkeys. It is **DOM-position + focus** scoping — the same idea `CanvasStage` already
hand-rolls — not a stack. The source carries an all-caps TODO acknowledging it is not fully right:

```
// TODO: SINCE THE EVENT IS NOW ATTACHED TO THE REF, THE ACTIVE ELEMENT CAN NEVER BE INSIDE THE REF.
// THE HOTKEY ONLY TRIGGERS IF THE REF IS THE ACTIVE ELEMENT. THIS IS A PROBLEM SINCE FOCUSED SUB
// COMPONENTS WON'T TRIGGER THE HOTKEY.
```

**`scopes` / `HotkeysProvider`** — a global set of active scope names, not a stack:

```ts
export function isScopeActive(activeScopes: string[], scopes?: Scopes): boolean {
  if (activeScopes.length === 0 && scopes) { return false }
  if (!scopes) { return true }
  return activeScopes.some((scope) => scopes.includes(scope)) || activeScopes.includes('*')
}
```

evaluated at the top of the registration effect, so an inactive scope means the listener is never
attached. Two *active* scopes both binding Escape both fire. linsae does not use
`HotkeysProvider` at all (`rg HotkeysProvider|useHotkeysContext src/` → no hits), so `activeScopes`
is the default and every binding is unconditionally in scope.

**`enabled`** — two distinct behaviours worth knowing. A literal `false` short-circuits
*registration*; a predicate registers the listener and bails inside it:

```ts
if (enabledRef.current === false || !isScopeActive(activeScopes, memoisedOptions?.scopes)) { return }
```
```ts
maybePreventDefault(e, hotkey, preventDefaultRef.current)
if (!isHotkeyEnabled(e, hotkey, enabledRef.current)) { return }
```

Note the order: `preventDefault` is applied **before** the `enabled` check, so a hotkey disabled by
predicate still calls `preventDefault()` if `preventDefault: true`.

**`keydown` vs `keyup`** — both supported, `keydown` is the default:

```ts
if ((memoisedOptions?.keydown === undefined && memoisedOptions?.keyup !== true) ||
    memoisedOptions?.keydown) { listener(event) }
```

**Priority / stacking: none.** There is no registry, no ordering, no `isTop`. Two mounted
`useHotkeys('esc')` bindings on `document` both run; the order is `addEventListener` order, which is
React layout-effect order (`useSafeLayoutEffect` = `useLayoutEffect`) — children before parents on
first mount, but re-appended to the tail on any effect re-run, so it is not stable across
re-renders. **There is no documented pattern for LIFO precedence.** This confirms the in-repo claim
at `CanvasStage.tsx:1503-1505`:

> Precedence is by event-phase + DOM position — NOT react-hotkeys-hook registration order (which is
> undefined between two document listeners).

**Verdict:** `react-hotkeys-hook` is fine as a *binding* library and should be kept for ⌘K/⌘O/⌘P/
⇧1/arrows. It contributes nothing to precedence, and `{ eventListenerOptions: { capture: true } }`
is a useful thing to know about but is not a substitute for a registry.

---

## Q3. Native platform semantics

### WAI-ARIA APG

`https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/` — Keyboard Interaction table:

> **Escape:** Closes the dialog.

The APG modal-dialog page notes its example *"Demonstrates multiple layers of modal dialogs"* but
**does not specify** which layer Escape closes when several are open. The APG is a per-pattern
document; the cross-pattern precedence question we are asking is out of its scope. Nothing in the
APG constrains our design beyond "Escape must dismiss something dismissable".

*Unverified:* I did not fetch the alertdialog / menu / menubar / combobox / listbox / tooltip /
disclosure pages individually. Their Escape rows are well-known (combobox: close the popup and keep
the value; menu: close and return focus to the trigger; tooltip: dismiss), but I am marking that
recollection as unverified rather than citing pages I did not read this session.

### `CloseWatcher` — verified first-hand in our runtime

This was the highest-value question, so I probed the real binary rather than reading a support
table. Method: `xvfb-run ./node_modules/.bin/electron` on a scratch main script, `loadFile` of a
blank page, `webContents.executeJavaScript` for the assertions, and `webContents.sendInputEvent` to
deliver **trusted** Escape key events through the browser input pipeline.

**Availability — yes:**

```
PROBE {"typeofCloseWatcher":"function",
       "proto":["oncancel","onclose","close","destroy","requestClose","constructor"],
       "c1":"ok","c2":"ok","c3":"ok",
       "syntheticEscapeFiredClose":0,
       "afterRequestClose":1,
       "hasDialogEl":"function"}
VERSIONS {"electron":"42.5.0","chrome":"148.0.7778.271","v8":"14.8.178.33-electron.0","node":"24.17.0"}
```

So: `CloseWatcher` exists, the full API surface (`requestClose` / `close` / `destroy` /
`oncancel` / `onclose`) is present, and three can be constructed without user activation without
throwing. This matches the shipping history — Chrome 120 shipped it, it was disabled over a
`<dialog>` interaction, and Chrome 126 re-enabled it
([Chrome 126 release notes](https://developer.chrome.com/release-notes/126)); we are 22 majors past
that.

**Trusted Escape ordering — CloseWatcher runs after JS keydown listeners, and is LIFO:**

```
TRUSTED_ESC_1 ["doc-capture","doc-bubble","B:cancel","B:close","A:cancel","A:close"]
TRUSTED_ESC_2 ["doc-capture","doc-bubble"]
```

**This is the disqualifying result.** Watchers `A` and `B` were created back-to-back with no
intervening user gesture, and a **single Escape closed both**. That is the spec's abuse-prevention
grouping, quoted from the [WICG explainer](https://github.com/WICG/close-watcher):

> **Free close watcher**: Pages can create one ungrouped `CloseWatcher` without user activation …
> **Grouping without activation**: When multiple watchers are created without intervening user
> activation, they are grouped together so *"a single close request will close them both."*

MDN says the same:

> "You can create `CloseWatcher` instances without user activation … However, if you create more
> than one `CloseWatcher` without user activation, then the watchers will be grouped, so a single
> close request will close them both."
> — [MDN: CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher)

**Confirming the mechanism — with user activation, LIFO works perfectly:**

```
GESTURE_ESC1  ["B"]            # created via executeJavaScript(code, userGesture=true)
GESTURE_ESC2  ["B","A"]
NOGESTURE_ESC1 ["D","C"]       # created without: ONE Escape closed both
```

Ordering is confirmed LIFO (WICG: *"If more than one is active at a given time, then only the
most-recently-constructed one gets events delivered to it."*) — **but only when each construction
is covered by transient user activation.** In linsae, plenty of layers open outside an activation
window: anything opened from a React effect, a `useMutation` `onSuccess`, a `setTimeout`, or more
than ~5 s (Chromium's transient-activation lifetime) after the last input. Two such layers silently
merge into one group and one Escape kills both — nondeterministically, depending on wall-clock
timing since the user last touched the keyboard. That is strictly worse than the bug class we are
trying to retire.

**`preventDefault()` on keydown suppresses the close request:**

```
PREVENTDEFAULT ["doc-capture","blocker-pd","doc-bubble"]
```

A capture-phase listener calling `event.preventDefault()` stopped the close request entirely — no
`cancel`, no `close`. Good news for coexistence (it means adopting CloseWatcher piecemeal will not
double-fire against handlers that already `preventDefault`), but it also means several of our
existing handlers already silently suppress it.

**Testability — fatal for our harness:** `syntheticEscapeFiredClose: 0`. A
`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))` does **not** trigger a
CloseWatcher, because a close request is a platform-mediated signal, not a DOM event. Every
component test in this repo dismisses Escape with `fireEvent.keyDown` / `dispatchEvent`. **No
Vitest/RTL test could ever cover CloseWatcher-based dismissal** — it would be Playwright-only,
via `page.keyboard.press('Escape')`. Independently, happy-dom 20.9.0 has no `CloseWatcher` at all
(`rg CloseWatcher node_modules/happy-dom/lib` → no hits; `'CloseWatcher' in window` → `false`), so
the tests would not merely be weak, they would throw.

One further gotcha for a hybrid design: the WICG explainer notes the `cancel` event *"only fires if
the page has received transient user activation,"* and *"once it fires for one instance, it will not
fire again for any instances until the page gets user activation again."* Our one genuine
`cancel`-with-confirmation use case — `AnnotateEditor`'s discard prompt (`AnnotateEditor.tsx:487-503`)
— would therefore be unreliable.

**Conclusion on Q3:** `CloseWatcher` is available and correct for its intended use (a *single*
user-gesture-opened modal that also wants Android back-button parity). It is **not** a general
LIFO close stack for an app with a dozen programmatically-managed layers, and it is untestable in
our harness. Do not adopt it as the precedence mechanism. It remains a reasonable *later*
enhancement for one or two genuinely modal, gesture-opened surfaces, if Android/back-gesture parity
ever matters — which, for a desktop Electron app, it does not.

---

## Q4. Ordering and event-mechanics pitfalls

### `keydown` vs `keyup` vs `keypress`

`keypress` is deprecated and never fires for Escape — it is not a candidate. The real choice is
`keydown` vs `keyup`, and **`keydown` is correct**, for three reasons visible in our own code:

- Every library surveyed uses `keydown` (Radix, Headless UI, Ariakit, Base UI — all four).
- `keydown` repeats on key-hold; `keyup` does not. For a *cascade* this is arguably a feature
  (hold Escape → unwind the stack) but it must be a deliberate decision, not an accident.
- We already have a live `keydown`/`keyup` split bug class in-repo for a different key:
  `useCanvasCamera.ts:185-206` tracks space on both, and `CanvasStage.test.tsx:126-128` documents
  why — *"the feed|canvas segment would fire its space-activation on keyup"*. Mixing phases for one
  key across components is exactly how that happened.

`react-hotkeys-hook` defaults to `keydown` (Q2), and all 16 of our consumers already use `keydown`.
No change needed; it just needs to be written down so it stays true.

### Capture vs bubble for a global handler

A single `document`-capture listener **strictly dominates every other consumer we have**, including
all eight React `onKeyDown` handlers — React 19 attaches its listeners at the root container, which
is a descendant of `document`, so a `document`-capture listener runs first no matter where the
event originated. `PageIndicator.tsx:172-178` already relies on this fact in the opposite direction.

Verified in both engines that a capture listener on the *target node itself* also runs before a
bubble listener on that same node, regardless of registration order:

```
happy-dom  AT_TARGET_ORDER          ["CAPTURE-registered-second","bubble-registered-FIRST"]
Chromium   CHROMIUM_AT_TARGET_ORDER ["CAPTURE-registered-second","bubble-registered-FIRST"]
```

(Both probed this session; happy-dom 20.9.0 matches Chromium 148 here, so a test that depends on
this ordering is trustworthy.)

Full propagation order confirmed in happy-dom for a deep target:

```
DEEP_TARGET  ["vp-CAPTURE","ta-target","vp-bubble","document-bubble","window-bubble"]
CAPTURE_STOP ["vp2-CAPTURE-stop"]        # stopPropagation() in an ancestor capture listener
                                          # prevents the target's own listener from running
```

The practical consequence for the recommendation: a single `document`-capture dispatcher can
**subsume** `CanvasStage`'s viewport-capture cascade without regression, because `document` is an
ancestor of the viewport and therefore runs earlier in the same phase.

### IME composition — **nothing in linsae handles this**

`rg "isComposing|229|compositionstart|compositionend|onCompositionStart" src/` returns **zero
hits** across the entire repository. We have three composers (`Composer.tsx`, `ThreadComposer.tsx`,
`SimpleComposer.tsx`, unified on `useAutoGrowTextarea`) and none of them, nor any of the 16 Escape
consumers, checks composition state.

The correct behaviour, and the reason it matters, is stated most clearly by Base UI:

> ```ts
> // Wait until IME is settled. Pressing `Escape` while composing should
> // close the compose menu, but not the floating element.
> if (isComposingRef.current) { return; }
> ```

MDN's guidance requires checking **both** signals, not just `isComposing`:

```js
eventTarget.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) { return; }
  // do something
});
```

> "`compositionstart` may fire *after* `keydown` when typing the first character that opens the IME,
> and `compositionend` may fire *before* `keydown` when typing the last character that closes the
> IME. In these cases, `isComposing` is **false even though the event is part of composition**, so
> checking `keyCode === 229` is also necessary."
> — [MDN: keydown event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)

Base UI hedges further by tracking `compositionstart`/`compositionend` on the document itself
(`useDismiss.ts:665-667`) with a timeout, rather than trusting per-event flags.

**Current impact on linsae:** a CJK user pressing Escape to cancel an in-progress conversion in the
composer today gets the conversion cancelled by the IME **and** whatever our ladder decides to
dismiss — the note being edited, the question pill, the palette. This is a real, unhandled
correctness bug, and it is one line in a centralised dispatcher versus 16 lines spread across 16
files. It is a strong independent argument for centralisation.

happy-dom does support the flag (`KeyboardEvent.isComposing` is declared readonly in
`node_modules/happy-dom/lib/event/events/KeyboardEvent.d.ts:14`) and it is settable from the event
init dict (probed: `new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }).isComposing
=== true`), so this **is** testable in our existing harness. `keyCode` defaults to `0` and is also
settable via init.

### `event.defaultPrevented` as coordination channel vs an explicit stack

The four libraries answer this consistently, and it is the opposite of what the phrasing of the
question suggests: **`defaultPrevented` is never used to arbitrate between layers.** It is used for
exactly two things —

1. *Consumer veto.* Radix's `onEscapeKeyDown?.(event); if (!event.defaultPrevented && onDismiss)` —
   the component's own consumer says "keep me open".
2. *Deference to something outside the system.* Headless UI's `if (event.defaultPrevented) return`
   — some non-Headless-UI handler already dealt with this event.

Arbitration between layers is always the registry (`isHighestLayer`, `isTopLayer`, `isElementMarked`,
`hasBlockingChild`). The reason is structural: `defaultPrevented` is a single global bit with no
ordering, so using it for arbitration makes the winner depend on listener registration order — which
is precisely the undefined thing everyone is trying to escape. linsae's current use of
`stopPropagation` has the same defect, plus it breaks the *other* consumers' ability to observe the
event at all (conflict **E**).

### Electron specifics

- **`before-input-event`** is available and would let the main process intercept Escape before the
  page sees it. From the [webContents docs](https://www.electronjs.org/docs/latest/api/web-contents):
  *"Emitted before dispatching the `keydown` and `keyup` events in the page. Calling
  `event.preventDefault` will prevent the page `keydown`/`keyup` events and the menu shortcuts."*
  We use it nowhere (`rg "before-input-event|globalShortcut" src/main` → no hits), and we should not
  start: it adds an IPC hop and a second source of truth for the same key.
- **HTML fullscreen.** The webContents docs document `enter-html-full-screen` /
  `leave-html-full-screen` but say nothing about Escape exiting fullscreen. Chromium's built-in
  Escape-exits-fullscreen behaviour is browser-level UI, not a DOM event we can observe or order
  against. `PlayerPane.tsx:27` already notes we ship no fullscreen affordance — *"only whatever the
  bare webview happened to accept (#169)"*. **Unverified**, and worth one Playwright assertion if a
  fullscreen affordance ever lands.
- **The `<webview>` guest — genuinely unresolved, and my probe was invalid.** I built a host page
  with a `<webview>` whose guest swallows all keydown (mirroring
  `youtube-guest.ts:208`), focused the guest, and sent Escape. The host saw it in both the
  guest-focused and host-focused cases:

  ```
  GUEST_FOCUSED_HOSTLOG ["host-doc-capture:Escape","host-win-bubble:Escape"]
  HOST_FOCUSED_HOSTLOG  ["host-doc-capture:Escape","host-win-bubble:Escape"]
  ```

  **This proves nothing**, because `webContents.sendInputEvent` injects directly into the *host*
  webContents' input pipeline and bypasses the OS-level focus routing that a real key press would
  follow. The identical result in both cases is the tell. The real question — does a physical
  Escape reach the host renderer while the YouTube guest holds focus — remains **unverified**. The
  guest is a separate frame in a separate process, so architecture says it does not, and
  `youtube-guest.ts:208`'s `stopPropagation` would be irrelevant either way (it operates on the
  guest's own document). The valid experiment needs real key injection: `xdotool key Escape`
  against the X window (not installed here), or `@playwright/test`'s `page.keyboard.press('Escape')`
  against the packaged app with the player focused — which is exactly what the v0.8.1 visual
  harness (#191) makes possible. **File this as a one-assertion follow-up, not as a known bug.**

---

## Q5. Testing — what a falsifiable precedence test looks like

The project gotcha this must answer: *a green test proves nothing until you have seen it go red* —
v0.8 shipped ten vacuous assertions. For Escape precedence the vacuous shape is specific and easy
to write by accident:

```tsx
// ❌ VACUOUS — passes under BOTH orderings.
fireEvent.keyDown(textarea, { key: 'Escape' })
expect(screen.queryByText('QUESTION — ESC TO CLEAR')).toBeNull()
```

That asserts only that *something* happened. It is green today (the question branch runs) and it
would be green after the fix too (`onCancel` unmounts the whole composer, so the pill also
disappears). **Inverting the precedence does not make it fail.**

A precedence test is falsifiable only if it asserts **both halves** — the winner fired *and the
loser did not* — with both consumers genuinely co-active:

```tsx
// ✅ FALSIFIABLE — red today, green after #18's fix.
it('Esc in a question-typed note in edit mode cancels the edit, leaving the pill alone', () => {
  const onCancel = vi.fn()
  const onSubmit = vi.fn()
  render(
    <Composer
      editMode                       // ─┐ both consumers active simultaneously:
      initialMode="question"         // ─┘ editMode (spec step 3) AND question (step 4)
      initialBody="why does this happen"
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  )
  const ta = screen.getByRole('textbox')
  fireEvent.keyDown(ta, { key: 'Escape' })

  // winner fired …
  expect(onCancel).toHaveBeenCalledTimes(1)
  // … and the loser did NOT. The pill must survive: cancelling an edit is the
  // parent's job to unmount, so this Composer instance keeps its question mode.
  expect(screen.getByText(/QUESTION/i)).toBeInTheDocument()
})
```

Red-first proof: today `Composer.tsx:163` takes the question branch, `setMode('claim')` removes the
pill and `return`s before line 169, so `onCancel` is never called — **both** assertions fail. Swap
the branches and both pass. That is the falsifiability the project rule demands, and it is why the
test must name the loser explicitly.

For a registry-based architecture the same principle generalises, and the highest-value move is
that **the ordering logic becomes a pure function** and is tested with no DOM at all:

```ts
// resolveEscape.test.ts — no DOM, no React, no fireEvent.
it('picks the highest tier, and within a tier the most recently mounted', () => {
  const entries = [
    { id: 'app-ladder', tier: Tier.App,      seq: 0, enabled: true },
    { id: 'canvas',     tier: Tier.Surface,  seq: 1, enabled: true },
    { id: 'picker',     tier: Tier.Popover,  seq: 2, enabled: true },
    { id: 'settings',   tier: Tier.Modal,    seq: 3, enabled: true },
  ]
  expect(resolveEscape(entries)?.id).toBe('settings')
  expect(resolveEscape(entries.filter((e) => e.id !== 'settings'))?.id).toBe('picker')
})

it('is order-independent: shuffling the registry does not change the winner', () => {
  // THIS is the assertion that current architecture cannot make at all.
  expect(resolveEscape(shuffle(entries))?.id).toBe('settings')
})

it('skips disabled entries', () => { … })
```

The order-independence test is the one that retires the class. Today, precedence *is* registration
order, so there is no way to write it; the moment it exists, adding a canvas mode is a table entry
whose correctness a unit test proves, not a manual audit.

Then exactly one integration-shaped component test per real conflict pair (B, C, E, G above),
asserting winner-fired-and-loser-untouched.

### What happy-dom can and cannot do here

Probed this session against happy-dom 20.9.0:

| capability | status |
|---|---|
| capture → target → bubble ordering, deep target | ✅ correct (`DEEP_TARGET` above) |
| capture-before-bubble on the *same* node | ✅ matches Chromium 148 exactly |
| `stopPropagation()` from an ancestor capture listener suppressing the target | ✅ correct |
| `document` → `window` bubble ordering | ✅ correct (needed to reason about #13/#14) |
| `KeyboardEvent.isComposing`, settable from init | ✅ available — **IME precedence is testable** |
| `KeyboardEvent.keyCode` (the 229 sentinel) | ✅ settable, defaults to `0` |
| `CloseWatcher` | ❌ absent entirely (`'CloseWatcher' in window === false`) |

What it cannot do, and therefore what needs `@playwright/test` against real Electron (the v0.8.1
harness, #191):

- **Real focus semantics.** happy-dom tracks `document.activeElement`, but there is no real tab
  order, no focus ring, and no browser focus-follows-click. Conflict **G** (settings Escape dead
  once focus enters the dialog) is *focus-conditional* — a component test can `.focus()` a node to
  approximate it, but only the real app proves the user actually lands there.
- **Anything CloseWatcher.** Not merely weak — it would throw.
- **The `<webview>` guest focus question** (Q4). No `<webview>` in happy-dom, no second process.
- **Chromium's own Escape behaviours** — exiting HTML fullscreen, leaving pointer lock. These are
  browser UI, invisible to any DOM-level test.
- **No layout.** `getBoundingClientRect()` returns zeros. Irrelevant to Escape precedence directly,
  but it means a test cannot assert "the popover that is visually on top wins" — which is another
  reason the tier must be *declared data*, not inferred from geometry or z-index.

---

## Recommendation

### (a) Fix #18's two branches and keep auditing every milestone

**Cost:** ~5 lines, one commit, today.
**What it buys:** conflict **A** only.
**What it leaves:** conflicts **B, C, D, E, G** live, **F** and **H** latent, IME entirely
unhandled, and `canvas-vision.md:212`'s standing re-audit mandate intact and growing. Every new
canvas mode adds another hand-verified ordering relationship across five attachment mechanisms.
The audit is O(n²) in consumers and there are already 16.

**Verdict: necessary but not sufficient.** Do it regardless — it is a real user-visible bug with a
cited spec violation — but do not let it close the question.

### (b) In-house registry — tiered LIFO, pure resolver — **RECOMMENDED**

Mirror the common algorithm from Q1, with two deliberate departures from plain Radix-style LIFO,
both forced by linsae's actual shape:

1. **Handlers return `boolean` ("I consumed it"), not `void`.** Two of our consumers are *ladders
   inside one layer* — `App.tsx:795-824` has 4 rungs, `CanvasStage.tsx:1523-1564` has 8 steps. A
   flat stack of layers cannot express "inside the canvas, cancel the drag before the picker".
   Letting one registry entry own an internal cascade preserves both cascades verbatim and keeps
   the diff mechanical. The dispatcher walks top-down and stops at the first `true` — which *is*
   `docs/specs/v0.4-canvas-mvp.md:355`'s "exactly one consumer per press", enforced structurally
   for the first time.
2. **A small tier enum above mount-order LIFO.** Radix gets away with pure LIFO because everything
   it manages is a transient popup. We mix transient popups (picker, context menu, palette) with
   long-lived panes (PDF reader, thread, canvas) whose mount order relative to a popup is
   meaningless — `useExcerptCapture` mounts when the PDF dock opens, which may be long after the
   canvas mounted, and mount-order LIFO would silently rank it above the canvas cascade. Suggested:
   `Modal > Popover > TransientMode > Surface > App`, LIFO within a tier.

Sketch:

```ts
// escape/tiers.ts
export const Tier = { App: 0, Surface: 1, TransientMode: 2, Popover: 3, Modal: 4 } as const

// escape/resolveEscape.ts   ← pure, no DOM, unit-tested (Q5)
export function resolveEscape(entries: readonly EscapeEntry[]): EscapeEntry | null

// escape/escapeStore.ts     ← zustand, matching ADR 0040/0042/0045 precedent
//   register(entry) / unregister(id); monotonic seq for LIFO-within-tier

// escape/useEscapeLayer.ts
export function useEscapeLayer(opts: {
  id: string; tier: Tier; enabled: boolean; onEscape: () => boolean
}): void

// escape/installEscapeDispatcher.ts  ← ONE document-capture listener, app-wide
//   if (e.key !== 'Escape') return
//   if (e.isComposing || e.keyCode === 229) return        // ← Q4, one line, fixes it everywhere
//   const top = resolveEscape(store.getState().entries)
//   if (top?.onEscape()) { e.preventDefault(); e.stopPropagation() }
```

**Why `document`-capture is safe:** verified in Q4 that it strictly dominates React 19's
root-container listeners *and* `CanvasStage`'s viewport-capture listener (`document` is an ancestor,
same phase, so it runs earlier). The migration cannot lose a race it does not already win.

**Size:** 4 new impl files (~180 lines incl. TSDoc) + 2 test files, then ~14 touched files for the
migration. Conflicts **B, C, E, G** and latent **F, H** all resolve as a consequence of the
mechanism, not as individual fixes. IME becomes one line at one site instead of sixteen.

**This is explicitly milestone work, not an inline fix.** Against `CLAUDE.md` §Inline-fix gate it
breaches ≤4 impl files, ≤3 new control-flow tokens, ≤12 hunks, and ≤120 total churn — every
capability-bounded gate. Two batches: (1) registry + resolver + dispatcher + tests, no behaviour
change, nothing migrated; (2) migrate the 16 call sites, deleting `stopPropagation` calls as each
site moves.

### (c) Adopt `CloseWatcher`

**Rejected on first-hand evidence, not on a compatibility table.** It is present in our runtime
(Chromium 148), but: layers created without transient user activation are **grouped, and one Escape
closes all of them** — verified (`NOGESTURE_ESC1 ["D","C"]`); the grouping depends on wall-clock
proximity to the last user input, so the bug would be intermittent; the `cancel` event is itself
activation-gated, breaking `AnnotateEditor`'s confirm-discard flow; and synthetic `KeyboardEvent`s
do not trigger it (`syntheticEscapeFiredClose: 0`), so **the entire Vitest suite goes blind** — and
happy-dom does not implement it at all, so such tests would throw rather than merely under-assert.
It solves a problem we do not have (Android back-gesture parity) at the cost of the one we do.

Keep it in mind for one narrow future case: a single, genuinely modal, user-gesture-opened dialog
that wants platform-native close semantics. Not as the architecture.

### What would falsify the recommendation

- **If the real conflict count were 1.** It is not — **B, C, E, G** are reachable today, and **G**
  disables a shipped feature. But if a reviewer walks the four and finds three unreachable in the
  actual UI, option (a) wins on ROI and the registry should wait.
- **If `document`-capture were not dominant.** The whole design rests on one listener outranking all
  16. Verified for React 19 root-container attachment and for `CanvasStage`'s viewport capture. A
  future portal into a *separate* React root or a shadow DOM boundary would break it — Radix carries
  `ownerDocument` and `getRootNode()` plumbing for exactly this reason, and we would need the same.
- **If the tier enum needs more than ~5 members within two milestones.** That would mean the tiers
  are encoding per-feature ordering rather than kinds-of-surface, i.e. the same audit problem
  wearing a type. Pre-register the tripwire: if a milestone adds a sixth tier, stop and reconsider.
- **If migrating `CanvasStage`'s 8-step cascade turns out not to be mechanical.** It should be a
  pure move — the `onEsc` body already returns after each `consume()`, so it maps 1:1 onto a
  `boolean`-returning handler. If it does not, batch 2 is larger than estimated and should be split.

---

## Open questions

1. **Does a physical Escape reach the host renderer while the YouTube `<webview>` guest has focus?**
   Unverified — my probe used `sendInputEvent`, which bypasses focus routing, so its result is
   invalid (documented in Q4). Needs `page.keyboard.press('Escape')` from the v0.8.1 Playwright
   harness (#191) with the player focused, or `xdotool` (not installed here). If Escape *is*
   swallowed, no registry design fixes it — it needs a guest→host RPC forward, which the
   `youtube-guest.ts` RPC channel already makes cheap.
2. **Is conflict E's shadowing (context menu silently eating the composer's question-clear)
   intended?** It reads like reasonable UX, but it is undocumented and untested, so it is
   indistinguishable from an accident. The registry forces the answer to be written as a tier.
3. **Should the cascade repeat on key-hold?** `keydown` auto-repeats. Holding Escape currently
   unwinds `CanvasStage`'s cascade step by step. Deliberate or accidental? Worth one line in the ADR
   either way.
4. **`docs/specs/v0.1-rolling-feed-and-search.md:270` step 2 is stale.** It says "Else if the
   backlinks pane is open → close it", but backlinks became a dock pane (ADR 0045) with no Escape
   handler at all (`rg Escape src/renderer/src/backlinks` → no hits), and `App.tsx:795-824` has no
   backlinks rung. Should closing a dock pane be Escape-dismissable? Nothing in `panes/` handles
   Escape today.
5. **`PageIndicator.tsx:179` stops propagation on *every* key**, not just the ones it handles, as a
   defensive shield against `Feed.tsx:336`/`:657`'s missing typing-target guards. Once a registry
   exists that shield is unnecessary — but the underlying missing guards on `Feed.tsx:334-344` are a
   separate bug that the registry does *not* fix, and should be filed independently.
6. **Should `react-hotkeys-hook` keep Escape at all?** Under option (b), `App.tsx:795`'s
   `useHotkeys('esc')` becomes a `useEscapeLayer` entry and `RevealPlayground.tsx:373` follows. The
   library keeps ⌘K/⌘O/⌘P/⌘1/⌘2/⌘J/⇧1/⇧0/arrows/⌫. Worth stating as an ADR line so nobody
   re-adds an Escape binding through it.

## Sources

**Read from repo source** (all `file:line` citations above).

**Library source, fetched 2026-08-02:**
- Radix `DismissableLayer` — `radix-ui/primitives@main:packages/react/dismissable-layer/src/dismissable-layer.tsx`
- Headless UI — `tailwindlabs/headlessui@main:packages/@headlessui-react/src/hooks/use-escape.ts` and `.../use-is-top-layer.ts`
- Ariakit — `ariakit/ariakit@main:packages/ariakit-react-components/src/dialog/dialog.tsx`, `.../dialog/utils/mark-tree-outside.ts`
- Base UI — `mui/base-ui@master:packages/react/src/floating-ui-react/hooks/useDismiss.ts`
- react-hotkeys-hook 5.3.2 — `JohannesKlauss/react-hotkeys-hook@main:packages/react-hotkeys-hook/src/lib/useHotkeys.ts`, `.../validators.ts`, `.../types.ts` (+ context7 `/johannesklauss/react-hotkeys-hook` for the scopes docs)

**Specs / docs:**
- [MDN: CloseWatcher](https://developer.mozilla.org/en-US/docs/Web/API/CloseWatcher)
- [WICG close-watcher explainer](https://github.com/WICG/close-watcher)
- [Chrome 126 release notes](https://developer.chrome.com/release-notes/126) — CloseWatcher re-enable
- [MDN: keydown event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event) — IME / `keyCode === 229`
- [WAI-ARIA APG: Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [Electron webContents docs](https://www.electronjs.org/docs/latest/api/web-contents) — `before-input-event`
- [Electron 42 release blog](https://www.electronjs.org/blog/electron-42-0) — Chromium 148 baseline

**First-hand probes** (Electron 42.5.0 / Chromium 148.0.7778.271 under `xvfb-run`, and happy-dom
20.9.0 under node; scripts in the session scratchpad, not committed): CloseWatcher availability and
API surface; CloseWatcher LIFO ordering with and without user activation; CloseWatcher vs synthetic
events; `preventDefault` suppression of close requests; AT_TARGET listener ordering in both engines;
happy-dom propagation ordering and `isComposing`/`keyCode` support; the (invalid) webview probe.
