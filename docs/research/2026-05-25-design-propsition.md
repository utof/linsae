# A Defended Design for a Personal Note‑Taking App for Technical Material

**Scope.** A personal note system for a math‑trained user, optimised for (i) effortless capture of math lectures, technical PDFs, video lectures and ink, (ii) auto‑organisation as a side‑effect of capture rather than a separate ritual, and (iii) trajectory and metacognition: revisiting how thinking evolved, surfacing unrecognised gaps, preserving beginner‑mind questions, and answering one's own past questions. The recommendations below are written as positions, with explicit defenses, explicit "design judgment" labels where the literature is silent, and explicit "open question" labels where prototyping is needed.

A note on epistemic scaffolding. The cognitive‑science core of this design rests on five robust empirical results: the testing/retrieval‑practice effect (Roediger & Karpicke 2006; Karpicke & Blunt 2011); desirable difficulties and the spacing effect (Bjork 1994; Bjork & Bjork 2011); the self‑explanation effect, with caveats for high element‑interactivity material (Chi et al. 1989, 1994; Rittle‑Johnson meta‑analyses; Chen & Sweller 2018); the open‑learner‑model literature on visualising knowledge state to drive metacognition (Bull & Kay 2010, 2013, 2016); and the Mueller–Oppenheimer "longhand vs typing" finding for encoding, with the Morehead et al. (2019) replication caveat that the effect is fragile and probably mediated by reframing rather than mode per se. The HCI core rests on Marshall & Shipman's premature‑formalisation lineage (1995, 1999), Buckingham Shum's design‑rationale work, Joel Chan's discourse‑graph program (2022–2024), and the post‑Roam tool diaspora (Tana, Capacities, Anytype, Heptabase, Logseq, Reflect, Mem). The argumentation core rests on Toulmin (1958/2003), IBIS (Kunz & Rittel; Conklin's *Dialogue Mapping*), and the Lombrozo programme on explanation (2006, 2010, 2012, 2022).

---

## 1. The data‑model debate, decisively resolved

This is the section the previous draft handled badly. I will take strong positions, name the obvious objections, and answer them.

### 1.1 First‑class citizen: the **block** (a content unit with a stable ID), aggregated into **pages**, optionally typed via **supertags**

**Position.** The primitive is the **block**: an atomic content unit (a paragraph, a question, a claim, a math display, a stroke region) with a stable, canonical identifier; transcludable into other contexts; addressable by typed links; persistable across format changes. **Pages** are aggregates of blocks (with an outline structure); **types** ("supertags" in Tana, "object types" in Capacities/Anytype) are roles a block can play that bring schemas of properties.

**Defense against the obvious alternatives:**

- *Note‑first / file‑first (Obsidian, Bear, Apple Notes).* A file is too coarse for the trajectory use case. The unit you want to revisit is "the question I had on day 5 about the spectral sequence" — not "the file I started on day 5." Obsidian's block IDs (`^id`) are a retrofit; the experience reveals that block addressability was always wanted. The user has explicitly said the trajectory question is "what was I thinking about *X*," which requires sub‑page granularity.
- *Card‑first (Heptabase, Scrintal, Supernotes).* A card is just a renamed page; it does not solve the granularity problem. The card metaphor is an *interface* (spatial layout) layered on top of an underlying primitive; the primitive should still be smaller.
- *Pure block (Roam, Logseq).* Closer to right. Roam's contribution — block reference, block embed — is fundamental and underappreciated. Roam's mistake is the absence of a typed object layer above the block, which forced users into ad hoc attribute notation (`Author::`) and led to messy graphs.
- *Object‑oriented (Anytype, Capacities).* Capacities' "every object has a type" rule is too heavy for capture (Marshall & Shipman 1999 — premature formalisation): forcing a user mid‑lecture to choose "is this a Concept or a Theorem or a Question" violates effortless capture. Anytype's relation system is well‑modelled but again too heavy for capture.
- *Tana hybrid: block + supertag.* This is the right factoring. Bullets are first‑class blocks; supertags are optional, layered, and turn a block into a typed object only when the user is ready. This matches the **incremental formalisation** thesis (Shipman & McCall 1994; Shipman & Marshall 1999): "users enter information in informal/semi‑formal representation and gradually formalize it over time." Twenty‑five years later, Tana has shipped this idea as a product, and it works.

**Defended choice: blocks as primitive, pages as aggregator, supertags as optional types.** This is the Roam/Logseq/Tana lineage, refined: every paragraph, every math display, every PDF highlight, every ink stroke region gets a stable ID at write time; pages are just outlines of blocks with a title; supertags can be slapped on any block at any time without disturbing its content. The user can capture a lecture as a flat outline and never apply a single supertag and the system still works; tagging adds power, doesn't gate it.

### 1.2 Thought types: **3, not 6, not 5, not 4**

The previous draft proposed Question, Claim, Observation, Explanation, Tension, Connection. The user's critique was correct: Connection is structurally an edge, and Claim+Explanation is incoherent because explanations decompose into claims. The user also pushed correctly on "what's a mechanism vs a causal claim." The right answer requires going to the literature.

**The literature.** Lombrozo & Vasilyeva (Frontiers 2022) showed empirically that *explanatory judgments* and *causal judgments* about the same fact pattern dissociate: explanatory judgments are more sensitive to mechanism, causal judgments more sensitive to covariation. Mechanisms in the MDC sense (Machamer, Darden & Craver 2000) are "entities and activities organized such that they are productive of regular changes." Toulmin (1958) decomposes any argument into claim/grounds/warrant/backing/qualifier/rebuttal. IBIS (Kunz & Rittel 1970; Conklin 2003) reduces to **issue / position / argument** (three primitives, three relations). Joel Chan's discourse‑graph work (Chan, Akamatsu, Vargas et al. 2022; arXiv 2407.20666, 2024) settles on **question, claim, evidence**, with rhetorical relations on top.

