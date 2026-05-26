# Ship-it Stack for a Local-First Telegram-Feed Note App (May 2026)

## TL;DR

- **Build it on Electron + Vite + React 19 + TypeScript (strict) + better-sqlite3 + Drizzle (schema/migrations) + Kysely (queries, optional) + react-virtuoso, with cmdk for the palette, react-markdown + remark-math + rehype-katex for rendering, and `react-pdf` 10.x for PDFs.** Confidence: **high**. This is the boring, AI-dense, well-typed stack that lets Claude Code be productive on day one and ships Phase 0 in an afternoon.
- **Don't pick Tauri for this app.** Two killers: (1) embedded YouTube via the IFrame API breaks under the `tauri://localhost` custom protocol (Error 153, open issue tauri-apps/tauri #14422), and (2) cross-platform WebView inconsistency (WebKitGTK on Linux, WebKit on macOS) eats more vibe-coding days than Electron's 150 MB of RAM ever will. Confidence: **high** for this app's specific YouTube/PDF requirements.
- **Don't add a state library yet, don't add an e2e harness yet, don't add Sentry, don't add a graph view. Add them when a concrete pain forces you to.** TanStack Query for DB caching, Zustand only when prop-drilling actually hurts, Playwright only after the second regression you wish you'd caught. Confidence: **high**.

## Key Findings — The Three Decisions That Actually Matter

### Decision 1 — Runtime shell: **Electron 30+ with electron-vite**

You'll see endless 2025/2026 benchmarks crowing that Tauri ships 12 MB installers and 30–50 MB idle RAM versus Electron's ~150 MB / 200–300 MB (johal.in, RaftLabs, OpenReplay). That's true and irrelevant for a single-user local desktop tool you'll run on a beefy dev machine. What matters here:

1. **YouTube IFrame Player API is broken in Tauri 2 production builds.** The `tauri://localhost` custom protocol does not provide a valid HTTP `Referer`, so YouTube returns Error 153 ("Video player configuration error"). You can switch to the `tauri-plugin-localhost` workaround, but that breaks the IPC bridge — community-confirmed trade-off in tauri-apps/tauri #14422.
2. **Screenshot-at-timestamp is a near-blocker on Tauri.** `tauri-plugin-screenshots` (xcap-based) screenshots **windows and monitors**, not a specific in-app webview region — and on macOS/Linux it requires OS-level permissions for capturing *other* windows. In Electron, `webContents.capturePage({x,y,width,height})` returns a `NativeImage` of any rect inside your own window in one call, no permission prompts.
3. **AI training-data density.** React + Electron is in essentially every code corpus from 2015 onward (Slack, VS Code, Discord, Obsidian, Logseq, 1Password all ship on it). Tauri 2 stabilized in late 2024 and most LLMs default to Tauri 1 APIs unless prompted — Scott Spence captured the same "training data cutoff" pain for Svelte 5: *"Claude 4 will still default to Svelte 4 sometimes if you're deep into a prompt and you're not specifically specifying 'Svelte 5' in your prompts."*
4. **Cold start.** Real-world Electron cold-start is ~1.0–1.5 s on a modern Mac; Tauri is ~0.4–0.8 s (Hopp benchmark). That's a delta you'll feel maybe twice a day. The HMR loop (Vite, identical in both) matters 100× more for day-to-day iteration speed.

Use **electron-vite** as the bootstrapper. It gives you Vite-native HMR for the renderer, separate `main`/`preload` builds with TypeScript, and good defaults. Bootstrap with `npm create @quick-start/electron@latest -- --template react-ts`.

Caveat where the Tauri argument flips: if you ever want this app on iOS/Android, switch. Tauri 2 has stable mobile; Electron has none.

### Decision 2 — Database access: **better-sqlite3 in main + Drizzle for schema/migrations + raw prepared statements for queries**

The community is split between Drizzle and Kysely for new TS work. Honest read:

