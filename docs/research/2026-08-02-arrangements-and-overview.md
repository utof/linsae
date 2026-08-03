# Switchable arrangements, whole-vault overview, and what the #96 measurement actually means

**Date:** 2026-08-02 · **Scope:** research only, no code changes.
**Question owner:** issue [#96](https://github.com/) "Canvas: revisit switchable arrangements + whole-vault
placement (deferred from v0.4 scope)" (fetch with `gh api repos/{owner}/{repo}/issues/96`).
**Inputs read first:** `docs/canvas-vision.md`, `docs/research/2026-06-11-canvas-architecture-synthesis-v2.md`,
`docs/research/2026-06-12-canvas-spike-results.md`, `docs/specs/v0.4-canvas-mvp.md`,
`src/main/db/migrations/0003_canvas.sql`, and a read-only copy of the live vault DB.

---

## Verdict

- **#96's trigger is INCONCLUSIVE, and not for the reason the brief anticipated.** The brief flagged
  the "~4 weeks of dogfooding" precondition as arguably unmet on *duration*. The vault data says the
  precondition is unmet on *substance*: **the vault was never dogfooded, it was QA'd.** On 2026-06-20,
  mid-way through the canvas window, the median live-note body was **8 characters** and 28 of 36 live
  notes were under 25 characters — keyboard mash (`jklk`, `sldflksdklf`), `crash test note`, `hello`.
  You cannot falsify a thinking-space hypothesis with a vault that contains no thinking. See §7.

- **The denominator in the brief is wrong by roughly 10×.** `notes` holds 438 rows, but **422 are
  soft-deleted; only 16 are live** (`deleted_at IS NULL`). Across the entire canvas-active window
  (2026-06-13 → 2026-07-05) the live vault held **33–45 notes**, never 438. So the observed ratio is
  **4 placed / ~36–45 live ≈ 9–11 %**, not 4/438 ≈ 0.9 %. Worse, the criterion's threshold ("~20 notes
  with manual positions") would have required placing **~50 % of the entire live vault** onto a surface
  whose stated premise is that it shows *only* what was deliberately placed. **The kill criterion was
  close to arithmetically unsatisfiable as written.** See §7.

- **A weak but real positive signal exists and points the other way.** `note_access` has 7 rows;
  **all 4 placed notes are among them**, and the single most-accessed note in the vault
  (frequency 8) is a placed one. Placed notes are 4/16 = 25 % of live notes but 4/7 = 57 % of
  accessed notes. n=7, so this is a hint, not a result — but it is the only behavioural signal
  present and it does not support "falsified."

- **Prior art splits cleanly along an axis #96 conflates.** Multiple *containers* each holding an
  independent placement of the same note is **normal and well-liked** (Heptabase whiteboards, VKB
  collections, Are.na channels, Obsidian canvases). Multiple *parallel position-sets of the same
  container* is **essentially unbuilt** — Tinderbox has been asked for it and declined for 25 years;
  Kumu deliberately puts positions on the *map* and filters/styling on the *view*. In linsae's schema
  those are two different columns: `canvas_id` (well-supported by prior art) and `arrangement_id`
  (unsupported). **#96 reason (a) is defensible for `arrangement_id` and wrong for `canvas_id`.** See §1.

- **The dilution claim (#96 reason (a)) is *not* supported by the literature it sounds like it cites,
  but it is supported by a developer's primary-source judgement.** The spatial-memory literature
  actually says something more uncomfortable: Jones & Dumais (1986) found location-only reference
  **no better than name-only, and degrading faster with collection size** — a finding the Data
  Mountain authors themselves acknowledge in print. What survives is narrower and still useful:
  2D spatial retrieval is genuinely fast (3.2–5.0 s), **flat 2D beats depth**, and stability helps
  *locating* tasks specifically. See §2 — this is the section most worth reading in full.

- **The "hairball past ~200 notes" verdict is weaker-sourced than `canvas-vision.md:22-23` and
  synthesis §6 imply, and the failure mode is misattributed.** The exact phrasing and the 200/500
  numbers trace to a single May-2026 marketing-blog post. The one *authoritative* number is from
  Obsidian staff and is **25 000 files** — and it is a *performance* limit, not a legibility one.
  Meanwhile filtered/grouped/local graphs are reported useful at **thousands** of nodes. The real
  enemy is **unfiltered whole-vault force-directed layout**, not "an overview at scale." See §3.

- **There is a third option neither #96 nor the vision doc considered: manual positions as *pins*
  inside a computed field.** d3-force supports it natively and for free — verified in source:
  `if (node.fx == null) node.x += node.vx *= velocityDecay; else node.x = node.fx, node.vx = 0`.
  Cytoscape's maintainer gives the exact correctness criterion for this pattern, and d3-force meets
  both halves of it. This makes curated→whole-vault reversible in a stronger sense than #96 claims.
  See §5.

- **Recommended posture:** do **not** promote switchable `arrangement_id` arrangements. **Do** treat
  the dot tier as an overview *lens* (computed positions, ephemeral, never written to `node_layouts`)
  as `canvas-vision.md:115-122` already plans — that is the reversible, prior-art-backed move.
  **Re-arm #96's trigger with a corrected criterion** (ratio-based, gated on a real-content
  precondition) rather than declaring it fired or dead. See §7 and §"Implies".

---

## 1. Prior art: switchable arrangements

### 1.1 The distinction that organises everything

Three different things get called "multiple arrangements":

| Axis | Meaning | linsae column | Prior art |
|---|---|---|---|
| **A. Multiple containers** | same note placed independently in several boards/collections | `canvas_id` | **Strong and positive** — Heptabase, VKB, Are.na, Obsidian Canvas |
| **B. Parallel position-sets of one container** | same board, switch between "manual / timeline / clusters" | `arrangement_id` | **Essentially none** — asked for, declined, or worked around |
| **C. Lenses over one position-set** | one set of positions; filter/style/highlight varies | *(no column)* | **Strong** — Kumu views, Obsidian graph filters/groups |

`#96`'s "Deferred direction 1" is written as if A and B are one thing. They are not, and the schema
already separates them (`0003_canvas.sql:4-15`, PK `(canvas_id, arrangement_id, note_id)`).

### 1.2 Tinderbox — the strongest primary source, and it says no (axis B)

Tinderbox is the most spatially sophisticated note tool with a 25-year design record. Forum thread
[Multiple map arrangements of the same set of notes](https://forum.eastgate.com/t/multiple-map-arrangements-of-the-same-set-of-notes/6427)
(Feb 2023) is exactly our question.

The request (user `rald`, 2023-02-17):

> "It would help me, if I could create multiple maps using the same set of notes. I want to be able to
> sort notes in different ways and side-by-side compare two ways I sorted them."

The answer, from Mark Anderson (`mwra`, the reference's author):

> "A map view shows the contents of a single container… all maps of a given container will draw a
> note's icon in the shape defined by its current `$Shape` value."

Corroborated by the Tinderbox reference itself: **"For any container there is only ever one map, even
if it is opened in two different tab main views."**
([aTbRef, Map view](https://www.acrobatfaq.com/atbref9/index/Windows/DocumentWindow/Viewpane/Mapview.html))

The architectural cost, per Anderson:

> "Map view would need re-coding such that some c.50 attributes needed to make the view might need a
> per-tab abstraction rather than simply use per note values."

And the load-bearing quote — **Mark Bernstein, Tinderbox's developer**, articulating precisely #96
reason (a) but in ontological rather than memory terms:

> "I worry that p:{[A(xpos,ypos)],[B,(xpos,ypos)]} might interfere with p's _thingness_"

He adds: *"I also worry that lots of people have a hard time with vectors and matrices."*

**This is the single best support #96 reason (a) has** — but note what it actually argues. Bernstein's
worry is that a note with a *set* of positions stops being a concrete, navigable thing. That is an
identity argument, not a spatial-memory argument. It is stronger than the memory argument (§2 shows
the memory argument is shaky) and it applies with full force to `arrangement_id`.

**Tinderbox's own answer to the underlying need is aliases** — Anderson's recommended workaround is
"create aliases of container contents within an agent, disable the cleanup action, and arrange
aliases independently." An alias *is* a distinct thing with its own position. That is axis A
(multiple containers), reached through a different door.

Two forum members wanted the feature anyway (`entropydave`: *"the desire to make maps of conceptual
inter-relations… to arrange the same sub-elements in different ways"*; `satikusala`: *"I too would
love this. I'm calling this 'Diagram View'"*). Demand exists; it has not been enough to build in
25 years.

### 1.3 Heptabase — a direct contradiction of `canvas-vision.md`'s framing (axis A)

`canvas-vision.md:20-22` cites Heptabase as evidence that lived-in spatial tools are
manual-placement-first. That is true. But Heptabase also ships, as a headline feature, the thing #96
reason (a) rejects. From [Heptabase's public wiki](https://wiki.heptabase.com/fundamental-elements):

> "**The same card can be placed on multiple whiteboards at the same time.**"

> "**All cards are stored in the Card Library App.** … Whiteboards do not own cards. All cards belong
> to the Card Library."

And the design rationale is *pro*-multiplicity, not anti:

> "This is similar to how our brain works — the same concept or knowledge can appear under different
> topics."

Navigation between placements is a first-class affordance: the card's info panel lists the whiteboards
it appears on, and clicking one "will automatically open the whiteboard and focus on the location of
the card."

**Explicit contradiction to flag:** the vision doc's exemplar for manual-placement-first is *also* an
exemplar for parallel placement of one note. The reconciliation is the A/B distinction — Heptabase does
A (one placement per whiteboard), not B (several placements per whiteboard). linsae's `canvas_id` is
already the A hedge, and §Multiple canvases (`canvas-vision.md:170-176`) already plans to activate it.
**No amendment is needed, but the vision doc's prose should not be read as prior art against A.**

### 1.4 VKB — multiple visual symbols per object, by design (axes A and, arguably, B)

The second-generation spatial hypertext system from the VIKI lineage that `synthesis §6` cites
approvingly. From the
[VKB analytic-workspaces paper](https://people.engr.tamu.edu/shipman/vkb/www2000.htm):

> "More than one visual symbol can represent the same information object — an information object may be
> presented as a small orange symbol in one location and as a large blue symbol in another."

The stated purpose is to let analysts **"express multiple interpretations of a single piece of
content."** VKB also has hierarchies of collections and navigable links between them
(Shipman, *Seven Directions for Spatial Hypertext Research*, Direction 5: *"VIKI and VKB enable
constructing hierarchies of two-dimensional spaces. VKB additionally allows navigational links between
these spaces."*).

**Explicit contradiction to flag:** a blanket claim that parallel placement dilutes spatial memory is
not supported by the canonical spatial-hypertext system, which treats multiple representations of one
object as an expressive feature. What VKB does *not* do is offer a switch that reshuffles one
collection between saved position-sets — the multiplicity is across collections and symbols, i.e.
closer to A than to B.

Note also that Shipman's own list of open problems (2001) never lists "multiple arrangements per
space" as a direction. In 25 years of spatial-hypertext research, axis B is not a named research
direction. That is a meaningful absence.

### 1.5 Kumu — the tool that did split "view" from "position", and put positions on the map (axis C)

Kumu is the clearest existing implementation of "switchable views", and it is instructive that it
switches the *wrong* thing relative to #96's framing.
[Kumu docs, Views](https://docs.kumu.io/guides/views):

> "A view is a collection of decorations, filters, and other settings that change what is visible on
> your map and how it is styled."

and, decisively:

> "a map defines the elements and connections that should be part of a map, **and their positions on
> the map**"

So: **positions are map-level; views are filter + style level.** A view can even apply to multiple maps.
Kumu offers `n` views over one position-set — axis C, not axis B.

Kumu also documents the pinning mechanic that §5 needs
([Kumu docs, Fixed layout](https://docs.kumu.io/guides/layouts/fixed.md)): when moving from a
force-directed to a fixed layout you *"may need to pin all the existing elements in place"*, via a pin
button or the `P` key. Kumu's layout menu spans *"fixed layouts where you position things yourself, to
force-directed (floating) layouts where positions are based on relationships, to scatter plots where
positions are driven by underlying field values"* ([Layouts](https://docs.kumu.io/guides/layouts)).

**This is the most actionable prior art in the whole report.** If linsae ever wants "arrangements",
Kumu's shape — one canonical position-set, `n` cheap lenses (filter + style + highlight) over it — costs
no new position rows, no `arrangement_id` activation, and cannot dilute anything, because there is
still exactly one place each note lives.

### 1.6 The rest of the field, briefly

| Tool | Parallel arrangements? | Per-view or per-document? | Notes |
|---|---|---|---|
| **Obsidian Canvas** | Axis A only | Per-file — a canvas *is* a `.canvas` file in the vault, [JSON Canvas format](https://jsoncanvas.org/) ([help](https://obsidian.md/help/plugins/canvas)) | Same note can be added to many canvases; each canvas file stores its own positions. A [bug report](https://forum.obsidian.md/t/canvas-note-duplicates-not-syncing-changes-properly/54686) shows the live-reference edge cases this creates (checkbox state failing to sync between two placements of one note) — a real cost of axis A that linsae's single-row model would inherit. |
| **Heptabase** | Axis A, prominently | Per-whiteboard | §1.3 |
| **Are.na** | Axis A | Per-channel — "any block can be reused in multiple channels through a connection", and channels a block appears in are listed in its `connections` ([help](https://help.are.na/docs/getting-started/blocks), [API](https://dev.are.na/documentation/blocks)) | No x/y at all — grid, not canvas. Multiplicity without spatial memory. |
| **Kumu** | Axis C | Views are portable across maps; positions are per-map | §1.5 |
| **Tinderbox** | No (axis B declined); aliases give A | One map per container | §1.2 |
| **Scapple** | No | One freeform board; no layout algorithms at all | The purest manual-only design in the set — no auto-layout to switch to. |
| **TheBrain** | N/A — no manual positions | Layout is recomputed around the active thought | The opposite pole: *"the relationships between thoughts are displayed automatically, based on which thought is active"* ([TheBrain docs](https://www.thebrain.com/support/tutorials)). Interesting negative case — TheBrain is a lived-in tool with **zero** spatial memory by construction, which is itself evidence that the spatial bet is not the only viable one. |
| **Gephi** | Not built-in | Saving a project saves one state; ["save or export layout"](https://github.com/gephi/gephi/issues/1684) is an open feature request | |
| **Cytoscape.js** | `preset` layout accepts positions you supply; no saved-layout registry | Per-call | Locked-node behaviour is the interesting part — §5. |
| **Miro** | No | Frames are regions of one coordinate space; items have absolute x/y relative to board centre ([Miro dev docs](https://developers.miro.com/docs/boards)) | Frames ≈ named viewport bookmarks, not arrangements. |
| **Curio** | Axis A | Projects contain multiple "idea spaces", each freeform | Same shape as Heptabase whiteboards. |
| **Muse** | Axis A (boards nest) | Per-board | See §7 for the retrospective — the useful finding is about friction, not arrangements. |
| **DEVONthink** | N/A | No spatial canvas; organisation is semantic ("See Also & Classify") | Pairs with Curio rather than competing. |

**Published user experience about whether parallel layouts help or dilute:** I found **none** —
no study, no substantive practitioner writeup either way. The closest thing to evidence is the
*revealed preference* of the tool builders: axis A is everywhere, axis B is nowhere, and the one
developer who publicly reasoned about axis B (Bernstein) talked himself out of it. Treat #96 reason (a)
as a **well-motivated design judgement with primary-source company, not as an empirically supported
claim.**

---

## 2. The dilution claim, and what the spatial-memory literature actually says

This is the section the brief asked me to get right even if inconvenient. It is inconvenient.

### 2.1 Jones & Dumais 1986 — the finding that undercuts the strong form of the bet

Jones, W. P. & Dumais, S. T., *The Spatial Metaphor for User Interfaces: Experimental Tests of
Reference by Location versus Name*, ACM Transactions on Office Information Systems 4(1), 42–63, 1986
([ACM DL](https://dl.acm.org/doi/10.1145/5401.5405)).

Subjects read news articles and filed them under one of four conditions (name only, location only,
name + location, name and location separate), then were given a passage and three guesses at where
they had filed it. The result:

> accuracy of location reference in a location-only filing condition was initially comparable to that
> in a name-only condition, **but deteriorated much more rapidly with increases in the number of
> objects filed**

and the overall conclusion that **the location-only condition did not have any significant advantage
over the name-only condition.**

The most damning corroboration is not from critics — it is from the Data Mountain authors themselves,
in their own results section (Robertson et al., UIST '98, p. 160):

> "However, previous research [15] has suggested that **little significant value is provided by adding
> spatial location information to the storage and subsequent retrieval of a document over and above
> simply providing a semantic label for the same purposes.**"

([15] is Jones & Dumais.)

**Explicit contradiction to flag:** `canvas-vision.md:18-19` states *"The user's spatial memory does the
organizing"* as the product thesis. The 1986 experiment is a direct test of exactly that proposition
and it came out roughly neutral-to-negative — and *worse at scale*, which is the direction linsae is
growing. Nothing in `canvas-vision.md` or `synthesis §6` cites it. It should be cited, because it
bounds what the canvas can claim.

### 2.2 Data Mountain 1998 — the pro-spatial result, and its own honest caveat

Robertson, Czerwinski, Larson, Robbins, Thiel & van Dantzich, *Data Mountain: Using Spatial Memory for
Document Management*, UIST '98, 153–162
([PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/1998/01/p153-robertson.pdf)).

100 web pages, freely arranged on an inclined plane. Abstract:

> "We also describe a user study that shows that the Data Mountain does take advantage of spatial
> memory. Our study shows that the Data Mountain has statistically reliable advantages over the
> Microsoft Internet Explorer Favorites mechanism for managing documents of interest in an information
> workspace."

Real effects: reliably faster retrieval (application main effect F(2,18)=4.84, p<.02), fewer incorrect
retrievals (F(2,18)=4.48, p<.03), fewer timeouts (F(2,18)=8.3, p<.01). Users behaved as if spatially
navigating — *"We often heard subjects say things like 'it's right here', or 'I know it's back there',
and move directly to the location of the page."*

**But read the interaction effect, because it is the load-bearing detail for linsae.** Retrieval cues
were title / summary / thumbnail / all-three. The paper reports:

> "The only condition in which the first Data Mountain group was slower than the IE4 group was the
> **title cueing** condition."

Title-cue retrieval is the closest thing in the study to *pure* location memory ("I know the name, now
remember where I put it"), and that is where Data Mountain **lost**. The wins concentrated in the
thumbnail and all-cues conditions. The authors say so themselves in future work:

> "We would like to understand the relative contributions to this successful study of the various
> components (3D versus 2D, spatial memory, audio, title display, page avoidance, thumbnail images).
> … As with PadPrints, it is possible that **the thumbnail images are a significant contributor.**"

**Interpretation for linsae, stated carefully:** the strongest empirical support for spatial workspaces
is substantially support for **visually distinctive, recognisable objects arranged in stable
positions** — recognition plus location, not location alone. That is *good* news, because linsae's cards
are markdown text and therefore visually distinctive at card tier. It is *bad* news for the dot tier,
where every note is an identical dot and only location remains — precisely the condition Jones & Dumais
tested and found weak. **This is a direct constraint on the semantic-zoom milestone**; see §"Implies".

### 2.3 Cockburn & McKenzie 2002 — the density curve, and 2D beats 3D

Cockburn, A. & McKenzie, B., *Evaluating the Effectiveness of Spatial Memory in 2D and 3D Physical and
Virtual Environments*, CHI '02
([PDF](https://www.csse.canterbury.ac.nz/andrew.cockburn/papers/chi02DM.pdf)). 69 subjects, physical
and virtual models, densities of 33 / 66 / 99 pages.

Abstract:

> "Results show that the subjects' performance deteriorated in both the physical and virtual systems as
> their freedom to locate items in the third dimension increased. Subjective measures reinforce the
> performance measures, indicating that users found interfaces with higher dimensions more 'cluttered'
> and less efficient."

The density result, quoted exactly:

> "As expected, the means for the three densities were significantly different (F2,126=12.8, p<.001) at
> **3.2 (σ 1.2), 4.2 (σ 2.7) and 5.0 (σ 3.5) seconds** for the sparse, medium and dense conditions."

And confidence collapsed faster than performance did — Q2 ("I will be able to quickly find pages")
fell 3.8 → 3.2 → 2.6 across sparse/medium/dense (Friedman χ²r=49.8, p<.001).

Conclusions:

> "Results show that our subjects' ability to quickly locate web page images deteriorated as their
> freedom to use the third dimension increased."

> "Our results indicate that for relatively sparse information retrieval tasks (**up to 99 data items**),
> 3D hinders retrieval."

**Three things linsae should take from this:**

1. **Flat 2D is the right substrate** — this is independent empirical support for a decision
   `canvas-vision.md` made on other grounds. Bank it.
2. **Retrieval time grows ~56 % from 33 → 99 items** even with perfect freedom of placement. Spatial
   memory does not scale gracefully; it degrades gracefully. This is evidence **for** the curated
   canvas (bounded item count) and **against** whole-vault card scatter — supporting
   `canvas-vision.md:54-55` and #96's deferral of direction 2 at card tier.
3. **But it cuts at the curated canvas too.** A curated canvas that grows past ~100 placed cards is in
   the "dense" regime, where a 99-item study already measured 5 s retrieval and subjective confidence
   below the midpoint. Neither #96 nor the vision doc has a story for what happens to a *successful*
   curated canvas at 300 placed notes. §Implies picks this up.

### 2.4 Malone 1983 — the piles finding

Malone, T. W., *How Do People Organize Their Desks? Implications for the Design of Office Information
Systems*, ACM TOIS 1(1), 1983. The durable findings are (a) people maintain **files** (titled, ordered)
*and* **piles** (untitled, spatially located, deliberately un-formalised), and (b) a primary function of
desk organisation is **reminding**, not just retrieval — the location of a pile is a cue that there is
something to do.

Relevance: this is the intellectual root of "incremental formalization" in the VIKI/VKB lineage and it
is the strongest theoretical support for a manual canvas — but note it supports **piles as untitled
spatial groupings whose value is reminding**, which is a *different* claimed benefit from
*retrieval*. If the canvas is a reminding surface, the right metric is not "how fast can you find a
note" but "did the canvas surface something you'd forgotten". #96's kill criterion measures neither.

### 2.5 Drawing stability — the closest thing to a direct test of "dilution"

Archambault & Purchase, *On the Application of Experimental Results in Dynamic Graph Drawing*
([CEUR Vol-1244, paper 5](https://ceur-ws.org/Vol-1244/GViP-paper5.pdf)) survey what happens when node
positions *do* move between views — the mechanical equivalent of switching arrangements.

The negative result:

> "A survey [3] of experimental results in dynamic graph drawing prior to 2012 could not find evidence
> that drawing stability [13, 9] helps when visualizing undirected dynamic graphs. The survey concludes
> that **drawing stability may not be as useful as originally thought** and that further study was
> needed."

The qualified positive result, which is the one that matters here:

> "Archambault and Purchase [2] provided evidence that dynamic graph drawing algorithms which support
> drawing stability help **when the tasks are maplike — such as locating nodes or following long paths
> through the graph.**"

> "Drawing stability is helpful for **locating specific nodes** in a visualization or following long
> paths — tasks that are similar to finding our way on a map. One could view drawing stability as **a
> form of spatial highlighting where position is used to identify nodes.**"

**Synthesis of §2:** position stability helps *locating*, which is what a note canvas is for, and does
not demonstrably help *comprehension*, which is what a graph view claims to be for. #96 reason (a) is
therefore **directionally right for the task linsae cares about**, but the honest version of the claim
is narrower than "spatial memory is the core bet": it is *"stable position is a retrieval cue whose
strength is comparable to a good label, degrades with density, and works best when combined with
visual distinctiveness."* Every one of those clauses matters for the dot tier.

---

## 3. Prior art: whole-vault / overview-first

### 3.1 The hairball verdict is real, but its citation trail is thin and its threshold is misattributed

`canvas-vision.md:22-23`: *"force-directed whole-vault graphs (Obsidian, Roam) start degrading around
~200 notes and are reliably hairballs by ~500 (community-reported, not benchmarked)."*
`synthesis §6` is stronger: *"Obsidian's community consensus is that the graph view is 'beautiful and
almost completely useless' past ~200 notes"* with *"roughly '200 notes for starts to degrade and 500
notes for reliably a hairball'"*.

Searching for that exact phrasing and those exact numbers returns essentially **one** source: a
[Code Culture blog post](https://codeculture.store/blogs/developer-culture/obsidian-graph-view-useful)
titled *"Obsidian's Graph View Is Beautiful and Almost Completely Useless"*, published May 2026 — a
month before the synthesis doc. The phrasing in `synthesis §6` matches it closely enough that it looks
like the source. It is a Shopify-hosted marketing blog, not a community consensus artefact and not a
benchmark.

**The vision doc's own hedge — "(community-reported, not benchmarked)" — is honest and should stay.**
But `synthesis §6`'s framing as *"the strongest finding in this research"* and *"Obsidian's community
consensus"* overstates the provenance of a single blog post. Flagging as a source-quality issue, not a
factual reversal: the underlying phenomenon is widely reported, the specific numbers are not.

**The one authoritative number points somewhere completely different.** Obsidian staff member
`WhiteNoise` on the forum, 2025-10-24, responding to a 130 000-note vault whose graph view froze
([thread](https://forum.obsidian.md/t/obsidian-graph-view-doesnt-work-for-a-large-vault/106287)):

> "There is not a hard limit but the performance of graph view degrades with the number of notes.
> **I don't think anything above 25K files is practical with a modern desktop computer.**"

That is **25 000**, and it is a *performance* ceiling. The community's ~200 is a *legibility* ceiling.
These are different failure modes, two orders of magnitude apart, and the docs currently blur them.
For linsae the distinction is decisive: the spike already proved 10 000 dots at a flawless 60 fps
(`docs/research/2026-06-12-canvas-spike-results.md:56`), so **linsae has no performance problem at
whole-vault dot scale. It has, at most, a legibility problem** — and legibility is addressable by
filtering, grouping and labels, as the next subsection shows.

### 3.2 Counter-evidence: filtered and local graphs *are* useful at thousands of nodes

This is the highest-value contradiction in §3, because it changes what the dot tier should be.

[*"You All Say the Graph Is Useless, Let Me Show You How to Use It"*](https://forum.obsidian.md/t/you-all-say-the-graph-is-useless-let-me-show-you-how-to-use-it/116738)
(Obsidian forum, 2026-08-01). The author has a vault with **"thousands of nodes"** in raw view and a
three-step recipe that makes it work:

1. **Filter** — search syntax such as `-path: xxx`, `-tag: useless` to exclude
2. **Group** — colour-coded classification by path, tag, or filename keyword
3. **Focus** — zoom-on-note plus manual node manipulation

Their verdict on the two graphs: the local graph is **"an absolute treasure"** because it **"only shows
the nodes related to your current note"**; the global graph works only with deliberate curation —
**"Data that can't be distilled and organized is just data — not information, let alone knowledge."**

Independently, Eleanor Konik,
[*"It's Not Just a Pretty Gimmick: In Defense of Obsidian's Graph View"*](https://www.eleanorkonik.com/p/its-not-just-a-pretty-gimmick-in-defense-of-obsidians-graph-view)
(2021-09-10), uses the **global** graph — filtered by folder-number scheme — to *"make sure I haven't
messed up my organizational system"* and to judge *"how my knowledge work integrates, and where I
should focus my time"*, detecting sync errors and spotting isolated nodes as underdeveloped ideas.
**"the graph view is actually surprisingly useful for me."**

And a third, converging on the same place — a user writeup on discovering local graphs
([*A PKM Revelation — Obsidian Local Graphs*](https://pjordan.substack.com/p/a-pkm-revelation-obsidian-local-graphs),
2023-05-03): the global graph became *"a little more challenging to navigate and make the best use
of"* as notes accumulated, while local graphs feel *"almost magical"*.

**Explicit contradiction to flag:** `synthesis §6`'s claim that the graph view is *"navigationally
useless"* past a few hundred notes is contradicted by multiple practitioners operating at thousands of
notes. The reconciliation is that **all of them stopped using the raw unfiltered global force layout**.
The failure mode is *undifferentiated whole-vault force-directed layout*, exactly as `synthesis §6`
itself diagnoses one sentence later (*"a force-directed flat graph of typed-but-undifferentiated
links"*) — but the doc then generalises from "force layout fails" to "whole-vault overview fails",
and that generalisation does not hold.

`#96`'s "Deferred direction 2" inherits this over-generalisation: it defers *whole-vault placement* on
the strength of a verdict that actually condemns only *whole-vault force-directed placement*.

### 3.3 What does work as an overview lens

- **Local / ego-centric graphs** — the consistent winner across all three practitioner sources above.
- **Filtered + grouped global views** — §3.2.
- **Seed-and-expand citation tools.** Connected Papers builds a graph around one seed paper on demand;
  ResearchRabbit expands from a collection. Neither attempts a corpus overview. Both are literal
  implementations of van Ham & Perer's paradigm (§4).
- **Spatial hypertext's answer: hierarchies of bounded spaces**, not one big space. VIKI and VKB
  *"enable constructing hierarchies of two-dimensional spaces"* with links between them (Shipman,
  *Seven Directions*, Direction 5). Each space stays small enough to read; the corpus scales by
  nesting. This is what linsae's §Threads + nested canvases (`canvas-vision.md:155-168`) is, and it is
  a better-supported scaling answer than a single whole-vault field.
- **Are.na** deserves a mention as the negative control: whole-corpus overview with *no* spatial
  positions at all, organised purely by channel membership, and people live in it happily.

### 3.4 The uncomfortable meta-finding from spatial hypertext

Mark Anderson's HT'25 retrospective *W(h)ither Spatial Hypertext?*
([ACM DL 10.1145/3720553.3746683](https://dl.acm.org/doi/10.1145/3720553.3746683); the PDF is
paywalled — I could not fetch it and am relying on the abstract and indexed summary, so treat these as
second-hand) poses the field's own hard question: what problems does spatial hypertext solve better
than other processes, and *"whether spatial hypertext results are meaningful to others, or if they
represent only a 'mind palace' of use to their maker(s)"*. It also records that most spatial-hypertext
systems described *"either are no longer usable or are restricted"*, with Tinderbox as the surviving
example.

For a single-user personal note app the "meaningful to others" concern is moot by construction — the
maker *is* the audience. That is a genuine structural advantage linsae has over the systems that died.

---

## 4. Overview-first vs detail-first

### 4.1 The mantra, and that it is a guideline rather than a finding

Shneiderman's *"Overview first, zoom and filter, then details on demand"* (*The Eyes Have It*, 1996) is
cited in `synthesis §6` and paraphrased in `canvas-vision.md:26-28`. Craft & Cairns,
[*Beyond Guidelines: What Can We Learn from the Visual Information Seeking Mantra?*](https://faculty.cc.gatech.edu/~john.stasko/8001/craft05.pdf)
(IV '05), reviewed the literature citing it and concluded that although the mantra is widely used to
inform design, **"it is unclear what use this has been for visualization designers"**, and that results
indicate **"a need for empirical validation of the mantra"**. The mantra is a heuristic with enormous
citation count and thin direct evidence. Do not treat it as settling anything.

### 4.2 The substantive critique for exactly linsae's case

van Ham, F. & Perer, A., *"Search, Show Context, Expand on Demand": Supporting Large Graph Exploration
with Degree-of-Interest*, IEEE TVCG 15(6), 2009
([IEEE](https://ieeexplore.ieee.org/document/5290699), [PubMed](https://pubmed.ncbi.nlm.nih.gov/19834159/)).
Their premise:

> "While a common goal in graph visualization is designing techniques for displaying an overview of an
> entire graph, there are many situations where such an overview is not relevant or practical for
> users"

Their alternative inverts the mantra: **search → show context → expand on demand.** Start from a node
the user already cares about, show a degree-of-interest-filtered neighbourhood, and grow only where the
user asks. This is the paradigm that Obsidian's local graph, Connected Papers, and ResearchRabbit all
independently converged on (§3.3).

### 4.3 Answer to the brief's question

**For a 438-row / ~16–45-live personal vault growing over time, what should the default view be?**

The evidence recommends **detail-first with an overview available, not overview-first**:

1. **Overview-first is a stranger's strategy.** Its value is orienting someone in an *unfamiliar*
   corpus. In a personal vault the user wrote every note; they do not need orienting, they need
   retrieval and reminding. Jones & Dumais (§2.1) says the cheap retrieval cue is the *label*, and
   linsae already has an excellent one — FTS5 search with `bm25()` + `snippet()`, plus the `/` picker
   (`docs/specs/v0.4-canvas-mvp.md:193-202`). The search-first door is already built and is the
   evidence-backed default.
2. **Overview-first degrades exactly where the vault is heading.** Cockburn's density curve (§2.3) and
   the community's legibility complaints (§3.1) both say overviews get worse with n, while
   search-then-expand is n-independent.
3. **The overview still earns its place as a *lens*, not a *home*.** Every practitioner source in §3.2
   found the global graph useful for a *specific, occasional, meta* task — auditing the shape of the
   collection, spotting orphans, checking the organisational system. That is a real job and it is
   exactly the far-zoom dot tier's job in `canvas-vision.md:115-122`. It is a job you do monthly, not a
   surface you open by default.

So: **the feed stays the default view; the canvas stays curated and detail-first; the dot tier ships as
an on-demand lens.** That is precisely the sequencing `canvas-vision.md` already has — and the
literature supports it more strongly than the doc's own "overview first, zoom and filter, details on
demand" framing at line 26-28 does. **That line is the one piece of `canvas-vision.md` this research
would soften**: linsae is not building an overview-first product and should not describe itself as one.

---

## 5. The reversibility argument, stress-tested

`#96`: *"curated→whole-vault is an additive 'scatter the rest' command later; the reverse is
destructive."*

### 5.1 The argument is sound, but it is guarding the wrong asymmetry

The asymmetry that actually matters is not curated↔whole-vault. It is **ephemeral↔persisted**. Consider
what each option does to the 4 existing `node_layouts` rows:

| Option | What happens to the 4 manual rows | Reversible? |
|---|---|---|
| **(i)** Computed positions written into `node_layouts` under `arrangement_id='manual'` | **Overwritten.** Destructive. Recoverable only via undo, which is in-memory and per-session (`src/renderer/src/canvas/useSpatialUndoStore.ts`) | No |
| **(ii)** Computed positions written under a new `arrangement_id` (e.g. `'radial-v1'`) | Untouched. New rows, new key prefix. | Yes — `DELETE WHERE arrangement_id='radial-v1'` |
| **(iii)** Computed positions **never persisted** — held in a `Float32Array`, recomputed per session | Untouched. **Zero rows written.** | Trivially — close the lens |
| **(iv)** Manual rows become **pins**; the rest are computed around them | Untouched *and load-bearing* — they anchor the field | Yes |

**Option (iii) is what `canvas-vision.md:115-122` already describes** — *"notes without manual positions
get computed positions here, not on the card tier"* — and it is the strongest reversibility story
available. It needs no schema change, no `arrangement_id` activation, and no migration. It also
sidesteps `#96` reason (c) (the "permanent feature tax" of every future feature having to answer "in
which arrangement?"), because a lens is not a place: ink, piles, nested canvases and split-pane cameras
all continue to belong to the one manual arrangement.

**Option (iv) is the third option the brief suspected exists.** It does, and it is cheap.

### 5.2 Pinned + computed in one field: verified API and the correctness criterion

**d3-force supports pinning natively.** From the
[d3-force docs](https://d3js.org/d3-force/simulation), quoted exactly:

> "To fix a node in a given position, you may specify two additional properties:
> `fx` — the node's fixed *x*-position; `fy` — the node's fixed *y*-position.
> At the end of each tick, after the application of any forces, a node with a defined *node*.fx has
> *node*.x reset to this value and *node*.vx set to zero; likewise, a node with a defined *node*.fy has
> *node*.y reset to this value and *node*.vy set to zero. **To unfix a node that was previously fixed,
> set *node*.fx and *node*.fy to null, or delete these properties.**"

Confirmed at source level (`d3-force/src/simulation.js`, retrieved via context7):

```js
if (node.fx == null) node.x += node.vx *= velocityDecay;
else node.x = node.fx, node.vx = 0;
if (node.fy == null) node.y += node.vy *= velocityDecay;
else node.y = node.fy, node.vy = 0;
```

Also verified in the same docs: `simulation.tick(iterations)` *"Manually steps the simulation by the
specified number of iterations"* and `simulation.stop()` *"Stops the simulation's internal timer…
useful for running the simulation manually"* — the worker contract `canvas-vision.md:124-130` already
assumes.

**The failure mode, and the criterion that predicts it.** Cytoscape.js issue
[#1137 "Influence of locked nodes on layout"](https://github.com/cytoscape/cytoscape.js/issues/1137)
(reporter `wolfig`, 2015-10-23, on a 650-node network):

> "If I use locked nodes I do get the impression that these are ignored by any of the layout
> algorythms — **the unlocked nodes tend to move away from the locked ones.**"

Maintainer `maxkfranz`, same day, gives the general rule — this is the sentence to design against:

> "In general, a physics layout will work in the way you want **if and only if (1) it has internal
> modelling of locked nodes** (or otherwise they just behave as though the node isn't locked but the
> actual position won't change) **and (2) it has support for iterative runs.**"

**d3-force satisfies both.** (1) is satisfied because `fx`/`fy` are applied *after* force application
but *before* the next tick's force evaluation, so every other node's force computation sees the pinned
node at its true position — it is a real obstacle in the field, not a ghost. (2) is satisfied by
`tick()`/`stop()`. Gephi's ForceAtlas2 also satisfies (1) (the reporter contrasts it favourably);
Cytoscape's 2015-era `cola`/`cose` did not, which is why the issue exists. The reporter's resolution,
five years later: *"Actually I didn't solve this at all. In the end I used vis.js."*

**Consequence for linsae:** "manual positions survive as pins inside a computed field" is not
speculative — it is a two-property change on the node objects the layout worker already owns, on a
library the vision doc already committed to, with a documented correctness criterion that the library
meets. It should be evaluated as a real option, and it is the one that makes #96's reversibility
argument *true in both directions* rather than only forwards.

### 5.3 One caveat that argues against pinning at the dot tier specifically

Pinning only makes sense if the pins are *visible as pins*. At dot tier every node is an identical dot;
a pinned dot is indistinguishable from a computed one, so the user cannot tell which positions they
authored. That erases the very distinction the pin exists to preserve — and per §2.2 it strips out the
recognition half of the retrieval cue. **If pinning is used, the pinned nodes need a distinct
mark** (the ▦ chip's dot-tier analogue). File this as a design constraint, not a blocker.

---

## 6. Computed layouts as commands, not places

`canvas-vision.md:43-45` and `:124-130`: computed layouts *"ship as commands that mutate the manual
arrangement"* — arrange-selection-as-timeline / tidy-tree / grid, undoable.

### 6.1 The pattern is real, mainstream, and well-tested

- **Figma "Tidy up"** is the canonical example. Figma's own
  [Smart Selection announcement](https://www.figma.com/blog/introducing-smart-selection/) frames it as
  a one-shot mutation, not a mode: *"Doing this in traditional design tools often means manually going
  through each and every space… and adjusting the ones that are off. With Tidy Up all this can be done
  in a single quick action."* It sits in the ordinary undo stack.
- **tldraw** exposes align / distribute / **stack** / **pack** as *shape transforms* — *"operations
  that manipulate multiple shapes together"* that *"reposition shapes without changing their parent
  relationships"* ([tldraw docs, Shape transforms](https://tldraw.dev/sdk-features/shape-transforms)),
  all undoable actions.
- **Obsidian Canvas** ships **no** auto-layout at all; the community plugin *Canvas Positioning Toolkit*
  adds it explicitly as a command: *"Auto-layout arranges cards into a tidy grid, and you can run it on
  the whole board **or just your current selection**"*
  ([plugin page](https://community.obsidian.md/plugins/canvas-positioning-toolkit)). Note the
  selection scoping — the same shape linsae plans.
- **Tinderbox** has a Cleanup menu that *"gives you ways to rearrange all the notes in the map,
  including arranging them in a grid, a staggered grid, a row, a column, or a box"* — a one-shot
  command over a manual map.

**Verdict: the pattern holds up.** It is what every manual-first spatial tool converged on, and none of
them shipped switchable arrangements instead.

### 6.2 Known failure modes — all four are documented, and all four are avoidable

1. **Auto-layout that fires *automatically* and eats a manual arrangement.** This is Tinderbox's
   `$CleanupAction`, whose **default is `grid`** — meaning an agent's map re-grids itself and manual
   arrangement is impossible until you *"set the `$CleanupAction` attribute on your container to
   `none`"*
   ([aTbRef, Re-arrangeable Agent Maps](https://acrobatfaq.com/atbref10/index/Windows/Document_Window/View_pane/Map_view/Re-arrangeable_Agent_Maps.html)).
   Anderson's answer in the arrangements thread (§1.2) also begins with *"disable the cleanup
   action"*. **Rule for linsae: no layout command may ever run without an explicit user gesture.**
   Never on open, never on note-add, never on window resize.

2. **One misclick loses the manual layout.** Mitigated by undo — but linsae's spatial undo is
   **in-memory and per-session** (`src/renderer/src/canvas/useSpatialUndoStore.ts`;
   `docs/specs/v0.4-canvas-mvp.md:307-312`). A layout command applied at the end of a session and
   discovered the next morning is **unrecoverable today**. Given v0.7 persisted session state
   (`canvas-vision.md:244-253`), the gap is now conspicuous. **Rule: the first layout command must not
   ship before either persisted spatial undo or a per-command snapshot** (cheap: stash the affected
   rows' prior x/y in `app_settings` under a `layout.lastCommandSnapshot.v1` key — no migration).

3. **Auto-layout of a selection fights the surrounding manual positions.** This is the Cytoscape
   locked-node problem (§5.2) in miniature: tidy a selection and it collides with, or drifts away
   from, unselected neighbours. Two mitigations, both from prior art: run the command with the
   *unselected* neighbours pinned (`fx`/`fy`) so the tidied group is laid out *around* them; and prefer
   **incremental** algorithms. yWorks names the principle exactly: *"An automatic layout algorithm that
   inserts new elements into an existing diagram without re-arranging the existing ones is called an
   incremental layout algorithm"*, whose objective is *"to preserve the users' mental map of the
   diagram. Therefore, it is essential to keep the positions of the existing elements as stable as
   possible"* ([yWorks, Incremental Diagram Layout](https://www.yworks.com/pages/incremental-diagram-layout)).
   The failure they warn about is exactly ours: with non-incremental layout, *"small changes in data,
   e.g., adding a single new element, may lead to dramatic changes in the resulting drawing."*

4. **Ink and other canvas content orphaned by a relayout.** Already anticipated —
   `canvas-vision.md:147-149` records that strokes belong to the manual arrangement only. Worth
   restating as a hard gate on any layout command: **a layout command moves cards; it must either move
   or refuse to move in the presence of ink it cannot re-anchor.**

---

## 7. What the measurement should actually mean

### 7.1 The measurement, re-measured

I re-derived the numbers from a read-only copy of `~/.config/linsae/linsae.db` (copied to scratch;
the live file was not opened for writing). Reproducible with `python3 sqlite3` over
`file:…?mode=ro`. Findings:

| Fact | Value |
|---|---|
| `notes` rows, all | **438** |
| `notes` rows, live (`deleted_at IS NULL`) | **16** |
| `node_layouts` rows | **4** — all `('root','manual')`, all with non-null x/y (none shelved) |
| Placement dates (`placed_at`) | 2026-06-13, 2026-06-14, 2026-06-29, 2026-06-29 |
| Last `node_layouts.updated_at` | 2026-07-04 |
| Last `canvas_state` camera write | 2026-07-05 |
| `0003_canvas.sql` applied | **2026-06-13 15:10** — first placement 2026-06-13 15:12, two minutes later |
| Notes created, by month | 2026-05: 121 · 2026-06: 310 · 2026-07: 7 |

**Live-note count over the canvas window** (notes created ≤ t and not deleted ≤ t):

| Date | Live notes | Cumulative placed |
|---|---|---|
| 2026-06-05 | 238 | 0 |
| 2026-06-06 | **77** | 0 | ← 253 notes soft-deleted in one day |
| 2026-06-10 | 33 | 0 | ← 45 more deleted |
| **2026-06-13** | 35 | **1** | ← canvas migration applied |
| 2026-06-20 | 36 | 2 |
| **2026-06-29** | 43 | **4** |
| 2026-07-03 | 45 | 4 |
| 2026-07-04 | **16** | 4 | ← 32 more deleted |
| 2026-08-02 (today) | 16 | 4 |

**So the ratio at every moment the canvas existed was 4 placements against a 33–45-note live vault —
about 9–11 %, not 0.9 %.** And "~20 notes with manual positions" would have meant placing roughly
**half the entire live vault** on a surface defined as showing only deliberately placed notes. #96's
threshold was written against an implicit assumption of a several-hundred-note vault that never
existed during the measurement window.

### 7.2 The precondition failure, which is more decisive than the arithmetic

The criterion says *"after ~4 weeks of **dogfooding** the v0.4 canvas."* What the vault contains:

- On 2026-06-20 (mid-window, 36 live notes): **median body length 8 characters**; **28 of 36 bodies
  under 25 characters**. Representative live bodies: `hello`, `jklk`, `fefekllk`, `klsdflk`, `k`,
  `crash test note`, `as;jdlkfasjkl;dfjkl;`.
- The 253 notes soft-deleted on 2026-06-06 were the same: median length 15, contents like `312312313`,
  `qweqweqe`, `sdfjklasj;dklf`.
- Of the 4 placed notes, two are single-token placeholders (one is literally `asd`, one is Cyrillic
  keyboard mash) and two are truncated PDF-excerpt fragments.

This is a **QA vault**. The app was being *tested*, not *used*. The mean body length (605 chars, max
11 232) shows a handful of genuine long notes exist — mostly PDF-derived source notes from v0.6.4
work — but the modal artefact is a smoke-test string.

**A pre-registered kill criterion is only binding if its precondition holds. This one's does not.**
The honest reading is not "the hypothesis survived" and not "the hypothesis was falsified" — it is
**"the experiment did not run."**

### 7.3 The four competing explanations, and what would distinguish them

| # | Explanation | Status given the data | Evidence that would distinguish it |
|---|---|---|---|
| **(a)** | Thinking-space hypothesis is **falsified** | **Not supported.** Falsification requires notes worth placing; the vault had ~30 junk notes. The one behavioural signal (§7.4) points the other way. | A vault with ≥100 real notes, ≥4 weeks of genuine capture use, canvas opened ≥1×/week, and still <10 % of real notes placed **and** near-zero *attempted* placements (see (b)). |
| **(b)** | **Friction**, not concept — placement costs too many steps | **Live, untested.** All five doors exist in code (`▦+`→shelf, context-menu `place on canvas…` with one-shot ghost, `/` picker, double-click create, PDF `Excerpt → place on canvas`) — see `src/renderer/src/feed/NoteBubble.tsx:121,674-675`, `src/renderer/src/canvas/PlacementGhost.tsx:26-32`, `src/renderer/src/canvas/CanvasStage.tsx:81-87`, `src/renderer/src/pdf/PdfReader.tsx:958`. Existence ≠ low cost. | **Attempted-but-abandoned placements.** Count one-shot placements entered vs committed, `/` pickers opened vs `↵`-ed, shelf adds vs shelf drags. High intent + low completion ⇒ friction. Low intent ⇒ not friction. **This is the single most decisive cheap instrument and it does not exist yet.** |
| **(c)** | **Insufficient dogfooding** to conclude anything | **Strongly supported — this is the finding.** §7.2. Median 8-char bodies; app idle since 2026-07-05. | Trivially measurable going forward: weekly count of notes created with body length > 80 chars. Under ~5/week, no canvas conclusion is available at any placement number. |
| **(d)** | **Entry doors are wrong** (no per-note "open on canvas", no feed\|canvas split) | **Plausible but not the leading candidate.** Five doors already exist, more than most tools ship. The two missing doors (`canvas-vision.md:59-64`) are enter-centred-on-a-note and split-pane. | Canvas *opens* per week vs placements per week. Many opens + few placements ⇒ friction (b) or nothing worth placing (c). **Few opens** ⇒ doors (d): the canvas is not in the user's path at all. |

### 7.4 The one positive signal in the data

`note_access(note_id, last_accessed_at, frequency)` (migration `0006`, applied 2026-06-14) has **7
rows**. All four placed notes are among them:

| note (prefix) | placed? | access frequency |
|---|---|---|
| `019eb6a2` | **yes** | **8** (highest in vault) |
| `019ec5f3` | **yes** | 7 |
| `019eb69f` | no | 7 |
| `019f2d17` | no | 6 |
| `019f154e` | **yes** | 6 |
| `019f1d13` | no | 5 |
| `019f10b7` | **yes** | 4 |

Placed notes are **25 % of live notes but 57 % of accessed notes**, and the single most-accessed note
in the vault is placed. With n=7 this is a hint, not a result, and the causal direction is ambiguous
(placing a note may cause access, or the notes worth accessing are the ones worth placing). But it is
the *only* behavioural evidence in the vault and it is **positive for the thinking-space hypothesis**,
not negative. #96's criterion would have discarded it unexamined.

### 7.5 Cheap instrumentation that would make the next measurement decisive

All of these avoid a migration by riding the existing `app_settings` KV
(`0005_app_settings.sql`; keys already in use: `ui.session.v1`, `dock.layout.v1`, `feed.scroll.v1`, …):

1. **`metrics.canvas.v1`** — monotonic counters, flushed on the existing session-persist cadence:
   `canvasOpens`, `oneShotStarted`, `oneShotCommitted`, `oneShotCancelled`, `pickerOpened`,
   `pickerPlaced`, `shelfAdded`, `shelfDragged`, `cardsMoved`. The started-vs-committed pairs are what
   separate (a) from (b); `canvasOpens` separates (d).
2. **`metrics.vaultWeek.v1`** — per ISO week, `notesCreated` and `notesCreatedOver80Chars`. This is the
   precondition gate for (c) and it is two integers.
3. **Nothing needs to be added for retrieval-side evidence** — `note_access` already exists and already
   produced §7.4. It just needs a longer window and a live vault.
4. **A dated "criterion armed" marker** — store the date the corrected criterion started, so
   "~4 weeks" is checkable rather than reconstructed from `updated_at` archaeology as I had to do here.

### 7.6 A corrected criterion, proposed

The original criterion fails on three counts: absolute rather than relative threshold, no precondition
gate, and it measures only the outcome and none of the intermediate funnel. A replacement:

> **Precondition (all must hold, else the criterion does not evaluate):** ≥8 of the last 12 weeks each
> had ≥5 notes created with body >80 chars; the canvas was opened in ≥6 of those 12 weeks; live vault
> ≥100 notes.
>
> **Fires (promote overview direction) if, with the precondition met:** placed notes < 5 % of live
> notes **AND** `oneShotStarted + pickerOpened` < 2 × `placements` (i.e. low *intent*, not just low
> completion).
>
> **Fires differently (fix friction, keep curated) if:** placed < 5 % **but**
> `oneShotStarted + pickerOpened` ≥ 2 × `placements` — intent exists, completion doesn't.
>
> **Curated stands if:** placed ≥ 5 % of live notes, or placements occur in ≥6 of 12 weeks.

The 5 % figure is a judgement, not a derived number — anchor it to Cockburn's density result (§2.3): a
canvas should stay comfortably under ~100 cards to remain fast to search, so on a 1000-note vault
5–10 % is the band where the surface is used *and* still legible.

---

## What this implies for the semantic-zoom milestone

1. **Ship the dot tier as an ephemeral lens, not as a persisted arrangement.** Option (iii) in §5.1:
   computed positions live in a `Float32Array`, never in `node_layouts`. Zero rows written, zero
   migration, trivially reversible, and it keeps #96 reason (c) — the "in which arrangement?" feature
   tax — permanently at bay. This is what `canvas-vision.md:115-122` already says; this research
   confirms it is the right call and supplies the reasons.

2. **Do not activate `arrangement_id`.** Prior art for axis B is empty after 25 years of the
   most spatially sophisticated tools declining to build it (§1.2, §1.4), and the one developer who
   reasoned publicly about it worried it would break a note's *"thingness"*. Leave the column dormant.
   `src/shared/canvas.ts:1-11` already documents it as opaque and explicit-at-every-call-site, which is
   the correct hedge — keep the hedge, don't spend it.

3. **The dot tier's biggest risk is not performance, it is that dots strip the recognition cue.**
   §2.2 is the load-bearing finding: Data Mountain's advantage over a filename list **disappeared in
   the title-cue condition** — pure "remember where you put it" — and its authors named thumbnails as
   a likely major contributor. A dot field is the title-cue condition. **Mitigations to spec:**
   labels on hover/proximity (already planned, `canvas-vision.md:118-120`), colour/shape by `type`
   (`claim` / `question` / `source` — the data already exists), size or opacity by `note_access.frequency`
   (the table already exists and already has data), and a distinct mark for manually-placed dots (§5.3).
   Without at least two of these the dot tier is the exact configuration the 1986 experiment found no
   better than a list.

4. **Design the dot tier around filter + group + focus, not raw scatter.** §3.2: every practitioner who
   reports a global overview as useful describes the same three-step recipe, and every one who reports
   it useless describes the unfiltered default. If the dot tier ships with no filter and no grouping,
   it will reproduce the hairball on purpose. Colour-by-type and filter-by-search-query are the cheap
   versions and both reuse machinery that exists.

5. **`canvas-vision.md:26-28` should be softened.** "overview first, zoom and filter, details on
   demand" describes a product linsae is not building. §4 says the evidence favours detail-first with
   an overview *lens* for a personal, self-authored, growing corpus. Suggest amending to something like
   *"search and detail first; the far-zoom dot tier is an occasional lens for the shape of the whole,
   not the default entry."* This is a prose amendment, not a direction change — the sequencing and the
   locked principles all already behave this way.

6. **`synthesis §6`'s hairball provenance should be annotated.** The ~200/~500 thresholds trace to one
   marketing blog post (§3.1); the one authoritative figure is Obsidian staff's 25 000-file
   *performance* ceiling. The doc's conclusion (manual-first, force-layout-as-local-command) is not
   affected — its *evidence* is thinner than "the strongest finding in this research" suggests, and a
   future reader should know that before leaning on the numbers.

7. **Wire the §7.5 counters before or alongside semantic zoom.** They are three `app_settings` keys and
   a handful of increments. Without them, the next time #96 is revisited the answer will again be
   archaeology over `updated_at` columns, and the friction-vs-concept question will again be
   undecidable. This is the cheapest high-value item in the report.

8. **Do not close #96, and do not declare it fired.** Re-arm it with the §7.6 criterion, note on the
   issue that the 2026-08 measurement was **void on precondition** (QA vault, wrong denominator), and
   record both the corrected denominator and the `note_access` signal so the next reader does not
   re-derive them. Per `CLAUDE.md` §Inline-fix gate: this is a milestone invalidating an issue's
   *premise* — say so on the issue rather than silently leaving a criterion that reads as satisfied.

---

## Open questions

1. **Was the 2026-06-06 / 2026-07-04 bulk soft-delete a data purge or a real curation event?** I
   inferred "test-data cleanup" from body content (median 15 chars, `qweqweqe`-class strings), which is
   strong but circumstantial. If any of those 422 rows were real notes, the live-vault timeline in §7.1
   understates the corpus. Only the user knows.

2. **Is the placed↔accessed correlation (§7.4) causal, and in which direction?** n=7. Distinguishable
   with the §7.5 counters plus a longer window: does `note_access.frequency` rise *after* `placed_at`?

3. **What happens to a *successful* curated canvas at 300 cards?** Cockburn measured 5.0 s retrieval and
   sub-midpoint confidence at 99 items (§2.3). Neither #96 nor `canvas-vision.md` has a story for the
   dense-curated regime. Piles/clusters (Malone; VIKI's spatial parser) are the prior-art answer and are
   currently unlisted in the vision doc's backlog.

4. **Does linsae want axis A (multiple canvases) sooner than the sequencing implies?** Heptabase, VKB,
   Are.na and Obsidian all landed there, and `canvas-vision.md:170-176` already has the design. If the
   thinking-space bet is real, "this note belongs in two contexts" arrives before "I want two layouts of
   one context". Prior art says A is the demanded feature and B is the imagined one.

5. **Should pinned-in-computed-field (§5.2) be prototyped at all, given §5.3?** It is cheap and correct,
   but at dot tier the pins are invisible. It may only make sense at a future *title* tier where nodes
   are distinguishable. Worth a spike only if the title tier ships.

6. **Anderson's HT'25 paper is paywalled** — §3.4 relies on the abstract and indexed summary. If a copy
   surfaces (author preprint, institutional repository), it is the most current survey of why spatial
   hypertext systems die and is worth re-reading before any multi-canvas milestone.

7. **Are there Roam/Logseq-side reports that differ from the Obsidian ones?** §3 is Obsidian-heavy
   because that is where the primary sources are. Roam's graph is cited in `canvas-vision.md:22` but
   I found no primary Roam-community source at all.