**The decisive observation.** Across all of these traditions — Toulmin, IBIS, MDC, discourse graphs, micropublications, ScholOnto, SWAN, HypER — there are exactly two semantic primitives that are stable across schemes: **questions** and **propositions/claims**. Everything else (warrant, backing, rebuttal, evidence, mechanism, position, argument, observation, hypothesis, conjecture, theorem) is either (a) a *property* of a claim (its epistemic strength, its modality, its provenance) or (b) a *typed edge* between claims. There is also a third primitive needed for technical work: a **source pointer** (PDF page, lecture timestamp, book chapter) — a thing that is not a claim because it has no truth‑conditions, only a locator.

**Defended position: three thought types.**

1. **Question.** An open inquiry. Properties: status (open / parked / answered / dissolved), beginner‑mind flag (is this a question I asked when I knew nothing about the topic), origin (mid‑lecture, while‑reading, post‑hoc).
2. **Claim.** A proposition with truth‑conditions. Properties: `epistemic_strength` ∈ {conjecture, working‑hypothesis, confident, settled}; `epistemic_mode` ∈ {observed, inferred, derived, quoted, conjectured}; `provenance` (a Source pointer, or "mine"); `formality` (handwave / sketch / proof).
3. **Source.** A locator into external material. Properties: type (PDF, video timestamp, book, lecture), citation, anchor (page/time/section).

**Defenses against the obvious objections:**

*"What about Observation? Isn't 'I observed X' a different kind of thing from a Claim?"* No. "I observed that the spectral sequence collapses on E₂" is a Claim whose `epistemic_mode = observed` and whose `provenance = "mine, while computing"`. The grammar of the sentence — predicate with truth‑conditions — is the same as any other claim. Lombrozo (2010) is explicit: causal/explanatory cognition treats observation as one mode of asserting a proposition, not a different ontological category. Folding observation into Claim+mode gives you the same expressive power without proliferating types — and crucially, it lets you upgrade an observation to a confident claim later by changing one property, without rewriting the node.

*"What about Explanation? Surely an explanation is a kind of thought."* Yes — and it decomposes. An explanation is a *graph of Claims connected by typed edges* (mechanism‑step, supports, generalizes), terminating either in a more general Claim or in a Source. Lombrozo & Vasilyeva (2022) is consistent with this: an explanation is what you get when you assemble the right structure of claims and mechanism information; it isn't a separate ontological primitive. Making "explanation" a node type forces you to choose one of two bad options: (i) duplicate claims inside the explanation (de‑normalisation, breaks revision); (ii) make the explanation a thin wrapper containing only links, in which case it *is* an edge structure misnamed as a node. The clean factoring is: explanations live in the edge layer.

*"What's the difference between a mechanism and a causal claim?"* This was the user's specific challenge. The MDC answer is precise: a *causal claim* says "X causes Y." A *mechanism* is a structured story: entities E₁..Eₙ engaging in activities A₁..Aₘ in an organisation that produces the regular change from X to Y. So a mechanism is **a directed sub‑graph of claims connected by causal/componential edges, with E and A roles** — not a primitive. The right way to represent "the mechanism by which X causes Y" is: a Claim "X causes Y" plus a sub‑graph of Claims whose edges spell out how. If you wanted, you could mark the parent Claim with a property `has_mechanism: true` for filtering, but you should not introduce a separate Mechanism node type. Lombrozo's data does *not* require it: the cognitive distinction is between (a) judging covariation strength and (b) tracing mechanism structure, and both operate over the same underlying claims.

*"What about Tension?"* A tension is exactly an instance of the typed edge `contradicts` between two Claims (or a Question whose answer would resolve them). The user's intuition that tensions matter is correct, but the right move is to make `contradicts` a first‑class edge type that the system *surfaces actively* in the trajectory dashboard ("you have 3 unresolved tensions"). Tension does not earn a node type. When noticing a tension produces a question — which is the user's specific case — the user creates a Question node and links it to both claims by `addresses`, and the contradicts edge between them. Two operations, two clicks.

*"What about Definition? Theorem? Lemma? Example?"* These are domain‑specific roles for a Claim and belong in the supertag layer, not the thought‑type layer. A `#theorem` supertag on a Claim adds fields (statement, proof, dependencies). The Claim primitive remains. This is exactly the Tana model and matches Capacities/Anytype's "type is a property of a node" rather than "type is a node." Trying to bake Theorem/Lemma into the thought‑type layer fails for the same reason explanation fails: there is no upper bound on technical genres.

**Why N=3 is right and N=4 is wrong.** Adding a fourth type (most plausibly: a separate Hypothesis or Conjecture) buys you nothing that `epistemic_strength` doesn't already give you, and it costs you a forced choice at capture time ("is this a claim or a hypothesis?") that violates the friction principle. Adding a fifth (Observation) is wrong for the reasons above. **Why N=2 is wrong.** Collapsing Source into Claim destroys the "you cannot put truth‑conditions on a PDF page citation" distinction and makes provenance harder to query. The strict minimum is 3.

### 1.3 Tags: three **separate fields**, not one

The previous conversation noted three uses of tags: topic, state, action. Mainstream tools collapse these into a single tag namespace (Obsidian, Roam) — and users universally end up with messy filtering as a result. RemNote, Tana, Capacities, Anytype have all moved toward typed properties for a reason.

**Defended position. Three separate, typed metadata fields, not unified into a single hashtag namespace.**

1. **Topic** (`topics: [...]`). Stable subject‑matter classification. Multi‑value, hierarchical (e.g. `math/algebraic-topology/spectral-sequences`). Long‑lived. The "what is this about" axis. Suggested rule: topics describe enduring subject matter; you should not add topics for transient state.
2. **Status** (`status: <single value>`). The block's epistemic state. Single‑value, enumerated: `wtf | gap | seedling | working | confident | settled | parked`. Mutable; expected to change over time. The whole point of the trajectory dashboard is to see how status evolved. Modeled after Bull & Kay's open‑learner‑model dimension of "what does the learner know vs not know vs misunderstand."
3. **Action** (`actions: [...]`). Tasks attached to the thought. Multi‑value, enumerated and extensible: `ask-teacher | google | reread | derive-yourself | find-counterexample | ...`. Each action has a closeable lifecycle (open → done) and a date. This is the GTD/inbox layer, kept separate from epistemic state.