- **Drizzle dominates by adoption** — npm trends shows `drizzle-orm` at **8,683,108 weekly downloads and 34,324 GitHub stars** (May 2026). That makes it the highest-AI-density modern TS ORM by a wide margin. Use `drizzle-kit` for the schema source-of-truth and for `drizzle-kit generate`/`migrate`.
- **Kysely is genuinely better at complex queries** — pure SQL builder with end-to-end types and no import-everything ceremony. Its homepage testimonials are unusually high-signal: Dax "thdxr" Raad (SST & opencode core team), Lee Robinson ("Cursor VP DX, Ex-Vercel": *"Type-safe SQL queries with PlanetScale and Kysely 😍"*), Theo "t3dotgg" Browne (Uploadthing creator / T3 Chat CEO), Tim Griesser (Knex.js creator). The Drizzle team officially ships `drizzle-kysely` so you can use both.
- **Or simpler: just use better-sqlite3 directly + a few `prepare()` statements at module load + a manual numbered-migrations folder.** For a single-user prototype, "raw SQL with thin wrapper + TypeScript types you write" is honestly fine and the most AI-legible thing in the world. Claude Code writes correct SQLite SQL with very high fidelity.

**Pragmatic recommendation:** Start with **Drizzle for schema + migrations, and raw `better-sqlite3` prepared statements for queries** (don't even pull in Kysely yet). If your queries get gnarly (lots of joins for backlinks/graph), add Kysely. Drizzle migrations handle FTS5 virtual tables via raw SQL in `drizzle-team/drizzle-orm` #2046 — there's no first-class binding, but `sql` `CREATE VIRTUAL TABLE ... USING fts5(...)` `` in a custom migration file is the documented pattern (see `delucis/astro-db-fts` for a working example).

Database access pattern: **all DB code lives in the main process**, exposed via `ipcMain.handle('db:posts.list', …)`. Renderer calls a thin typed RPC wrapper (`window.api.posts.list()`). This keeps the renderer process sandboxed, avoids native-module rebuild pain in renderer, and gives you a clean seam to mock for tests. Wrap each handler in a single transaction. Run `PRAGMA journal_mode = WAL` once at startup — the better-sqlite3 docs say *"it is generally important to set the WAL pragma for performance reasons"* and document >2000 5-way-join queries/sec on a 60 GB DB with proper indexing, which is wildly more than you need.

**FTS5 pattern:** External-content table with INSERT/UPDATE/DELETE triggers keeping a `posts_fts` mirror of the `posts.body` column. The SQLite docs walk through this exactly: `CREATE VIRTUAL TABLE posts_fts USING fts5(body, content='posts', content_rowid='id')`, then three triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE`) that maintain the index. Use `bm25()` ranking and `snippet()` for highlighted excerpts.

### Decision 3 — Don't ship local-first sync libraries; don't ship a state library

You said single-user, single-device, no sync. That means **RxDB, Triplit, ElectricSQL, PowerSync, and Yjs are all overkill** — they exist to solve sync conflicts you don't have. Adding any of them will burn a week and add a CRDT mental model on top of what should be `INSERT INTO posts`. Revisit only if you ever want sync.

State management: skip Zustand/Jotai/Redux until prop-drilling actually hurts. The 2025/2026 community consensus (DEV/Medium analyses, Kent C. Dodds): "useState + useReducer + Context for UI, TanStack Query for server/DB state, reach for Zustand only at proven pain." Use **TanStack Query as your DB cache layer** — every IPC call becomes `useQuery({ queryKey: ['posts', filter], queryFn: () => window.api.posts.list(filter) })` and you get caching, invalidation, optimistic updates, and request deduping for free.

## Details — Stack Table

| Axis | Pick | Why (1 line) | Confidence |
|---|---|---|---|
| Shell | Electron 30+ (electron-vite) | YouTube IFrame works, `webContents.capturePage` for screenshots, biggest AI corpus | High |
| Build | Vite 5 + TypeScript strict | Vite HMR is the gold standard; strict mode = "Christmas tree" compile errors | High |
| UI | React 19 | ~30M projects on GitHub vs ~500k for Svelte per XB Software; React 19 is stable | High |
| Styling | Tailwind + shadcn/ui (cmdk preinstalled) | Maximum AI density, zero CSS bikeshedding | High |
| DB | better-sqlite3 in main process | Synchronous API, fastest Node SQLite binding, WAL pragma | High |
| Schema/migrations | Drizzle + drizzle-kit (8.68M weekly downloads, 34.3k stars) | TS-first schema, decent migrations, huge AI corpus; FTS5 via raw `sql\`...\`` | High |
| Queries | Raw better-sqlite3 prepared statements (add Kysely later if needed) | Lowest cognitive cost for a prototype | Medium-high |
| IPC | `contextBridge.exposeInMainWorld` + typed handlers | Standard secure pattern; trivial to mock in tests | High |
| State (UI) | useState/useReducer + Context | YAGNI until proven | High |
| State (DB cache) | TanStack Query | The popular and AI-legible pattern in 2026 | High |
| Markdown | `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` | The default stack; ~1M weekly downloads | High |
| Math | KaTeX (via rehype-katex) | Faster than MathJax 2, pre-rendered (no flicker); MathJax 3 closes the gap but KaTeX wins on bundle/font-load | High |
| Virtualization | `react-virtuoso` (with `VirtuosoMessageList` for chat reverse-scroll) | Built specifically for chat-style human/chatbot UIs with bottom-anchor; TanStack Virtual reverse-scroll is a known pain (TanStack/virtual #195) | High |
| Command palette | `cmdk` (dip/cmdk, formerly pacocoursey/cmdk; 12.6k GitHub stars) | De facto standard; powers Linear/Raycast/Vercel; shadcn ships it | High |
| Keyboard | `react-hotkeys-hook` v5.3.2 (2,515,981 weekly downloads per npm trends) for in-app, Electron `globalShortcut` for OS-global | Hook API; tinykeys is a great minimalist alternative | High |
| Markdown attachments | Filesystem under `userData/attachments/<yyyy>/<mm>/<sha256>.<ext>`; DB stores path | Blobs in SQLite hurt perf and backups; filesystem is the standard pattern | High |
| YouTube embed | YouTube IFrame Player API directly (or `react-youtube` thin wrapper) + `webContents.capturePage` for screenshots | IFrame API gives `getCurrentTime()`, `onStateChange`, `seekTo()` | High |
| PDF | `react-pdf` (wojtekmaj) v10.4.x — 2,659,814 weekly downloads, 10,927 stars (npm trends, May 2026) — + custom selection→bbox layer; OR `react-pdf-highlighter-extended` 8.1 for a faster start | See PDF section below | Medium-high |
| Tests | Vitest + React Testing Library + jsdom; add Playwright for one happy-path e2e later | Vitest reuses Vite config; Jest is dead-weight in a Vite project | High |
| Lint/format | Biome (`biome.js`) | Single binary, faster than ESLint+Prettier, AI handles it fine | Medium |
| Schema validation | Zod | Use at IPC boundaries to validate untrusted data | High |

## Library-by-library short verdicts

### YouTube
- **Embed:** Drop the YouTube IFrame Player API script (`https://www.youtube.com/iframe_api`) directly. `react-youtube` is fine but a thin wrapper; you can write the equivalent in 30 lines and own it. Use `youtube-nocookie.com` only if privacy matters — note that it doesn't support all IFrame API features identically; stick with `youtube.com` if you need `getCurrentTime`.
- **Timestamp capture:** Poll `player.getCurrentTime()` on a 250 ms interval while playing, or capture on a cmd-shortcut. Round-trip back with `player.seekTo(seconds, true)`. Store as integer seconds in the DB.
- **Screenshot at timestamp:** Use Electron's `webContents.capturePage(rect)` where `rect` is the iframe's `getBoundingClientRect()`. Returns a `NativeImage`; `toPNG()` and write to `userData/attachments/...`. There is NO way to do this in a pure-web build because of cross-origin iframe CORS — `html2canvas` and friends silently fail on cross-origin iframes (MDN, html2canvas issue tracker). **This is your single biggest reason for picking Electron.**
- **Frame-accurate alternative (later):** `yt-dlp` + HTML5 `<video>` + `canvas.drawImage(video, ...)`. Gives you frame-perfect screenshots and a CORS-free pipeline. Defer until phase 2; capturePage is fine for v1.

### PDF (verified May 2026)
- **Primary recommendation:** `react-pdf` (wojtekmaj) v10.4.x + `pdfjs-dist` 5.7.x. **2,659,814 weekly downloads, 10,927 stars** (npm trends, May 2026), last published ~3 months ago, React 19 first-class. You write ~150 lines of selection→pdf-point glue using `viewport.convertToPdfPoint(x,y)` for storage (origin bottom-left, points) and `viewport.convertToViewportRectangle(...)` for re-render. Persist `{docId, pageNumber, x1, y1, x2, y2, quote}`. The quote anchor gives you resilience if PDFs get re-flowed.
- **Faster start:** `react-pdf-highlighter-extended` 8.1.0 (DanielArnould fork) — TypeScript-first, viewport-independent coords already in the `Highlight` shape, `scrollToHighlight` util built in, uses pdfjs-dist 4.4.x. Last npm publish was 5 Jul 2024 (so ~22 months stale by May 2026); ~95 stars. Use it to ship Phase 2 faster, fork it when it breaks.
- **Avoid:** Original `react-pdf-highlighter` (agentcooper) — no new npm release in ~2 years, bundled vulnerable pdfjs-dist, open issues throughout 2025 unanswered. PSPDFKit / Nutrient — no indie tier; Vendr-aggregated deals run $2.5k–$220k/yr.
- **Watch:** `react-pdf-highlighter-plus` (v1.0.8, May 2026) — promising TS-first newcomer with text+area+freetext+freehand+image highlights and an `exportPdf()` helper. Single maintainer, unproven. Worth a prototype later.
- **Text extraction for search:** `pdfjs-dist`'s `page.getTextContent()` returns the text items per page; concatenate and feed into your FTS5 index. Store one row per page in `pdf_pages_fts(pdf_id, page_number, text)`.

### LaTeX/Math
- **KaTeX, via `rehype-katex`** (in your `react-markdown` pipeline). Pre-renders on first paint, no flicker, no full-page reflow. MathJax 3 has narrowed the gap (per BigGo News' Nov 2025 comparison: "Some comparative testing now shows MathJax 3 actually outperforming KaTeX in certain scenarios, though KaTeX maintains advantages in font loading times and overall bundle size") but still loads code dynamically (network latency on first paint). KaTeX's feature subset covers everything a research note app needs.
- **Inline editing UX:** Use markdown with `$...$` inline and `$$...$$` block delimiters (the `remark-math` convention). Render live in a preview pane *or* render in place when the user blurs the input. Don't try to build inline-as-you-type WYSIWYG math editing — that's a year of work.

### Markdown
- `react-markdown` + `remark-gfm` (tables, strikethrough, task lists, autolinks) + `remark-math` + `rehype-katex` + `rehype-sanitize` if you ever render untrusted markdown (you don't, but free hygiene). For images, use a custom `components={{ img: MyImg }}` mapping that resolves your `attachments://` URLs to file paths via a custom Electron protocol handler.
- For 10k posts, **don't render 10k markdown ASTs at once** — render only the items the virtualizer says are visible, and memoize each rendered post by its content hash. With react-virtuoso's `itemContent`, each render is one post.
- **Backlinks parsing:** Custom `remark` plugin that walks the mdast for `Text` nodes matching `/\[\[([^\]]+)\]\]/g`, replaces them with `<wikilink>` nodes, and your `components` map renders them as clickable React. Also emits a list of outbound links into a context, so on save you can write `INSERT INTO links(from_post_id, to_slug)` rows.

### Command palette
- **`cmdk`** — battle-tested, used by Linear/Raycast/Vercel/shadcn-ui, **12.6k GitHub stars** (the repo has migrated to `dip/cmdk`, formerly `pacocoursey/cmdk`), MIT, written in TypeScript. Use `Command.Dialog` for the cmd-K modal. Built-in fuzzy search (uses the bundled `command-score`) so you don't need a separate `fuse.js` for the palette itself.
- For fuzzy search elsewhere (jump-to-note, attachment picker), **`uFuzzy`** is the fastest and smallest; **`fuse.js`** has the biggest AI corpus. Pick fuse.js unless you have a measured perf problem.

### Virtualization for the feed
- **`react-virtuoso`** with its dedicated `<VirtuosoMessageList>` component, which is specifically built for "human/chatbot conversations" with imperative scroll-position management when older messages prepend, new messages append, and the user scrolls. This is literally your use case. TanStack Virtual is excellent for regular lists but reverse-scrolling + variable heights is a known sharp edge — TanStack/virtual #195 documents the pain.
- Note: Virtuoso has a commercial license for some MessageList configurations — check before shipping a paid product, but for personal use the MIT components cover what you need.

### Keyboard shortcuts
- **`react-hotkeys-hook`** v5.3.2 — **2,515,981 weekly downloads** per npm trends (May 2026). Supports scopes for modal vs global. Best AI corpus.
- Caveat: as Hazel Duvall's Jan 2025 analysis "All Javascript Keyboard Shortcut Libraries Are Broken" pointed out, every JS keyboard library has subtle bugs around modifier handling. Tinykeys is arguably the most correct (defaults to `key`, supports `KeyA`-style code matching) but has a smaller corpus. Use `react-hotkeys-hook` for productivity, switch to `tinykeys` if you hit a layout-sensitive bug.
- **OS-global hotkeys:** Electron's `globalShortcut.register('CommandOrControl+Shift+Space', ...)`. Don't abuse this — register at most 1–2 (e.g., "quick capture window").

### Backlinks (architect now, build later)
- Schema:
  ```sql
  CREATE TABLE posts (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, body TEXT, created_at INTEGER, ...);
  CREATE TABLE links (from_post_id INTEGER, to_slug TEXT, PRIMARY KEY (from_post_id, to_slug));
  CREATE INDEX idx_links_to_slug ON links(to_slug);
  ```
- Recompute `links` on save by re-parsing the markdown — single-user, no concurrency, cheap.
- Backlinks panel: `SELECT p.* FROM links l JOIN posts p ON p.id = l.from_post_id WHERE l.to_slug = ?`.
- Graph view (future): `cytoscape.js` has the most AI training data of any graph-viz lib. `react-force-graph` is prettier out of the box but smaller corpus.

### Search
- **SQLite FTS5 only.** No client-side fuzzy index of 10k notes — FTS5 with `bm25()` on a contentless or external-content table will return ranked results in <5 ms at this scale. JS-side fuzzy search is for when you have <1000 items in memory already (the command palette).
- Search-as-you-type pattern: debounce 150 ms, run query in main, return top 50 with `snippet()`-highlighted previews.

## Skeleton directory structure

```
note-app/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json                  # "strict": true, "noUncheckedIndexedAccess": true
├── biome.json
├── drizzle.config.ts
├── src/
│   ├── main/                      # Electron main process
│   │   ├── index.ts               # app.whenReady, createWindow, IPC registration
│   │   ├── db/
│   │   │   ├── client.ts          # new Database(path), PRAGMA journal_mode=WAL
│   │   │   ├── schema.ts          # Drizzle schema
│   │   │   ├── migrations/        # generated by drizzle-kit + handwritten FTS5
│   │   │   └── queries/
│   │   │       ├── posts.ts       # listPosts, createPost, ...
│   │   │       └── search.ts
│   │   ├── ipc/
│   │   │   ├── posts.ts           # ipcMain.handle('posts:list', ...)
│   │   │   ├── attachments.ts
│   │   │   └── youtube.ts         # screenshot-at-timestamp
│   │   └── shortcuts.ts
│   ├── preload/
│   │   └── index.ts               # contextBridge.exposeInMainWorld('api', {...})
│   ├── shared/
│   │   ├── types.ts               # Post, Attachment, etc. — shared by main + renderer
│   │   └── zod-schemas.ts         # IPC payload validators
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── app/                   # feature folders, not type folders
│       │   ├── feed/
│       │   │   ├── Feed.tsx       # VirtuosoMessageList
│       │   │   ├── Post.tsx
│       │   │   └── Composer.tsx
│       │   ├── palette/CommandPalette.tsx   # cmdk
│       │   ├── youtube/YoutubeNote.tsx
│       │   └── pdf/PdfNote.tsx
│       ├── lib/
│       │   ├── api.ts             # typed wrapper over window.api
│       │   ├── markdown.tsx       # react-markdown config + custom components
│       │   └── hooks/             # useHotkeys, useFeedQuery, ...
│       └── styles.css
├── tests/
│   ├── unit/                      # Vitest, colocated *.test.ts where possible
│   └── e2e/                       # Playwright (add later)
└── resources/                     # app icons, prod assets
```

Key invariants:
- `src/shared/` is the only thing imported by both main and renderer; nothing platform-specific lives there.
- Every IPC channel has a Zod schema in `shared/zod-schemas.ts` and is parsed both on the handler side and the call site.
- Migrations are checked into git as `.sql` files; never edited, only appended.

## Phase 0 — blank window + SQLite + one post rendered (one day)

```bash
# 1. Bootstrap
npm create @quick-start/electron@latest note-app -- --template react-ts
cd note-app
npm i better-sqlite3 drizzle-orm zod @tanstack/react-query \
       react-markdown remark-gfm remark-math rehype-katex katex \
       cmdk react-hotkeys-hook react-virtuoso
npm i -D drizzle-kit @types/better-sqlite3 vitest \
         @testing-library/react @testing-library/jest-dom jsdom \
         @biomejs/biome electron-rebuild

# 2. Rebuild native module against Electron's Node
npx electron-rebuild -f -w better-sqlite3

# 3. First migration (handwritten, checked into src/main/db/migrations/0001_init.sql):
#    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT,
#                        body TEXT NOT NULL,
#                        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
#    CREATE VIRTUAL TABLE posts_fts USING fts5(body, content='posts', content_rowid='id');
#    CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
#      INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END;
#    CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
#      INSERT INTO posts_fts(posts_fts, rowid, body) VALUES('delete', old.id, old.body); END;
#    CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
#      INSERT INTO posts_fts(posts_fts, rowid, body) VALUES('delete', old.id, old.body);
#      INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END;

# 4. Main process: open DB, run unapplied migrations on startup,
#    register `posts:list` and `posts:create` handlers.
# 5. Preload:
#    contextBridge.exposeInMainWorld('api', {
#      posts: {
#        list: ()  => ipcRenderer.invoke('posts:list'),
#        create:(b)=> ipcRenderer.invoke('posts:create', b)
#      }
#    });
# 6. Renderer: <Feed /> using VirtuosoMessageList, <Composer /> with cmd-Enter
#    shortcut, useQuery(['posts'], () => window.api.posts.list()).

npm run dev   # window pops, post appears, search works.
```

## Anti-recommendations (what NOT to add)

1. **No state management library on day 1.** Not Zustand, not Jotai, not Redux. Use `useState`/`useReducer` + Context for UI; TanStack Query for DB cache. Add Zustand only when you can name the specific prop-drill you're solving.
2. **No local-first sync libraries** (RxDB, ElectricSQL, Triplit, PowerSync, Yjs). Single-user single-device means CRDTs are pure overhead.
3. **No ORM beyond Drizzle's schema/migrations.** Don't add Prisma — too heavy, doesn't run in Electron main without weird workarounds, generates a query engine you don't need.
4. **No commercial PDF SDK.** PSPDFKit/Nutrient deals run from a few thousand to six figures annually with no indie tier.
5. **No graph view in v1.** It's the kind of feature you spend a week on and then look at once a month. Build it after backlinks have produced enough graph structure to be interesting.
6. **No Sentry / Datadog / LogRocket.** Single user, single device. Use Electron's logging to a rotating file in `userData/logs/`. Sentry is a 200 KB renderer dependency and a privacy concern for a personal app.
7. **No Playwright on day 1.** Vitest unit tests covering the IPC handlers and a few component renders is the minimum viable safety net for a vibe-coded prototype. Add Playwright after the second "I broke the feed without noticing" incident.
8. **No Husky / lint-staged ceremony.** A `pnpm precommit` script with `biome check --apply` is enough for solo work.
9. **No nx/turbo/pnpm workspaces.** Single package. You'll know when you outgrow it.
10. **No Tailwind config goldplating.** Use the default theme + `@tailwindcss/typography` for markdown rendering.

## Migration paths (escape hatches)

| If… | Then… | Cost |
|---|---|---|
| Electron RAM becomes a daily annoyance | Re-host the renderer in Tauri 2 (your React code is portable), keep better-sqlite3 as a Node sidecar OR migrate to sqlx/rusqlite | 2–3 days; main blocker is rewriting IPC handlers in Rust |
| You want sync / multi-device | Add `electric-sql` or `rxdb` as a second layer over the existing SQLite; or just rsync the .db file | A weekend for naive sync; weeks for real CRDT |
| `react-pdf-highlighter-extended` breaks on a React 19.x point release | Fork it, or port to raw `react-pdf` + custom selection layer (~150 LOC) | A day |
| Drizzle migrations get painful | Drop drizzle-kit, keep handwritten numbered `.sql` files + a 30-line migration runner | Half a day |
| Markdown rendering of 10k posts feels janky | Pre-render markdown to HTML on save, store HTML in the DB next to the source, render with `dangerouslySetInnerHTML` (you control the input) | A day |
| You outgrow useState | Add Zustand. It's a 3-line store; no big-bang migration. | An hour per store |
| Tests slow down | Add `vitest --pool=threads` and `--isolate=false` | Trivial |

## Where the answer is genuinely uncertain in 2026

1. **Drizzle vs. Kysely vs. raw SQL.** All three are defensible. Drizzle has the bigger adoption (8.68M weekly downloads, 34.3k stars) and AI training data; Kysely has the better type ergonomics and more discriminating ecosystem fans (SST/Cursor/T3/Knex's creator). For a prototype, the differences are real but small. I'm betting on Drizzle for migrations only and raw better-sqlite3 for queries because that minimizes magic for the AI to get wrong.
2. **Svelte 5 vs. React for AI-coded apps.** Svelte 5 is genuinely nicer to write, but the training-data deficit is real and acknowledged even inside the Svelte community (e.g., the official `llms.txt` file). For *vibe-coded*, React still wins by a large margin in 2026.
3. **Biome vs. ESLint+Prettier.** Biome is faster, single-binary, and good enough; ESLint+Prettier has more AI training data and more plugin coverage. Either is fine. I'd default to Biome for a new prototype.
4. **react-pdf-highlighter-extended's maintenance.** It hasn't been published to npm in ~22 months as of May 2026 but the API is sound and the codebase is small. Reasonable to use; budget time to fork if needed.
5. **Tauri's WebView consistency story.** Tauri 2 is genuinely better than v1 here, but WebKitGTK on Linux still trails Chromium on web platform features, which bites you randomly. Two years from now this might be a non-issue.
6. **TanStack Query for local DB.** It's the popular pattern in 2026 but TanStack Query was built for HTTP semantics (stale-while-revalidate, refetchOnFocus, etc.). Some of those don't quite fit local IPC. You'll occasionally turn knobs off (`staleTime: Infinity`, no refetch on focus). Acceptable cost for the caching/invalidation/optimistic-update infrastructure you get for free.

## Comparison to existing tools — what to steal, what to skip

- **Obsidian** — Electron, no front-end framework (custom UI), markdown files on disk as source of truth, CodeMirror 6 for editing, sophisticated plugin API. Per the Aditya Raj teardown, Obsidian "is often praised for being lightweight and fast compared to many Electron apps. The developers achieved this by not using a heavy front-end framework; in fact, Obsidian's UI is largely custom-built without React or Angular." *Steal:* markdown-on-disk for portability. *Skip:* no front-end framework — they did this to keep bundle small, you do not need to.
- **Logseq** — Electron + ClojureScript + Datascript, recently migrated to a SQLite DB Version with `@sqlite.org/sqlite-wasm` in a Web Worker (per DeepWiki: "Persistence: Uses @sqlite.org/sqlite-wasm to provide a full SQL database within the browser or Electron environment"). *Steal:* the Web Worker DB pattern is a good fallback if you later want a pure-web build. *Skip:* ClojureScript (no AI training data); block-outliner model.
- **Heynote** — Electron, single-buffer stream-of-consciousness, CodeMirror. *Steal:* the radical minimalism and the one-keyboard-shortcut-to-everything ethos.
- **AppFlowy / AnyType** — Rust + Flutter and bespoke object DBs respectively. Not relevant to your stack.
- **Notesnook** — Electron + React + encrypted local DB. *Skip:* their encryption complexity is overkill for single-user.
- **Mem / Reflect / Capacities** — closed source, cloud-first; nothing to learn architecturally.

The TL;DR from the survey: **Electron + SQLite + markdown-on-disk-as-backup is the proven pattern.** Nobody who shipped a serious note-taker bet on Tauri yet. That's the most credible vote you'll get.

## Recommendations (staged, with thresholds)

**Now (day 0–1):** Bootstrap with `npm create @quick-start/electron -- --template react-ts`. Land Phase 0 (blank window + SQLite + one post rendered + cmd-K palette opens) in one sitting. Commit the migration SQL.

**Week 1:** Phase 1 — feed with virtuoso, markdown+KaTeX rendering, attachments-on-disk, FTS5 search. Target: 10k synthetic posts feel smooth (60 fps scroll, <50 ms search).

**Week 2:** Phase 2 — YouTube embed + timestamp capture + capturePage screenshot. PDF viewer with `react-pdf` and a basic page-link (don't ship highlighting yet).

**Week 3:** Phase 3 — wikilink parsing + backlinks panel + markdown export to a folder of `.md` files mirroring the DB.

**Backlog / change my recommendation if:**
- *Cold-start regularly exceeds 2 s on your machine* → start preloading common modules with lazy-import, or seriously evaluate Tauri.
- *RAM exceeds 1 GB after a day of use* → likely a renderer memory leak in markdown rendering; not a framework problem.
- *FTS5 search exceeds 100 ms on >50k notes* → add column indexes, switch to `bm25()` with weights, or add a trigram tokenizer.
- *You want sync* → add ElectricSQL or write a thin file-rsync wrapper; don't bolt CRDTs onto something that was single-user.
- *PDF highlighting becomes painful with `react-pdf-highlighter-extended`* → fork it, or port to raw `react-pdf` + 150 LOC of selection→pdf-point glue.

## Caveats

- **Cold-start and RAM numbers cited are from multiple 2025/2026 blog posts (RaftLabs, OpenReplay, johal.in, Hopp); they vary widely by app size and machine.** Tauri benchmarks have been disputed by tauri-apps/tauri #5889, which argues shared-memory accounting can make Electron look worse than it really is.
- **The "AI training data density" claims are extrapolations** based on relative GitHub/npm metrics (XB Software cites React being used by ~30M projects vs ~500k for Svelte) and on first-hand reports from Claude/GPT users (e.g., Scott Spence: *"Claude 4 will still default to Svelte 4 sometimes if you're deep into a prompt and you're not specifically specifying 'Svelte 5' in your prompts."*). They're directionally robust but not benchmarked.
- **Tauri's YouTube IFrame block** is an *open* issue (#14422); a fix may land, in which case Tauri becomes more viable. Re-check before starting if you do go Tauri.
- **`react-pdf-highlighter-extended` last published in mid-2024.** If maintenance picks up, my recommendation strengthens; if it stays dead, the pure `react-pdf` path is the safer bet.
- **`webContents.capturePage` of an iframe containing YouTube** works because Electron renders everything in the same process tree; this is *not* possible in a normal browser tab. It's the single biggest reason the rest of this stack hangs together.
- **Better-sqlite3's synchronous API** blocks the main process during queries. For a single-user local DB this is fine and actually preferable (no callback hell), but if you ever do batch jobs over 100k+ rows, use the worker_threads support in better-sqlite3 12.x.
- **Numbers cited are May 2026 snapshots** (e.g., drizzle-orm 8,683,108 weekly downloads / 34,324 stars; react-pdf 2,659,814 weekly downloads / 10,927 stars; react-hotkeys-hook 2,515,981 weekly downloads at v5.3.2; cmdk 12.6k stars in the migrated `dip/cmdk` repo). These move weekly; the relative ordering is what matters.