**Defense.** Collapsing these into one field has three concrete failures: (a) filtering is ambiguous ("show me all `#wtf`" returns both old gap‑markers and active confusions); (b) you cannot enforce single‑value semantics on status; (c) you cannot represent the lifecycle of an action (open vs done) in a flat tag system. Tana's supertag system, Notion's typed select/multi‑select, Obsidian Properties, and Logseq properties all evolved toward typed property fields because flat hashtags broke. The factoring above is the minimum defensible separation; further splits (e.g., separating `topics` into `domains` vs `concepts`) is YAGNI until the user demands it.

**Defense against the obvious objection — "this is too much overhead at capture."** No, because the capture path **does not require any of these fields**. You can write a paragraph, hit enter, and the block is captured with no tags at all. Topics get added later, often via passive mechanisms (the parent page's topic propagates; LLM suggests topics on review). Status defaults to nothing and is set only when the user wants to mark something. Actions are attached only when the user has a task in mind. This is Marshall–Shipman incremental formalisation: structure is **demand‑driven**, not capture‑gated.

### 1.4 Typed connections: **6 edges, not more**

Anytype, Logseq, Roam attributes, Tana fields, knowledge‑graph predicates, and the discourse‑graph schemas (HypER, micropublications, SWAN, ScholOnto) all converge on a small set of relations — typically 5–10 — that earn their place. The combinatorial expansion past that buys nothing in a personal system.

**Defended minimal set: 6 typed edge kinds.**

1. **`supports`** (Claim → Claim): X is a reason to believe Y. Subsumes Toulmin's grounds/data and IBIS's pro arguments. Inverse: `supported‑by`.
2. **`contradicts`** (Claim ↔ Claim): X and Y cannot both hold. Symmetric. Subsumes IBIS's con argument and the user's "tension."
3. **`prerequisite‑of`** (Claim/Question → Claim/Question): you must understand X before Y is intelligible. Critical for math: derivative before chain rule, group before ring. Inverse: `depends‑on`.
4. **`generalizes`** (Claim → Claim): X is a more general statement of which Y is an instance. Inverse: `specializes`. (Two names, one edge with direction.) Critical for math: lemma before theorem, theorem before corollary.
5. **`analogous‑to`** (Claim ↔ Claim): X structurally maps to Y in another domain. Symmetric. Critical for math: tensor product analogous to direct sum, manifold analogous to topological space.
6. **`addresses`** (Claim → Question): this Claim purports to answer that Question. Inverse: `answered‑by`. Critical for trajectory ("did I ever resolve this question?").

**Defense against six obvious additions:**

- *`explained‑by`* — collapses into `supports` plus a structural sub‑graph; redundant.
- *`supersedes`* — better modeled as a property `replaces: <id>` on the new Claim, not as an edge. Why: edges are queried bidirectionally; supersedure is asymmetric and acts as a redirect. (Bull & Kay's open‑learner‑model literature treats updated beliefs as state changes, not edges.)
- *`instance‑of`* — that's what supertags are for. Use `#theorem` not an edge.
- *`elaborates‑on`* — semantic noise; almost everything elaborates on something. Filtering on this returns the entire graph.
- *`refines`* — collapses into `generalizes`/`specializes` (inverse direction) plus a property change.
- *`cites`* (Claim → Source) — yes, this exists, but it's the trivial provenance pointer that already exists as the `provenance` property; you don't need a separate edge type unless you are publishing.

**Why 6 is right and 7+ is wrong.** Each additional edge type adds capture friction (the user must choose), filter complexity (more facets), and naming bikeshed risk. The 6 above cover: argumentation (supports/contradicts), structure (prereq, gen/spec, analogous), and the distinctive dialectic of personal learning (Q↔A). I challenge anyone to name a seventh that earns its place in a *personal* system; in a *collaborative* publishing system the answer is different (see Joel Chan's discourse graphs, which have ~10).

**Open question (flagged).** Whether `analogous‑to` should support a "with these correspondences" sub‑structure (e.g. an explicit map of which entities correspond) is undecided in the literature; I lean toward yes for math but flag it as a v2 prototype question.

### 1.5 The whole data model in one paragraph

Every paragraph, math display, ink region, PDF highlight is a **block** with a stable ID. Each block is by default an untyped chunk of content. A block can be promoted to a **Question**, **Claim**, or **Source** by applying a thought‑type marker (a one‑keystroke action). Each block can carry **topics** (multi‑valued, hierarchical), one **status** (single‑valued, enumerated, mutable), and **actions** (multi‑valued, with lifecycle). Blocks can be connected by 6 typed edges. Pages are outlined collections of blocks. **Supertags** layer optional, schema‑bearing types on top (e.g. `#lecture`, `#theorem`, `#example`, `#paper`). This is enough to represent everything in this user's stack, and small enough to defend.

---

## 2. UI/UX, position by position

### 2.1 Capture interface: **modal quick‑capture + inline within open documents, never gated by structure**

**Position.** Two capture surfaces, both available everywhere:

- **Quick‑capture** (global keystroke + mobile share‑sheet + Apple‑Pencil scribble + voice). Opens a small floating window. No type selection, no tag selection required. The captured block lands in a **timestamped daily inbox**. Closes on Enter. The minimum capture has cost ≤ 1.5 seconds.
- **Inline** (writing within an open lecture/page/canvas). The block goes where you put it, in document order. Type/tag promotion is opt‑in via slash‑commands (Notion/Roam/Tana lineage) or a thought‑type keystroke (`Q`, `C`, `S` for Question, Claim, Source).

**Defense.** Marshall & Shipman's "formality considered harmful" applies in full: any capture path that forces the user to classify before writing fails for tacit‑knowledge content (math intuitions, half‑formed questions). Granola's product success (2024–2026) is an existence proof: it accumulates the transcript in the background and lets you write your own bullets in your own words; the AI organises *post hoc*. The capture path must work even when the user does not know what type the thought is or what topic it belongs to. This is the **pre‑condition** for solving the collector's fallacy at the input side: the user is not making any commitment when capturing, so capture cost is bounded.

**The "inbox" pattern, defended.** Every capture lands in a daily inbox by default, exactly as Reflect, Mem, and Logseq journals do. The daily inbox is the **default landing page**, not a topic page. Defenses for daily‑first over topic‑first:

1. The user does not know the right topic at capture time (Marshall–Shipman, again).
2. The daily inbox supports interstitial journaling (Maggie Appleton 2022; Roam community 2020–22), which gives chronological context — answering "what was I thinking when I asked this" requires knowing what else you were thinking that day.
3. Empirically every successful tool that solves capture (Roam, Logseq, Reflect, Mem, Tana, Heptabase, Capacities) defaulted to daily‑note‑first; tools that didn't (Evernote, Notion topic‑first) lose at capture.
4. Trajectory is fundamentally temporal: a daily note is the unit of time, and it is also where the trajectory layer can show "you were here, then here." No topic‑first layout makes that legible.

**Open question (flagged).** Whether mid‑lecture capture should suspend daily‑inbox routing in favour of a "lecture page" surface, with the lecture page itself being a date‑stamped child of the daily note, is design‑judgment. My recommendation is yes (lectures are first‑class objects with `#lecture` supertag, but they back‑link from the daily note, not vice versa), but only prototyping with real lectures will tell.

### 2.2 The shell: sidebar architecture and navigation

**Position.** A three‑column layout, asymmetric by device.

- **Left sidebar:** stable navigation. Top: today's daily note. Below: pinned pages (active topics, current lecture series, current paper). Below: a small saved‑searches section ("open questions," "recently confused"). Below: a flat type/supertag explorer (`#question`, `#theorem`, `#paper`). **Not a folder tree.** The folder tree is a Marshall‑Shipman trap: it forces premature topic commitment.
- **Center:** the active document/canvas/page, full‑width by default.
- **Right pane (toggleable):** backlinks and connections panel for the focused block, plus an LLM/AI side panel that you can summon but that is hidden by default.

**Command palette (cmd‑K):** mandatory, table‑stakes since Notion. Used for: insert thought type, jump to page, run query, run AI action, set status, add to action‑inbox.

**Defense for no folder tree.** Heptabase, Tana, Capacities, Anytype, Roam — none of the post‑2020 tools default to folders. The one that does (Obsidian) lets users *avoid* folders and the most successful Obsidian power users (Nick Milo, MOC method) explicitly avoid folder hierarchies. Premature folder hierarchy is the modal failure of Notion users (cited in the practitioner literature: Forte's PARA was a response). Folders should exist as an emergency option (an export view, a manual override) but not as the primary navigation paradigm.

**Defense for not putting the graph view in the sidebar.** Graph views look impressive in screenshots and are nearly useless for navigation. The Obsidian/Roam graph view, after a few hundred notes, becomes a hairball. Use it as an occasional diagnostic, not as primary navigation. (The InfraNodus plugin community has been honest about this for years.)

### 2.3 Mind‑map / canvas / whiteboard: **yes, but not core**

**Position.** Ship a canvas (Obsidian Canvas / Heptabase / tldraw model), but **do not** make it the primary surface. Make it accessible from any block ("send to canvas," "open canvas of this topic") and make canvases first‑class objects in the system, but the default writing surface is still a daily/topic outline.

**Defense.** Heptabase has shown the value of card‑on‑canvas for synthesis ("when you already have some information and a rough understanding," per their docs), but Heptabase users uniformly report that *capture* still happens in journals/cards and the canvas is a *re‑arrangement* surface for synthesis. Spatial layout is a "see the shape of mindset" tool — exactly the user's metacognitive use case — so it earns its place in the v1, but as the *revisit/synthesis* primitive, not the *capture* primitive. tldraw, Excalidraw, and Obsidian Canvas demonstrate that infinite‑canvas + sticky‑cards is now table stakes; the user expects it. Build it with a real engine (tldraw open‑source SDK is the current state of the art), not a custom one. Critically, **the cards on the canvas must be live block references**, not copies, so editing a claim on the canvas edits the canonical block. This is where Heptabase nails it ("whiteboards do not own cards. All cards belong to the Card Library").

### 2.4 Backlinks pane

**Position.** Visible by default in the right panel for the focused block, sorted by recency, filterable by edge type and by topic. Show *both* linked mentions (explicit) and unlinked mentions (matches the page title). The unlinked‑mentions feature is what made Roam feel magical and is still under‑implemented in Obsidian.

**Defense.** The trajectory use case ("how did my thinking on X evolve") is exactly a backlinks query sorted chronologically. A sidebar that shows "you mentioned this in 3 places in the last month" is the metacognitive surface that answers the user's revisit goal. Without filtering by edge type, the pane is noise (Roam suffered from this); with filtering, it becomes a tractable trajectory view.

### 2.5 Search

**Position.** Three layers, on by default, in this order of recall:

1. **Full‑text + fuzzy** (instant, <50ms, table‑stakes since 2018).
2. **Faceted** by topic, status, type, supertag, edge type. (E.g., "questions about cohomology with status=open.") Tana has shown this is essential for power users.
3. **Semantic / embedding** as a separate search mode behind a one‑keystroke toggle, *not* mixed into the default search. (Mem and Reflect both made the mistake of mixing them, which makes the "I know I wrote that exact phrase" lookup unreliable.)

**LLM Q&A over notes** is a fourth mode, distinct from search, accessed in the AI side‑panel. The honest assessment of the 2023–2025 RAG‑over‑notes tools (Mem, Reflect, Khoj, NotebookLM, Heptabase AI, Notion AI) is that semantic search is genuinely useful for fuzzy recall of forgotten content but is *not* a replacement for keyword/faceted search. Khoj users (XDA Developers 2024; Dark Edge 2024) report semantic recall is "underwhelming" without careful corpus curation and that exact‑match queries fail with embedding‑only retrieval. Hybrid retrieval (keyword + dense, as Mem does with Pinecone) is the empirically defensible default, but only if keyword/exact match wins ties.

### 2.6 Editor

**Position.** A **block‑based outliner** (Roam/Logseq/Tana lineage) as the canonical editor; **Markdown live‑preview** for prose mode; **inline LaTeX rendering** (KaTeX) is non‑negotiable; **handwriting on tablet** is core for a math user.

**Defenses:**

- *Block outliner over flat prose for the primary editor.* The math user often writes lemma‑then‑proof‑then‑example, which is structurally hierarchical; outliners encode this naturally. Block addressability requires it. Roam/Logseq/Tana have empirically shown outliners win for capture density. *However*, plain prose pages must also be a first‑class option for long‑form writing — this is where Obsidian Live Preview gets it right. The system should support both with a per‑page toggle.
- *Markdown over rich text.* Plain‑text storage is the only defensible long‑term commitment given the 2–3 year tool‑switching tax (Capterra 2024 cited in Atlas Workspace's Roam‑alternatives review reports 48% of PKM users switch primary tool within 2 years). Markdown + frontmatter (Obsidian's de facto standard) is the only format with enough portability to survive.
- *KaTeX/MathJax inline.* Obvious for a math user. The interaction must support both `$inline$` and `$$display$$`. Anything less is a non‑starter.
- *Handwriting.* See §2.8.

### 2.7 LLM / AI integration in the UI

**Position.** AI is **on the side panel, on demand only**, with a small set of high‑specific actions ("explain this passage to me at level X," "find similar past notes," "generate a Toulmin decomposition of this claim," "write three flashcards from this block"). **No autocomplete in the editor by default.** Granola's design is the clearest exemplar: the AI is doing work in the background but the writing surface is just a notepad; the AI surfaces results post‑hoc, not mid‑thought.

**Defense.** The cognitive‑science evidence on inline AI is thin and mostly negative for learning: the encoding benefit of self‑generation (Bjork & Bjork 2011's desirable difficulties; Mueller & Oppenheimer's encoding‑hypothesis interpretation) requires that the user produce the words. AI inline suggestions short‑circuit exactly the cognitive process you want to preserve for math learning (self‑explanation, Chi et al. 1989, 1994). Granola, Tana, Capacities, and Heptabase have converged on the design pattern: AI is summoned, not pushed. Mem's auto‑tagging is the partial exception and works because tagging is metadata not content, but even there users report it took 50–100 notes before suggestions were useful (Productivity Stack 2026 review).

**The defensible AI features for v1+:**

1. **Auto‑topic‑suggestion** on review (not at capture). System proposes topics for an unclassified block at review; user accepts/rejects.
2. **Semantic recall** on demand: "show me past notes related to this." Hybrid retrieval (keyword + dense). This is where AI clearly wins; the embedding lookup discovers connections the user has forgotten existed.
3. **Question generator from claims**: from a Claim, propose Toulmin warrant / counter‑example / contrastive question. This is the only inline‑adjacent feature I'd ship, and only if it's behind a keystroke.
4. **Explainer at level X**: select a block, ask for a short explanation pegged to a stated background. This is straightforwardly useful and what the user will use the LLM for anyway in a separate chat — bringing it inline saves friction.
5. **Trajectory summary**: weekly LLM summary of "what you were thinking about this week, what you resolved, what you didn't." This is the metacognitive payoff and should be a digest email or in‑app dashboard, not push‑notified (see §2.9).

**The AI features I would NOT ship:** auto‑connect (auto‑add edges between notes — too noisy, too high false‑positive rate per Khoj/Mem field reports); auto‑summarisation as a replacement for re‑reading (collector's fallacy enabler); auto‑classification of thought type (high error rate, low value).

### 2.8 Capture across devices

**Position. Three roles, partially overlapping:**

- **Mobile (iPhone/Android):** *capture only*. Quick‑capture box, voice memo, photo of a board (auto‑OCR'd as a Source block + image, with a `#review` action attached). One‑hand operable. Mobile is not for authoring.
- **Tablet (iPad with Apple Pencil, Boox, reMarkable‑class):** *primary live‑lecture and PDF surface*. Ink layer is first‑class, with stroke regions becoming blocks (selectable, taggable, linkable) and post‑capture handwriting recognition optional. PDF annotation lives here. The 2023+ maturity of Apple Pencil + iPad Pro + Apple silicon makes ink‑on‑paper‑feel viable for a math user in a way that was not true 5 years ago. The Mueller–Oppenheimer (2014) longhand encoding advantage is, at minimum, *not eliminated* by stylus + tablet (Wiechetek et al. 2020 EEG findings on ink/digital pen suggest the cognitive process is preserved); even with the Morehead et al. (2019) replication caveat, the hybrid (handwriting captured digitally) preserves the encoding benefit while gaining searchability.
- **Desktop:** *primary authoring, synthesis, revisit*. Canvas, multi‑pane layout, command palette, full keyboard mastery. This is where evergreen notes get written, where canvases get arranged, where trajectory dashboards get reviewed.

**Defense for treating tablet as core, not peripheral.** A math‑trained user's lecture/paper workflow is fundamentally about marginalia, derivations, and diagrammatic reasoning that no keyboard supports. Heptabase, GoodNotes, Notability, MarginNote, and the e‑ink ecosystem (reMarkable, Boox, Supernote) have shown the demand. The 2023–2026 wave of Apple Pencil hover, Pencil Pro, and ProMotion latency improvements has crossed the threshold for math notation. Building tablet ink as a first‑class block type — not as an "attachment" to a text block — is a distinguishing v1 feature for this user and matches no existing PKM tool well (Obsidian's Excalidraw plugin is the closest, but it's bolt‑on).

**Mobile vs tablet vs desktop, what they share:** all three share the same block store, the same daily inbox, the same supertag system, and the same trajectory dashboard. They differ only in *which actions are exposed* and *which surfaces are foregrounded*. Cross‑device sync is end‑to‑end and conflict‑free (CRDT‑class) — table stakes since Roam's sync issues taught the field a lesson.

### 2.9 Trajectory / revisit UI

This is the distinguishing feature and the design content the user most wants nailed.

**Position. Five concrete surfaces:**

1. **Open‑questions inbox.** A persistent saved‑search of all `Question` nodes with `status=open`. Sorted by age, filterable by topic. The flagship metacognitive view: "what am I still confused about." This directly addresses the user's "preserve beginner‑mindset questions over time" requirement — beginner questions get marked with the beginner‑mind property at capture and never expire from this view unless explicitly resolved.

2. **Tension surface.** A saved view of all `contradicts` edges where neither end has been marked resolved. "Things you have noticed are in tension and have not yet sorted out." This is what the user means by "shape of mindset on a topic."

3. **Trajectory timeline (per topic).** Selecting a topic shows: a timeline of every block tagged that topic, with status changes annotated. "You were confused about X on day 3, you marked it confident on day 21, here's the chain of claims that bridged them." This is the open‑learner‑model literature realised as a personal interface (Bull & Kay 2010, 2013). It is what answers "how did my thinking evolve."

4. **Daily review pattern.** A small, opt‑in daily review screen that surfaces: 3 questions whose status hasn't changed in N days; 2 contradictions; 1 random old block that may now be answerable. This is *not* spaced repetition of facts (which Anki/RemNote already do well); it is **spaced repetition of attention** (Matuschak's "spaced repetition systems can be used to program attention," 2020). It runs locally; it does not push notify; the user opens it when they want it.

5. **Weekly digest.** An LLM‑generated email/summary: "this week you opened 12 questions and resolved 4. You added 3 contradictions; here are their pairs. Topic X has gone from 6 unresolved questions to 2." This earns the LLM's place — synthesis at a level the user is unlikely to do manually but gets clear value from. **Not push, not nagging.** Sundays at 7am, in inbox, optional.

**Defense.** The cognitive‑science backing for these surfaces:

- Open questions persisting + revisited = retrieval‑practice scaffolding (Roediger & Karpicke 2006).
- Beginner questions preserved = protects against expert‑blind‑spot, the single most documented failure mode in math pedagogy (Ambrose et al. 2010, *How Learning Works*).
- Tension surfacing = exploits cognitive‑dissonance‑driven learning (Festinger lineage; modern instantiation: Lombrozo on explanation‑as‑generalisation).
- Open learner model visualisation = Bull & Kay's SMILI framework (2016), with empirical evidence (Hooshyar et al. 2019 systematic review) that OLM visualisation drives self‑regulated learning, especially for misconceptions.
- Trajectory timeline = the only surface that operationalises "see how thinking evolved." No existing PKM tool ships this. (Heptabase comes closest with its calendar‑of‑cards, but it doesn't track status changes.)

**No push notifications. No streaks. No gamification.** This is the productivity‑theater failure mode (Forte critique lineage: Curtis McHale 2022; Maggie Appleton 2022; Doto 2017; Tietze 2014). The aim is "your past self talking to your present self," not "engagement metrics."

**Open question (flagged, important).** Whether the trajectory timeline should be primarily *temporal* (chronological) or *structural* (graph of claims with status colouring) is undecided. I lean temporal as the default (because trajectory is fundamentally about time) with a structural toggle, but only field testing tells.

---

## 3. Design positions on the contested questions

To leave no hand‑wave standing, here are explicit positions on the unresolved UX questions:

| Question | Position | Why |
|---|---|---|
| Modal vs inline capture? | Both. Quick‑capture modal globally; inline within open documents. | Marshall–Shipman; Granola's existence proof. |
| Daily notes default? | **Yes**, daily notes are the default landing page. | Capture comes before classification. Roam/Logseq/Reflect/Mem all converged. |
| Tree, graph, both? | Neither as primary nav. **Pinned pages + saved searches + supertag explorer.** | Folder trees fail; graph views are diagnostic, not navigational. |
| Command palette? | **Yes, mandatory.** | Notion/Tana/Linear have made it table stakes. |
| Mind‑map canvas? | **Yes, as v1 synthesis surface, not capture surface.** Use tldraw. | Heptabase has demonstrated the value, but only post‑capture. |
| Backlinks pane? | **Right panel, default visible, filterable by edge type.** | Trajectory query = filtered backlinks. |
| Search? | **Hybrid: keyword exact + faceted + semantic.** Keyword wins ties. | Mixed‑mode RAG (Khoj/Mem field reports). |
| Editor? | **Block outliner default; prose mode per‑page; LaTeX inline; ink first‑class on tablet.** | Math content is hierarchical; portability via Markdown. |
| Mobile vs desktop vs tablet? | **Capture / Live‑lecture+PDF / Synthesis+Authoring.** | Different cognitive tasks, different surfaces. |
| AI inline? | **No.** Side panel, on demand. | Self‑generation/encoding cost matters; Granola's design lesson. |

---

## 4. The shipping plan: v0 → v3

Each item carries a one‑line justification. Where the justification is design judgment rather than literature‑backed, I label it.

### v0 (the personal MVP — works for n=1, no other users)

**Goal:** prove that capture + the 3‑type model + the trajectory inbox is worth using for 30 days.

| Feature | Justification |
|---|---|
| Block as primitive with stable IDs | Roam/Logseq/Tana lineage; required for trajectory. |
| Daily note as default landing | Marshall–Shipman; converged industry pattern. |
| Quick capture global keystroke | Capture friction must be ≤ 1.5s (Forte critique; Doto). |
| Markdown storage with YAML frontmatter | 48% tool‑switching rate (Capterra 2024); only portable format. |
| Inline LaTeX (KaTeX) | Non‑negotiable for math. |
| Question / Claim / Source thought types via keystroke | Defended in §1.2. |
| Topic / Status / Action property fields | Defended in §1.3. |
| 6 typed edges | Defended in §1.4. |
| Backlinks pane with edge filtering | Trajectory = filtered backlinks (§2.5). |
| Open‑questions saved view | Bull & Kay 2010; Karpicke retrieval scaffolding. |
| Full‑text search | Table stakes since 2010. |
| Desktop only; local Markdown vault | YAGNI on sync at v0; reduces complexity. |
| Plain note export | Portability obligation. |

### v1 (distinctive — math user wins)

**Goal:** make the math/lecture/PDF/ink workflow uniquely good, and ship the trajectory features.

| Feature | Justification |
|---|---|
| Tablet app with first‑class ink blocks | Mueller & Oppenheimer encoding hypothesis; 2023+ Apple Pencil maturity; no PKM tool has nailed this. |
| PDF annotation pane with highlight→Source block | Heptabase/MarginNote pattern; required for technical reading. |
| Lecture page supertag with timestamped sub‑blocks | Granola‑style for lectures; addresses live capture. |
| Mobile capture (iOS share sheet, voice → block) | Capture must follow user; Reflect/Mem standard. |
| Sync with CRDT‑class conflict resolution | Roam's lesson; Obsidian Sync standard. |
| Spatial canvas (tldraw‑based) for synthesis | Heptabase value, defended in §2.3. Card = live block reference. |
| Tension surface (saved search of unresolved contradicts) | Lombrozo's mechanism‑sensitivity; cognitive‑dissonance learning. |
| Trajectory timeline per topic | Bull & Kay OLM literature; nothing ships this. |
| Faceted search by topic/status/type/edge | Tana lineage; required at scale. |
| Semantic search (hybrid retrieval) on demand | Mem/Pinecone pattern; on‑demand only. |
| Daily review screen (3Q, 2 contradictions, 1 surprise) | Matuschak "spaced repetition of attention" (2020). |
| Beginner‑mind question flag + permanent surfacing | Specific to user's "preserve beginner questions" goal. |
| Image OCR for board photos → Source block | Mobile capture support. |

### v2 (intelligent — LLM earns its place)

**Goal:** the system actively helps the user think, without being pushy.

| Feature | Justification |
|---|---|
| LLM‑assisted topic suggestion at review | Mem's auto‑tagging works *post hoc*; reduces friction without short‑circuiting capture. |
| LLM trajectory weekly digest | The synthesis the user won't do manually; high value, low intrusion (§2.9). |
| LLM "explain at level X" on selected block | Replaces a separate ChatGPT tab; reduces context‑switching friction. |
| LLM Toulmin/contrastive‑question generator | Surfaces warrants and foils per Lipton (1990) and van Fraassen (1980); empirically fertile for self‑explanation (Chi 1994). |
| Spaced‑repetition prompt generation from blocks | Matuschak/Nielsen 2019, Quantum Country precedent; for math, see Nielsen "Using SRS to see through a piece of mathematics." |
| Auto‑detect candidate `contradicts` edges, surface for confirmation | High value if precision is high; needs prototyping (see open questions). |
| Live handwriting → LaTeX inline | Mathpix integration; specific to the math user. |
| Cross‑device sync, mobile authoring (not just capture) | User maturity. |

### v3 (collaborative / distributable — only if v0–v2 prove out)

| Feature | Justification |
|---|---|
| Selective publishing (digital garden mode) | Maggie Appleton; Matuschak's evergreen notes. Optional. |
| Multi‑player canvases with discourse‑graph relations | Joel Chan's discourse‑graph infrastructure (arXiv 2407.20666); only if user wants collaborators. |
| Plugin / scripting layer | Obsidian's lesson: extensibility extends life. |
| Native team mode with permissioned blocks | Speculative — only if the n=1 user becomes a small team. |

**What this app should NOT do, defended:**

- **Auto‑organise content into folders.** Premature formalisation; user resentment guaranteed (Marshall–Shipman; Forte critique).
- **Hide the data behind a proprietary format.** 48% switch rate; vault format must be open.
- **Push notifications, streaks, gamification.** Productivity theater; collector's‑fallacy enabler (Tietze; Doto).
- **Auto‑connect notes via embedding similarity by default.** False‑positive rate too high (Khoj field reports); creates a "garden without paths" illusion of connection.
- **Force a topic at capture time.** Marshall–Shipman.
- **Be a task manager.** Action tags suffice; full PM is feature creep that has killed Notion users (cited critique throughout the practitioner community).
- **Replace Anki for atomic memorisation.** Spaced‑repetition is a v2 add‑on, not the core; let Anki/RemNote/Mochi do what they do.
- **Auto‑summarise notes as a default action.** Collector's‑fallacy enabler; user re‑reads less because "the summary is there."
- **Inline LLM autocomplete.** Short‑circuits self‑explanation/encoding; against Bjork's desirable difficulties.

---

## 5. Failure modes the design specifically defends against

Each is a documented practitioner failure mode; each gets a specific design countermeasure.

| Failure mode | Source | Countermeasure |
|---|---|---|
| Collector's fallacy (capture without revisit) | Tietze 2014; Curtis McHale 2022; Forte critiques | Trajectory timeline + open‑questions surface make non‑revisit visible to the user. Status field separates "captured" from "engaged." |
| Garden without paths | Practitioner community 2021– | Edge types are first‑class and required for synthesis; the system shows "blocks with no connections > 30 days old" as a prompt. |
| Premature formalisation | Marshall–Shipman 1995, 1999 | Capture path requires no classification. Supertags/types are opt‑in and demand‑driven. |
| Illusion of progress through organising | Forte critique; Doto | The system tracks status transitions, not file counts. The dashboard is "questions resolved," not "notes captured." |
| Tool‑switching tax | Capterra 2024 | Open Markdown, plain‑text, no lock‑in, exportable; portable in 30 minutes. |
| Productivity theater | Forte/BASB critique | No streaks, no gamification, no nags, no public sharing pressure. |
| Expert blind spot (lost beginner questions) | Pedagogy literature | Beginner‑mind property on questions; never auto‑expire from open‑questions view. |
| Over‑indexing on AI auto‑magic | Khoj/Mem field reports | AI is on‑demand, side‑panel, never inline; trust is earned per action. |
| Decay of context (dead links, stale notes) | Cody Burleson PKM garden maintenance | Status `parked` is explicit; weekly digest re‑surfaces. |

---

## 6. Open scientific and design questions, explicitly flagged

The following cannot be resolved from the literature and require prototyping:

1. **Whether the 3‑type model holds for >1 year.** It is plausible that domain‑specific node types will accumulate (definition, theorem, lemma, example) and that some of these earn promotion above supertags. Prototype prediction: they don't, but only field use will tell.
2. **Whether `analogous‑to` should carry sub‑structure (a correspondence map).** Math users will want this for category‑theoretic / cross‑domain analogies. Empirically untested.
3. **Whether trajectory timeline should default temporal or structural.** I argue temporal; only side‑by‑side prototypes resolve.
4. **Whether the daily review screen is used.** Matuschak's evidence is strong for spaced repetition of facts; it is much weaker for "spaced repetition of attention." This is a hypothesis, not a settled finding.
5. **Whether LLM‑proposed `contradicts` edges have acceptable precision.** Field experience with Mem/Khoj suggests ~60% precision; whether that crosses the user's tolerance threshold is empirical.
6. **Whether handwriting search via on‑device OCR is good enough at 2026 latency.** Apple's stack is borderline; Mathpix is reliable but cloud‑only. Prototyping required.
7. **Whether the canvas is used >1×/week or atrophies.** Heptabase users say yes; Obsidian Canvas users say "sometimes." Personal habit‑dependent.
8. **Whether the n=1 → n=many extension actually works.** This design is built for one user; the data model is plausibly portable to small teams (Joel Chan's discourse‑graph framework demonstrates feasibility), but team UX is a separate problem and not prejudged here.
9. **Whether the Mueller–Oppenheimer encoding advantage transfers to digital ink.** Wiechetek 2020 EEG study suggests yes; Morehead 2019 suggests the longhand effect is not robust. The ink‑first‑class design hedges: it preserves the cognitive process either way, while gaining searchability.

---

## 7. Engagement with recent discourse — explicit positions

**Tools‑for‑Thought 2019–2024.** Matuschak & Nielsen's 2019 essay was right that the field needed a renewed vision and right that the bar should be transformative, not incremental. The 2020–2024 product wave (Roam, Obsidian, Logseq, Tana, Heptabase, Capacities, Anytype, Reflect, Mem, RemNote, Tana, Granola) has not produced a transformative tool by Matuschak's standard, but it *has* converged on a set of primitives — bidirectional links, block IDs, daily notes, typed properties, canvases — that are now table stakes. The right move is not to invent new primitives but to *combine the converged ones with a metacognitive layer that no one has shipped*. That metacognitive layer is the trajectory timeline + open‑questions surface + tension surface + daily review. None of these is novel as an idea; their combination as a default feature in a math‑first capture tool is.

**Block vs note vs card vs object debate.** Block wins for the capture/granularity reasons (§1.1). Object‑oriented (Anytype/Capacities) is too heavy at capture; note‑first (Obsidian/Bear) is too coarse for revisit; card‑first (Heptabase) is a UI not a data model. Block + supertag (Tana) is the right factoring; this design adopts it.

**AI‑native note tools 2023–2025.** Honest read: semantic search and chat‑with‑notes deliver real value but underdeliver against marketing claims. Mem requires 50–100 notes before suggestions become useful; Khoj requires curated corpora; Notion AI is mostly content generation, not organisation. The "auto‑organising" promise has not been kept by any tool; the most successful AI integration of 2024–2026 (Granola) succeeded by being narrow and non‑intrusive. Lesson: ship AI as a side‑panel utility for synthesis and recall, not as an organisation engine.

**The Second Brain critique.** Forte's BASB has documented practitioner failures: the methodology privileges capture, treats organisation as a one‑shot upfront cost, and undersupports revisit. The collector's‑fallacy lineage (Tietze 2014; Doto 2017; subsequent critiques) is empirically right; this design treats it as the primary failure mode to engineer against (§5).

**Ink and tablet adoption.** The 2023–2026 maturity of Apple Pencil + iPad Pro / reMarkable Paper Pro / Boox Note Air / Supernote A6X2 has crossed the usability threshold for math notation. This is the single largest hardware shift since Roam's 2020 software shift, and no PKM app has integrated it well as a *first‑class block type*. The design treats this as the v1 distinguishing feature.

**LLM as thinking partner.** The honest read is that LLMs are good at three things relevant here: (a) reformulating a passage at a different abstraction level, (b) generating contrastive/counter‑examples on demand, (c) synthesising a week's notes into a digest. They are bad at: (a) high‑precision auto‑linking, (b) identifying genuine epistemic gaps without hallucinating ones, (c) preserving the user's voice in summary. The integration plan (§2.7) maps to what works.

---

## 8. Final synthesis: the one‑page positions

- **First‑class citizen:** the **block** (stable ID, transcludable), with **page** as aggregator and **supertag** as opt‑in type layer. (Defended: §1.1.)
- **Thought types:** **3 — Question, Claim, Source.** Properties on Claim carry epistemic strength, mode, provenance, formality. (Defended: §1.2; Lombrozo, MDC, Toulmin, IBIS, discourse graphs.)
- **Tag fields:** **3 separate fields — Topic (multi, hierarchical), Status (single, mutable), Action (multi, with lifecycle).** (Defended: §1.3.)
- **Typed edges:** **6 — supports, contradicts, prerequisite‑of, generalizes/specializes, analogous‑to, addresses.** (Defended: §1.4.)
- **Information architecture:** Daily‑note landing → left sidebar (today, pinned, saved searches, supertag explorer) → center (current document/canvas) → right (backlinks/connections, AI panel toggle).
- **Capture:** modal quick‑capture global + inline outliner; daily inbox default; supertag/edge are opt‑in; ink is first‑class on tablet.
- **Revisit:** open‑questions inbox, tension surface, trajectory timeline per topic, daily review screen, weekly LLM digest.
- **AI integration:** side panel, on demand, narrow actions; never inline autocomplete; never push.
- **Editor:** block outliner default, prose mode per page, KaTeX inline, ink blocks first‑class on tablet, Markdown storage.
- **Search:** hybrid (keyword exact + faceted + on‑demand semantic); keyword wins ties.
- **v0:** prove the data model with daily‑inbox + 3 thought types + 6 edges + open‑questions view, single‑user desktop Markdown vault.
- **v1:** tablet ink + PDF + lecture supertag + canvas + trajectory timeline + tension surface + daily review.
- **v2:** LLM digest + topic suggestion + spaced‑repetition prompts + Toulmin/contrastive generators + handwriting→LaTeX.
- **v3:** publishing, collaboration, plugins — only if v0–v2 prove out.
- **What it does NOT do:** auto‑organise into folders, push notify, gamify, auto‑connect via embeddings, force types at capture, replace Anki, autocomplete LLM, lock data in.
- **Open questions explicitly flagged:** 9 items in §6, ranging from data‑model durability to ink‑encoding transfer.

The design's distinctive bet is this: every successful PKM tool of the last 6 years has solved capture and linking; none has solved revisit. The cognitive‑science evidence for what makes revisit work — retrieval practice, desirable difficulties, self‑explanation, open‑learner‑model visualisation — is robust; the implementation is missing. This design ships that implementation, in a math‑first tablet+desktop shell, with a defended minimal data model that does not collapse into the failure modes the practitioner community has documented.