# Designing a Note-Taking App for Technical Material: A Research-Backed Specification

## Orientation

This report addresses your twelve questions in turn, then synthesizes them into concrete recommendations: what the first-class citizen is, what the type system looks like, what the information architecture should be, what UI/UX direction the evidence supports, and a prioritized shipping order. Where evidence is thin or extrapolated, this is flagged explicitly. Throughout, the goal is a tool that supports **effortless capture of thoughts on technical material** with **trajectory/metacognition** as the long-term payoff — not a productivity-blog "second brain."

A summary observation up front, because it organizes everything below: the most reliable cognitive-science findings (illusion of explanatory depth, illusion of knowing, calibration failures, the testing/self-explanation effects, desirable difficulties) all converge on a single design principle. **Comprehension feels complete long before it is complete; capture-only systems consolidate that illusion; only systems that force or seduce learners into generating something — an explanation, a question, a retrieval attempt — surface gaps.** A trajectory/metacognition tool that does not include generation will, with high confidence, become a digital hoarding system that flatters its user.

---

## 1. Knowledge gap detection and metacognitive monitoring

### The core empirical findings

**Rozenblit & Keil (2002), "The misunderstood limits of folk science: an illusion of explanatory depth," *Cognitive Science* 26(5):521–562.** Across 12 studies, people rate their understanding of mechanisms (zippers, toilets, helicopters, bicycles) at ~4–5/7. After being asked to *generate a step-by-step explanation*, ratings drop sharply. The illusion is specific to **explanatory** knowledge (how/why mechanisms work), not factual, procedural, or narrative knowledge. The illusion is strongest when the environment supports "real-time explanations with visible mechanisms" — i.e., things you've seen working. This is the foundational mechanism for thinking that a textbook chapter or a lecture is "understood" when only a surface gestalt has been encoded. Replications (Lawson, 2006, on bicycles; Alter et al., 2010, JPSP, "A Construal Level Account") confirm robustness; Fernbach et al. (2013) showed it extends to political beliefs.

**Glenberg, Wilkinson & Epstein (1982), "The illusion of knowing: Failure in the self-assessment of comprehension," *Memory & Cognition* 10(6):597–602.** When subjects read texts containing *explicit contradictions between adjacent sentences* and were *told to look for them*, they often missed them and rated their comprehension as high. The illusion was worse when contradictions involved inferences, were across paragraphs, or used paraphrase (Epstein, Glenberg & Bradley 1984; Otero & Kintsch 1992). Practical implication: **readers do not actually monitor coherence in real time** — they reach a "feeling of comprehension" based on local fluency, not global integration. The IOK distinguishes monitoring failure (didn't notice a problem) from miscalibration (noticed and was wrong about its severity).

**Dunlosky & Lipko (2007); Dunlosky & Rawson (2012); Dunlosky et al., "Improving Students' Learning with Effective Learning Techniques," *Psychological Science in the Public Interest* (2013) 14(1):4–58.** This monograph is the canonical practitioner reference. Of ten common study techniques, **practice testing** and **distributed practice** receive the highest utility ratings; rereading, highlighting, and summarization receive low utility ratings. The 2021 meta-analysis by Donoghue & Hattie ("A Meta-Analysis of Ten Learning Techniques," *Frontiers in Education*, 242 studies, 1,619 effects, n≈169,000) gave an overall mean d ≈ 0.56, with distributed practice and practice testing strongest. Critically: **students reliably mis-predict which techniques work**, preferring the less-effective ones because they feel fluent (Kornell & Bjork 2007, 2008; Bjork, Dunlosky & Kornell, "Self-Regulated Learning: Beliefs, Techniques, and Illusions," *Annual Review of Psychology* 64 (2013): 417–444). This is the fluency-vs-learning gap.

**Koriat (1997).** "Monitoring one's own knowledge during study: A cue-utilization approach to judgments of learning," *JEP: General* 126:349–370. Judgments of Learning (JOLs) are based on heuristic cues (fluency, familiarity), not the underlying memory trace. Delayed JOLs are far more accurate than immediate JOLs (Nelson & Dunlosky 1991, "delayed-JOL effect").

**Bjork's desirable difficulties.** Bjork, R. A. (1994), "Memory and Metamemory Considerations in the Training of Human Beings," in Metcalfe & Shimamura, *Metacognition*; Bjork & Bjork (2020), "Desirable difficulties in theory and practice," *JARMAC* 9. Conditions that slow apparent learning (spacing, interleaving, varied contexts, retrieval practice, generation) improve long-term retention and transfer. Effortful retrieval that succeeds strengthens memory more than fluent re-exposure (Pyc & Rawson 2009). The *retrieval effort hypothesis* directly contradicts the "easy capture" instinct of most note apps.

**Self-explanation as a gap-surfacing intervention.** Chi, M.T.H. et al. (1994), "Eliciting Self-Explanations Improves Understanding," *Cognitive Science* 18:439–477. **Bisra, Liu, Nesbit, Salimi & Winne (2018), "Inducing Self-Explanation: A Meta-Analysis," *Educational Psychology Review* 30:703–725** — 64 studies, 69 effect sizes, weighted mean **g = 0.55** (moderate-large), positive across subject areas, levels of education, and inducement types. Larger effects for prompts that ask learners to revise initial explanations when new info highlights gaps or errors. Williams & Lombrozo (2010, 2013), "The Role of Explanation in Discovery and Generalization," *Cognitive Science* 34/37 — explaining drives discovery of *unifying patterns*, but can hurt learning when patterns are misleading (Williams, Lombrozo & Rehder 2010, "explanation impairment effect"). Lombrozo (2006), "The structure and function of explanations," *TICS* 10. The mechanism is "subsumptive constraints" — explaining forces commitment to a generalization, which surfaces unsupported leaps.

### Objective signals that correlate with unrecognized gaps (what to instrument)

The literature is thinner here than the user might hope; the strongest signals are:

- **Failure to generate a deep question.** Graesser & Person (1994) showed that the *quality* of student questions correlates with achievement after experience (r values modest but positive); the *frequency* alone does not. Practical signal: the *ratio of deep-reasoning questions to shallow questions* over a topic, where "deep" = causal antecedent, causal consequence, goal-orientation, enablement, instrumental/procedural, expectational. (Detail in §3.)
- **Question density dropoff over a session.** Otero & Graesser (2001), "PREG: Elements of a model of question asking," *Cognition and Instruction* 19:143–175 — questions are triggered by anomalies, contradictions, and obstacles; students who stop asking are not necessarily understanding, they are no longer *noticing* anomalies. **Thin evidence callout:** the specific signal "question rate drops while material gets harder" as a gap indicator is plausible extrapolation from PREG, but I am not aware of a direct study validating it as a metacognitive signal. Worth instrumenting and testing.
- **Self-explanation quality.** Chi (2000) coded explanations into "principle-based," "elaborative," "monitoring statements," and "no explanation." High explainers achieve correct mental models; low explainers do not, even when reading the same text twice. Length is a weak proxy; relational density (predicates per concept) is a better one.
- **Calibration discrepancy.** The difference between predicted and actual performance on retrieval prompts. Nietfeld, Cao & Osborne (2005); recent work by Lin et al. (2025), "Calibration Discrepancy Predicts Students' Subsequent Metacognitive Strategy Use," *IJAIED*, found that early calibration discrepancies predict subsequent strategy use and engagement. Calibration is itself a teachable signal.
- **Contradiction-detection failures.** Direct from Glenberg et al. (1982) — if a system can flag potential contradictions between two notes the user wrote, and the user is not noticing them, that is a strong gap signal. **Thin evidence callout for product use:** the lab paradigm validates the existence of the failure, not its detection in user-generated notes; this is a research opportunity.
- **Confusion-without-resolution patterns.** D'Mello & Graesser (2012), "Dynamics of affective states during complex learning," *Learning and Instruction* 22 — confusion *with resolution* correlates with learning gains; confusion *without resolution* (stuck-confusion) correlates with disengagement and gap. Marking a confusion in a note but never returning to update it is the operational signal.

### Validated interventions to surface gaps

1. **The IOED protocol itself.** Ask the user to generate a *step-by-step mechanism explanation* before rating understanding. Replications consistently show post-explanation rating drops (Rozenblit & Keil 2002, Studies 1–4; Fernbach et al. 2013).
2. **Retrieval practice.** Roediger & Karpicke (2006), "Test-Enhanced Learning," *Psychological Science* 17:249–255; Karpicke & Blunt (2011), *Science* 331:772–775 — retrieval practice produces better long-term learning than concept mapping or repeated study. Effect sizes large (d > 0.5 typical).
3. **Self-explanation prompts** (Bisra et al. 2018, g = 0.55).
4. **Contrastive examples / feature comparison.** Alfieri, Nokes-Malach & Schunn (2013), "Learning Through Case Comparisons," *Educational Psychologist* 48 — comparing cases produces transfer benefits over studying single cases (mean d ≈ 0.5).
5. **Pretesting / errorful generation.** Richland, Kornell & Kao (2009), "The pretesting effect," *JEP: Applied* 15 — even unsuccessful retrieval attempts before instruction enhance subsequent learning.

---

## 2. Open Learner Models (OLMs)

OLMs are intelligent-tutoring-system components that expose the system's model of the learner *to the learner*, intended to drive metacognition and self-regulated learning (SRL).

### Canonical literature

- **Bull, S., & Kay, J. (2007), "Student models that invite the learner in: The SMILI Open Learner Modelling Framework," *International Journal of Artificial Intelligence in Education* 17(2):89–120.** The SMILI framework remains the standard descriptive vocabulary: who accesses the OLM, what's modeled (knowledge, misconceptions, affect, metacognition), in what form (skill meter, structured tree, concept map, Bayesian network, prerequisite/topic graph, weighted lists), with what interactivity (inspect, edit, persuade, negotiate).
- **Bull & Kay (2010), "Open learner models," in Nkambou et al. (eds.), *Advances in Intelligent Tutoring Systems*, Springer.** Surveys forms.
- **Bull & Kay (2013), "Open Learner Models as Drivers for Metacognitive Processes,"** in Azevedo & Aleven (eds.), *International Handbook of Metacognition and Learning Technologies*. The explicit metacognition framing.
- **Bull, Kay & Ginon (2016), "SMILI: A Framework for Interfaces to Learning Data."**
- **Mitrovic, A. & Martin, B. (2007), "Evaluating the effect of open student models on self-assessment," *IJAIED* 17(2)** — empirical evidence that exposing the model improves self-assessment accuracy.

### Systematic reviews

- **Bodily, Kay et al. (2018), "Open learner models and learning analytics dashboards: a systematic review,"** *LAK '18*. Compared OLMs and learner-facing analytics dashboards: OLM research has been more theoretically grounded in educational psychology (SRL, metacognition); dashboards more theoretically thin and oriented toward generic engagement metrics. **Most identified gap**: longitudinal, authentic-context studies, and systematic comparison of design options.
- **Hooshyar, Pedaste, Saks et al. (2020), "Open learner models in supporting self-regulated learning in higher education: A systematic literature review,"** *Computers & Education* 154 — 64 articles. Found OLM objectives concentrated in SRL "Appraisal" and "Performance" phases; "Preparation" phase under-supported. Strong UK/US/AU/NZ research base around Bull, Kay, Brusilovsky, Mitrovic.
- **Jivet, Scheffel, Drachsler & Specht (2017), "Awareness Is Not Enough: Pitfalls of Learning Analytics Dashboards in the Educational Practice,"** *EC-TEL* — finds many dashboards foster competition rather than mastery, omit reference frames, lack pedagogical grounding.

### What forms work for what use

- **Skill meters** are most studied, easy to inspect, but encode no structure. Best for "did I cover this." Bull & Kay (2007).
- **Concept/structured maps** support exploration but increase visual complexity; outperform skill meters for transfer when domain has structure (Mabbott & Bull 2006).
- **Bayesian / prerequisite-graph OLMs** (Conati's work; Brusilovsky et al.) handle uncertainty and dependencies; richer but harder to interpret. *This is what Math Academy effectively implements at scale (§10).*
- **Negotiated/persuadable OLMs** (Bull, Mabbott & Dimitrova) — the user can challenge the system's beliefs; produced higher engagement but mixed learning effects.

### Documented failure modes

- **Trust and acceptance.** Ahmad & Bull (2008), "Do students trust their open learner models?" *AH '08* — students often distrust OLM judgments and avoid uncomfortable views.
- **Misframing.** Jivet et al. — comparison to peers can demoralize; comparison to self over time better supports mastery framing.
- **Interaction with SRL.** OLMs help most for learners *already* engaged in SRL; weaker SRL learners need scaffolding (Bull & Kay 2013). This is critical for an n=1 sophisticated user — you'll get more from an OLM than the average user, but it still needs to be designed not to demoralize.

### Implication for your app

You should ship a **lightweight OLM** of the user's notes-territory: a structured representation of the topics/concepts they have engaged with, with measures of *attention* (recency, depth of engagement) and *coverage* (questions raised vs. resolved, retrieval prompts vs. successes). Default visualization should compare to **the user's past self over time**, not to abstract mastery. SMILI's "context, content, structure, presentation, access" rubric is the cleanest design checklist.

---

## 3. Taxonomies of questions and thoughts

### Graesser & Person (1994), "Question Asking During Tutoring," *American Educational Research Journal* 31(1):104–137.

The 16-category taxonomy (drawn from Graesser, Person & Huber 1992 and elaborated in Graesser & Person 1994):

| # | Category | Example |
|---|---------|---------|
| 1 | Verification | Is X true? |
| 2 | Disjunctive | Is X or Y? |
| 3 | Concept completion | Who/what/when/where? |
| 4 | Example | What's an instance of X? |
| 5 | Feature specification | What attributes does X have? |
| 6 | Quantification | How much/many X? |
| 7 | Definition | What does X mean? |
| 8 | Comparison | How is X like/unlike Y? |
| 9 | Interpretation | What does this configuration mean? |
| 10 | Causal antecedent | What state/event led to X? |
| 11 | Causal consequence | What does X lead to? |
| 12 | Goal orientation | What is the goal of agent doing X? |
| 13 | Instrumental/procedural | How does one accomplish X? |
| 14 | Enablement | What enables X to occur? |
| 15 | Expectation | Why didn't X happen? |
| 16 | Judgmental | What is one's value judgment of X? |

### The depth scale and its empirical validation

Graesser, Ozuru & Sullins (2010), "What is a good question?" in McKeown (ed.), *Bringing Reading Research to Life*. The 16 categories cluster into:
- **Shallow (1–4):** verification, disjunctive, concept completion, example
- **Intermediate (5–8):** feature, quantification, definition, comparison
- **Deep (9–16):** interpretation, causal antecedent/consequence, goal, instrumental, enablement, expectation, judgmental

Graesser & Person (1994) reported the depth scale **correlates r ≈ 0.64 with levels 2–6 of Bloom's taxonomy**. Critically: in classrooms, ~96% of questions come from teachers, mostly shallow; in tutoring, student question rate is ~240× classroom rate but still skewed shallow. **Quality (depth), not raw frequency, correlates with achievement** (Graesser & Person 1994; Wisher & Graesser 2007).

Craig, VanLehn & Chi (2009), "Student questions and deep reasoning," cites deep-reasoning questions as those starting with "why," "how," "what-if" — paragraph-length answers, integrative.

### Lower-cardinality collapsings that work in practice

- **3-tier shallow/intermediate/deep** (Graesser et al. 2010). This is what's used most in research.
- **Kopp et al. (2018)** — modified Graesser-Person scheme with collapsed bins for question-generation tutoring (iSTART-2 deployment).
- **Erdoğan & Campbell** revision used in inquiry-based math problem solving (Erdoğan 2017).

For your app, a defensible 4-tier collapsing:
1. **Lookup/clarification** (verification, concept completion, definition) — "what is X?"
2. **Specification** (feature, quantification, comparison, example) — "what are the parts of X?"
3. **Mechanism** (causal antecedent/consequence, enablement, instrumental, goal) — "how/why does X work?"
4. **Stance** (interpretation, expectation, judgmental) — "what do I think about X / why doesn't this fit?"

This maps cleanly to the trajectory use case: tier-4 ("stance") questions are the metacognitive ones; tier-3 are the causal/explanatory ones whose absence indicates IOED.

### Bloom revised (Anderson & Krathwohl, 2001)

*A Taxonomy for Learning, Teaching, and Assessing*, Allyn & Bacon. Two dimensions: **Cognitive Process** (Remember, Understand, Apply, Analyze, Evaluate, Create) × **Knowledge Type** (Factual, Conceptual, Procedural, Metacognitive). Krathwohl (2002), "A Revision of Bloom's Taxonomy: An Overview," *Theory Into Practice* 41(4). The Knowledge × Process matrix is more useful than the level alone for designing prompts. Note that the "metacognitive knowledge" cell is precisely what the user wants to surface; few notes apps even acknowledge it exists.

### ICAP (Chi & Wylie, 2014, *Educational Psychologist* 49(4):219–243)

Engagement modes hierarchy: **Interactive > Constructive > Active > Passive**. Constructive = generates new content beyond source (self-explanation, drawing concept maps, posing questions). Active = manipulates source (highlighting, copying). Passive = receives. The validation review covers note-taking, concept mapping, and self-explaining specifically. Key prediction: **constructive activity > active activity by a large margin**, larger than any other gap in the hierarchy.

Caveat: Sätterlund-Larsson et al. (2023), "Questioning central assumptions of the ICAP framework," *npj Science of Learning* — argues hierarchy is empirically less convincing than claimed and observable behaviors do not reliably indicate covert mode (novices may benefit from teacher-guided "passive" instruction). Treat ICAP as a useful design heuristic, not a strict ordering.

### Inquiry-based / student-generated questioning literature

Multiple meta-analyses (Lazonder & Harmsen 2016, *Review of Educational Research* 86; Kaçar et al. 2021) find inquiry-based learning produces small-to-moderate achievement gains over traditional instruction (g ≈ 0.3–0.5), with larger effects when guidance is appropriate to learner expertise. Student question generation specifically: Rosenshine, Meister & Chapman (1996), *Review of Educational Research* 66, found median d ≈ 0.36 for question-generation training on comprehension.

---

## 4. Tags, taxonomies, and organizational structures in PKM

### The empirical picture is messier than practitioner blogs admit

The most-cited PIM-tag studies are now 10–20 years old:
- **Bergman, Beyth-Marom & Nachmias (2003, 2008),** *Personal Information Management* — folder hierarchies remain dominant in user behavior despite tag availability.
- **Civan, Jones, Klasnja & Bruce (2008), "Better to organize personal information by folders or by tags?" *ASIST*.** Mixed results; tags useful for re-finding items that fit multiple categories, folders better for items with a single primary location. Most users preferred folders for the cognitive offloading.
- **Voit, Andrews & Wagenleitner (2012), "Tagging vs. Hierarchical Folders for Personal File Management."** Tag systems outperformed folders on multi-faceted queries, comparable for single-facet.
- **Marshall (1998–2009)** on annotation/spatial use — users *resist* premature formalization. People will pile, sort, and only later commit to structure.

**Observed user behavior in deployed systems** (Evernote, Notion, Obsidian — mostly from product analytics blog posts and small qualitative studies; **thin evidence callout**: I am not aware of large peer-reviewed empirical analyses of tag use across these apps): users typically build small tag vocabularies (~20–50 tags) but lose discipline within a year; tag inflation and inconsistent capitalization are the primary failure modes.

### Matuschak's argument against tags

Matuschak's notes (notes.andymatuschak.org) argue tags are a weak association structure because they do not say *why* or *how* two things are related — they only say "these are both about X." A *contextual link* in a sentence ("…this connects to [[Note B]] because of the systematicity bias…") encodes a relationship; a tag does not. This is an argument from expressive power, not direct empirics. The Zettelkasten community (Ahrens 2017, Doto, Tietze) substantially agrees but treats structure tags ("hub notes") as legitimate.

### Hierarchical vs. associative ontologies for memory and retrieval

- **Bower et al. (1969),** "Hierarchical retrieval schemes in recall of categorized word lists," *J. Verbal Learning & Verbal Behavior* 8 — hierarchies ~3× recall over random presentation. Classic.
- **Collins & Quillian (1969); Collins & Loftus (1975),** spreading-activation models — semantic networks predict retrieval times better than strict hierarchies. **Memory is associative more than hierarchical.**
- **Anderson (1983), ACT*** — declarative memory as a network of propositions with activation spreading.
- **Implication:** purely hierarchical filing systems work *against* the way memory naturally associates. But purely associative systems (a graph of every-thought-linked-to-every-thought) overwhelm working memory at retrieval. The **river-and-lake** dichotomy that Heptabase popularizes (whiteboards as flexible spatial overviews + structured notes as the lake) maps roughly to dual-coding and spatial memory benefits.

### Content tags vs. action tags vs. status tags

This distinction is practitioner (Tiago Forte, Joel Chan); I have no peer-reviewed direct study. The best academic anchor is **Marshall (1997, 1998), "Toward an ecology of hypertext annotation,"** which documented *functional* differences in how readers used marginalia (anchors, queries, structure marks, working memory aids). The four functions Wolfe (2002) identified — facilitating later writing, eavesdropping, providing feedback, communication — map loosely to your content/action/status distinction.

**Practical conclusion:** Tags as a *single* untyped structure are weak; **typed associations** (link with a type: *contradicts*, *is-instance-of*, *prerequisite-of*, *resolves*, *example-of*, *generalizes*) are strictly more expressive. This is the IBIS/Toulmin/RDF insight.

---

## 5. The first-class citizen / data model question

### What the literature points to

- **Atomicity and the "evergreen note as fundamental unit"** (Matuschak; Ahrens 2017, *How to Take Smart Notes*; Luhmann's Zettelkasten). Pragmatic, well-reasoned, but not directly tested empirically.
- **Toulmin (1958), *The Uses of Argument*.** Argument structure: claim / data (grounds) / warrant / qualifier / rebuttal / backing. Operationalized in education research (Erduran, Simon & Osborne 2004, *Science Education* 88) as a coding scheme for argumentation quality. Strength: forces explicit warrants, which is exactly what surfaces hidden assumptions.
- **IBIS (Kunz & Rittel 1970; Conklin & Begeman 1988, *gIBIS*).** Issue / Position / Argument. Designed for design rationale and wicked problems; deployed in Compendium. Conklin reports decades of use, primarily corporate sense-making; weak controlled-study evidence but strong practitioner track record.
- **Semantic Web / RDF triple (subject-predicate-object).** W3C standard. Tremendous expressivity, but: real-world adoption shows that **getting users to author triples is too costly**; semantic-web personal knowledge has remained a research curiosity (Heath & Bizer 2011, *Linked Data*).
- **Ologs (Spivak & Kent 2012, *PLoS One*).** Category-theoretic refinement of semantic networks; superior in formal expressibility (commutative diagrams enforce equivalence facts). Mathematically attractive for a math-trained user, but **no evidence of authoring scalability**; primarily a research tool.
- **Hypertext lineage.** Bush, *As We May Think* (1945); Engelbart, *Augmenting Human Intellect* (1962); Nelson, *Literary Machines* (1981). Memex, NLS, Xanadu — node-and-link as the fundamental abstraction. Halasz (1988, *CACM*), "Reflections on NoteCards: Seven Issues for the Next Generation of Hypermedia," remains a useful tour of the unsolved problems (search, versioning, tailorability, computation in nodes, collaboration, extensibility, trail-based access).
- **Spatial hypertext** (Marshall & Shipman 1995, "Spatial hypertext: designing for change," *CACM*). Implicit structure via spatial proximity is *more* natural than explicit links because users avoid premature formalization. VIKI/VKB and Tinderbox embody this. Marshall & Shipman (1997), "Spatial hypertext and the practice of information triage," *Hypertext '97* — empirically shows spatial layouts outperform paper for triage tasks.

### What the trajectory/metacognition use case demands

Your use case has three distinctive needs:
1. **Versioning of belief.** "What did I think then? What changed?" — implies time-stamped, append-only revisions, not destructive edits.
2. **Question-state.** "Did I ever answer my own question?" — implies questions are first-class, with status (open, parked, resolved-by-X) and resolution links.
3. **Cross-source confusion.** "These two sources contradict and I didn't notice." — implies *typed* relations between thoughts, at minimum a `tension`/`contradicts` type.

**The first-class citizen should be the *thought*, not the *note*, with thoughts being typed.** A note is a container; a thought is what learners actually want to revisit. The minimum viable type system, drawn from Toulmin + IBIS + Graesser:

- **Question** (with status: open/parked/resolved; with depth tier 1–4 from §3)
- **Claim** (with confidence; with backing thoughts; with possible rebuttals)
- **Observation/Excerpt** (raw capture; source-anchored)
- **Explanation/Mechanism** (the IOED-surfacer)
- **Confusion/Tension** (named gap, source-anchored, may or may not resolve)
- **Connection** (typed link to another thought: *contradicts*, *generalizes*, *is-example-of*, *prerequisite-of*, *resolves*, *analogous-to*)

This is a *small* type system. The literature (Halasz 1988; Marshall 2009 on annotation typing) consistently finds that large type systems are abandoned. Six-to-eight types is the upper bound seen in deployed argumentation systems (Compendium, DRed).

---

## 6. Most important features for technical-material note-taking

### Handwriting vs. typing

- **Mueller & Oppenheimer (2014), "The Pen Is Mightier Than the Keyboard," *Psychological Science* 25(6):1159–1168.** Three studies; longhand outperformed laptop note-takers on conceptual questions; mechanism proposed: laptop encourages verbatim transcription, longhand requires reformulation. Heavily cited.
- **Replications failed.** **Morehead, Dunlosky & Rawson (2019), "How Much Mightier Is the Pen than the Keyboard for Note-Taking? A Replication and Extension of Mueller and Oppenheimer (2014)," *Educational Psychology Review* 31:753–780** — direct replication; small non-significant effects favoring longhand; effects further reduced after note review; even the "no-notes" group performed similarly. **Urry et al. (2021), "Don't Ditch the Laptop Just Yet," *Psychological Science* 32(2)** — direct replication of Study 1 plus mini-meta-analysis; effect not robust.
- **Bottom line:** the strong-form claim (longhand > laptop for conceptual learning) is **not robust**. The plausible weaker claim — **what matters is reformulation, not modality** — is consistent with all data. Verbatim transcription is bad; reformulation is good. Either modality can support either.
- **Recent neuroscience.** Van der Weel & Van der Meer (2024), "Handwriting but not typewriting leads to widespread brain connectivity," *Frontiers in Psychology* — EEG shows greater connectivity during handwriting. Suggestive but does not bridge to learning outcomes.

### Implication for math/technical material

Handwriting/ink is essential for *equations* and *diagrams* — these are extremely costly to type/draw with keyboards. Math-Academy-style step-by-step problem solving is more naturally captured in ink. The argument is **representational adequacy**, not "ink causes learning." Mathpix, MyScript, and similar OCR-to-LaTeX engines now make ink interoperable with text.

### Self-explanation prompts inline

Bisra et al. (2018) g = 0.55. The mnemonic medium (Matuschak & Nielsen 2019, *Quantum Country*; Nielsen 2018, "Augmenting Long-Term Memory") demonstrates author-authored prompts embedded in technical text supporting both memory and conceptual understanding. *Quantum Country* logs (Matuschak 2020) report median completion of 7+ review sessions over months — exceptional adherence relative to standalone Anki.

### Spaced repetition integration

**Cepeda et al. (2006), "Distributed Practice in Verbal Recall Tasks: A Review and Quantitative Synthesis," *Psychological Bulletin* 132(3):354–380** — 317 experiments; distributed practice produces large benefits; optimal lag scales with retention interval. Karpicke & Roediger (2008), *Science* 319 — testing > restudying for long-term retention. SuperMemo SM-2/SM-5 algorithms (Wozniak), Anki, Orbit (Matuschak), RemNote — all derive from this evidence base.

### PDF / video annotation

- **Video annotation with timestamps.** Yousef, Chatti & Schroeder (2014), "Video-Based Learning: A Critical Analysis," *iJET*; Mu (2010), "Towards effective video annotation," *Computers & Education* — Smartlinks, hyperlinked timestamps, navigation back to the annotated segment all support recall and review. Most effects on engagement, not robust learning gains; this is a *capture-affordance* story, not a learning-effect story.
- **PDF/marginalia.** Marshall (1997, 1998) — anchors, working memory aids, structure marks, queries, content interpretation; functional taxonomy. Wolfe (2002), "Annotation technologies: A software and research review," *Computers and Composition* 19. These are descriptive, not effect-size, studies.

### Retrieval practice / testing effect

- **Roediger & Karpicke (2006),** "Test-Enhanced Learning," *Psychological Science* 17 — initial testing produces 50% advantage at 1-week retention.
- **Adesope, Trevisan & Sundararajan (2017), "Rethinking the Use of Tests: A Meta-Analysis of Practice Testing," *Review of Educational Research* 87 — 118 studies, mean g ≈ 0.61** for practice testing over restudying.
- **Rowland (2014), "The Effect of Testing Versus Restudy on Retention: A Meta-Analytic Review of the Testing Effect," *Psychological Bulletin* 140 — overall g ≈ 0.50.**

### Concept maps

Nesbit & Adesope (2006), "Learning With Concept and Knowledge Maps: A Meta-Analysis," *Review of Educational Research* 76 — moderate effects for retention and transfer; **constructing maps (g = 0.72) > studying given maps (g = 0.43)** (Schroeder et al. 2018, *Educational Psychology Review* 30; Yang et al. 2024 STEM-specific meta-analysis g = 0.63). Constructing wins.

---

## 7. Research-backed UI/UX

### Cards vs. linear vs. canvas vs. outline

- **Outlines** match hierarchical-recall benefit (Bower 1969) and support nesting; Workflowy/Logseq/RoamResearch lineage. Strong for procedural and mathematical material with nested case structure.
- **Cards** correspond to Zettel-atomicity and support spatial layout (Marshall & Shipman). Heptabase and Scrintal embody this. Better for *exploration* and *triage* than for linear consumption.
- **Canvases** support spatial hypertext's affordance: implicit structure through arrangement, deferred formalization, "information triage" (Marshall & Shipman 1997). Best for early-stage thinking; worst for exhaustive search.
- **Linear documents** support narrative argumentation; Halasz's NoteCards retrospective argued narrative flow is undervalued in node-link systems.

The strongest empirical finding here is that **layout flexibility itself supports cognition**: Larkin & Simon (1987), "Why a diagram is (sometimes) worth ten thousand words," *Cognitive Science* 11, on the computational equivalence-but-cognitive-difference of diagram and sentential representations. Spatial layout offloads working memory.

### Nonlinear note-taking research

Halasz (1988); Marshall & Shipman; van Dijk & Kintsch (1983) on text comprehension — readers reconstruct macrostructure regardless of input form. The finding most relevant to your use case: **users delay structure**; tools that demand structure at capture time get abandoned. Capture must be cheap and structureless; structure should be progressive.

### Mobile vs. desktop capture

Sellen & Whittaker (2010), "Beyond Total Capture: A Constructive Critique of Lifelogging," *CACM* 53(5) — capture is cheap; *retrieval and re-engagement* are where the value is created or destroyed. Mobile reduces capture friction; desktop better for synthesis. The pattern that works in deployed systems (Drafts, Apple Notes quick capture, Bear) is mobile-for-fleeting, desktop-for-evergreen — matching Ahrens's fleeting/literature/permanent stages.

### Multimodal capture

No single canonical study; the most rigorous treatment is Oviatt (2006, 2013) on multimodal interaction — speech + ink + text combined reduces error rates and cognitive load over single-modality input, particularly for spatial/diagrammatic tasks. **Thin evidence callout for note-taking specifically:** the multimodal-note studies are mostly small or descriptive (e.g., MaRginalia 2024 MR + tablet study).

### Friction at capture

Cooper's original *About Face* introduced "cognitive friction"; Nielsen heuristics provide the standard checklist. The literature converges on **<3-second capture-to-saved** as the tolerable upper bound for "fleeting" capture; above this, users defer and forget.

### Marginalia studies

Marshall (1997, 1998); Bold & Wagstaff (2017) survey of e-book annotation practices — readers want annotation but find current tools inadequate, particularly for cross-document anchoring. Annotations are **inherently anchored** (to a span of text, a timecode, a region of an image); preserving the anchor is critical for re-engagement.

---

## 8. Time as a first-class dimension

### Lifelogging and episodic-memory cues

- **Sellen, Fogg, Aitken, Hodges, Rother & Wood (2007), "Do life-logging technologies support memory for the past? An experimental study using SenseCam," *CHI '07* — 19 participants; SenseCam-cued recall significantly better than other-cue conditions.**
- **Lee & Dey (2008, 2011)** — MemExerciser; cue-by-cue review preserves retrieval effort.
- **Hodges et al. (2011),** SenseCam clinical use in amnesia. Mair & Shacham (2017–2019) — both younger and older adults benefit from end-of-day review of lifelog photos for cued recall.
- **Sellen & Whittaker (2010), "Beyond total capture," *CACM* 53(5)** — caution: capture without curation produces noise. The *cuing* properties matter (egocentric perspective, distinctiveness, semantic richness). Implication for notes: random timestamp browsing is weak; **structured temporal review** ("what I was working on this week", "questions I asked but never answered") is strong.

### Episodic context as retrieval cue

Tulving (1972, 1983) — episodic memory is fundamentally context-bound. Godden & Baddeley (1975) context-dependent memory — encoded context (when, where, with what mood) cues retrieval. **For notes: "I wrote this while reading X, on date Y, in context Z" is a powerful retrieval cue, often stronger than topical search.**

### Timeline UIs and version history

- **Plaisant et al. (1996), LifeLines, *CHI '96*; Bederson & Plaisant** lineage on timeline visualization.
- **Git/document version control** literature is software-engineering-focused (commit-as-unit, diff-as-display) and maps awkwardly to cognitive review. Code-review UI is *change-oriented* (what changed and why); cognitive review is *belief-oriented* (what did I believe then; what do I believe now; how did the belief evolve). **A Git-style diff is the wrong UI** for the trajectory use case; what's wanted is more like a "belief timeline" — for each claim or question, the sequence of revisions of one's stance, with the trigger (note added on date X) annotated.

**Thin evidence callout:** I am not aware of HCI studies of "belief revision history" UIs in personal contexts. Forecasting platforms like Manifold and PredictionBook have informal practice; Tetlock's *Superforecasting* discusses calibration tracking. This is a research gap and a design opportunity.

---

## 9. Information architecture for PKM

### Search modalities

- **Faceted search** (Hearst, Pollitt, Marchionini, Shneiderman, late 1990s/2000s; Yee, Swearingen, Li & Hearst 2003, *CHI*): empirically improves exploratory search effectiveness ~30% over alphabetical browse for digital libraries (Yeh & Liu 2007). Best when items have stable, multiple, orthogonal facets.
- **Full-text search.** Strong for known-item retrieval; weak for "the thing about X" semantic search.
- **Semantic / vector search** (Salton-era IR through modern embeddings). Recent MeRT/InfraNodus/embedding-search work shows vector search excels at re-finding conceptually related notes the user phrases differently from how they wrote them. Practical caveat: embedding search shows you "things vaguely like" but loses precision; should be paired with keyword.

### What deployed systems do (and the empirical claims for them)

| System | Primary unit | Primary structure | Strengths | Weaknesses (per HCI lineage) |
|--------|-------------|-------------------|-----------|------------------------------|
| Roam | Block | Backlinks + daily notes | Fast capture, transclusion | Pricing, performance at scale, abandoned blocks |
| Obsidian | Markdown file | Backlinks + folders + tags | Local files, plugin ecosystem | Graph view largely cosmetic at scale |
| Logseq | Block (outline) | Backlinks, journal-first | Open source, local | UI rough edges, mobile lag |
| Notion | Block / page | Database + nesting | Structured data, sharing | Heavy formalization tax, slow capture |
| RemNote | Block | Backlinks + spaced repetition | Integrated SR | Smaller ecosystem |
| Heptabase | Card on whiteboard | Spatial + tags | Visual thinking | Whiteboard sprawl |
| Tana | Node with supertags | Typed structured content | Powerful structured queries | Learning curve, complexity |
| Reflect | Note | Backlinks + AI | Speed, AI assist | Less structured |

**No peer-reviewed comparative HCI studies exist for these systems specifically** — most are popular blog comparisons. The closest academic analysis is Anderson (2023), "Seven Hypertexts," *HT '23*, which traces the historical lineage and notes contemporary PKM tools have largely re-implemented earlier hypertext research while remaining unaware of it.

### A research-justified IA for the described use case

Each node and edge below is annotated with the literature it draws on.

**Nodes (entities):**
- **Source** (PDF, video, lecture recording, web page) — with anchor support [§7 marginalia literature: Marshall 1997, 1998]
- **Excerpt** (a span/timecode/region in a Source) — required for anchored annotation [Marshall, Wolfe 2002]
- **Thought** (typed: question, claim, observation, explanation, tension, connection — see §5) [Toulmin 1958; IBIS Kunz & Rittel 1970; Graesser & Person 1994]
- **Topic** (lightweight concept, may be many-to-many with thoughts) [structured-tree OLM, Bull & Kay 2007]
- **Session** (a contiguous capture episode, with timestamp + context) [episodic memory, Tulving 1972; Sellen et al. 2007]
- **Review event** (retrieval attempt, calibration prediction, self-explanation prompt response) [Roediger & Karpicke 2006; Bisra et al. 2018; calibration literature]

**Edges (typed connections):**
- `excerpt-of`, `anchored-to` (Excerpt → Source)
- `responds-to`, `prompted-by` (Thought → Excerpt or Thought)
- `contradicts`, `tensions-with` [Glenberg et al. 1982; surfacing IOK]
- `generalizes`, `instance-of` [Williams & Lombrozo 2010 on subsumption]
- `prerequisite-of` [Math Academy / Bayesian Knowledge Tracing; §10]
- `resolves`, `partially-resolves` (Thought → Question) [trajectory use case]
- `analogous-to` [Gentner structure-mapping; §10]
- `supersedes` (Thought → earlier Thought) — for belief revision [§8 trajectory]

**Default views:**
- **Timeline** ("what I was thinking when") — episodic cue [Sellen 2007, Tulving]
- **Topic / OLM** ("what I have engaged with") — Bull & Kay
- **Open questions** — graphically prominent unresolved-question list
- **Tensions inbox** — explicit IOK-surfacing surface
- **Today's review** — spaced-repetition deck of past prompts/questions

This is a graph structure with emphasis on *typed relations* and *time*, not a flat folder tree, and not a plain wiki of bidirectional untyped links.

---

## 10. Cross-topic and cross-source confusion tracking

### Prerequisite knowledge graphs

- **Math Academy** (Justin Skycak): explicit prerequisite DAG of ~thousands of topics, with "encompassing weights" (fractional credit when post-requisites implicitly exercise prerequisites). This is mastery learning at granularity (Bloom 1984, "The 2 Sigma Problem"). Math Academy's results are practitioner reports; no peer-reviewed efficacy study at the time of this report. The structural idea, however, is well-grounded in the ITS literature.
- **Bayesian Knowledge Tracing (BKT)** — Corbett & Anderson (1995), "Knowledge Tracing: Modeling the Acquisition of Procedural Knowledge," *User Modeling and User-Adapted Interaction* 4 — hidden-Markov model with learn/slip/guess parameters per skill. Decades of deployed use in Cognitive Tutors.
- **Performance Factors Analysis (PFA)** — Pavlik, Cen & Koedinger (2009).
- **Deep Knowledge Tracing (DKT)** — Piech et al. (2015), *NeurIPS* — RNN-based, originally claimed large gains over BKT.
- **Critical replications:** Khajah, Lindsey & Mozer (2016), "How deep is knowledge tracing?" *EDM* — when BKT is properly extended (recency, contextualized trial sequence, inter-skill similarity, individual variation), it matches DKT. Wilson et al. (2016) — IRT extensions match DKT. Gervet et al. (2020) — DKT not always best. **Net:** the *structure* of a prerequisite graph and a per-skill mastery estimate is the durable insight; the choice of estimation algorithm matters less than the graph.

### Cross-domain analogy

- **Gentner (1983), "Structure-Mapping: A Theoretical Framework for Analogy," *Cognitive Science* 7:155–170.** Analogy = mapping of *relational* structure between base and target, with systematicity preference (higher-order constraining relations preferred over isolated predicates).
- **Falkenhainer, Forbus & Gentner (1989), "The Structure-Mapping Engine,"** *Artificial Intelligence* 41 — computational implementation; still in deployed use.
- **Gick & Holyoak (1980, 1983)** on analogical transfer: spontaneous transfer is rare without surface-similarity cues; transfer improves with multiple worked examples and explicit comparison.
- **Forbus and colleagues (DTA, MAC/FAC, SAGE).** Domain transfer via analogy, structural alignment, schema induction.
- **Goldwater & Schalk (2016), Alfieri et al. (2013)** — comparing cases/examples produces transfer benefits in STEM (d ≈ 0.5).

### Archetypal cross-topic confusion patterns

The literature identifies recurring patterns:
- **Surface-similar, structurally-different** (the most-classic confusion): two domains use similar vocabulary or notation but the underlying relations differ (e.g., "gradient" in calculus vs. ML training; "kernel" in algebra vs. ML).
- **Structurally-similar, surface-different** (analogies the user *should* see but doesn't): e.g., max-flow/min-cut and LP duality; the substitution lemma and beta-reduction.
- **Prerequisite collapse**: a missing earlier concept silently degrades all post-requisite reasoning (Math Academy's central design assumption).
- **Term-overloading**: same word means different things in adjacent subfields (e.g., "spectrum" in linear algebra vs. functional analysis vs. topology).
- **False equivalence**: two superficially similar formalisms equated (e.g., "probability" vs. "credence" vs. "frequency").

**Implication:** the app should support `analogous-to` and `contrasts-with` typed links, and possibly track per-term contexts (this is heavy lifting but high-leverage for math). When the user creates two notes with the same titular term in different topic clusters, that's a notable signal worth surfacing.

---

## 11. Prioritized shipping order

The following ordering follows three principles, all evidence-grounded:
- **Capture friction must be near zero or notes don't accumulate** (Marshall on premature formalization; Sellen & Whittaker on capture-vs-engagement).
- **Constructive activity (ICAP) is what produces learning** — but it must be optional or offered at re-engagement time, not at capture time, or capture friction will ruin the system.
- **Trajectory features are durable only if the underlying data model is right from day one** — they cannot be retrofitted onto an unstructured note pile.

### v0 (MVP — must ship): the spine

1. **Atomic capture**, sub-3-second, of: text, ink, screenshot, audio, and source-anchored excerpt (PDF region, video timestamp, web URL+selection).
2. **A typed-thought primitive**, with at minimum these types: `question`, `claim`, `observation`, `tension`. Captures with no chosen type default to `observation`. Type is a one-keystroke toggle, not a modal dialog. (This is the bet that pays off later for trajectory; if v0 only stores plain text, you cannot retrofit.)
3. **Anchors**: every capture remembers source, timestamp, and (for annotations) precise location.
4. **Search** (full-text + recency-weighted) — Halasz's first unsolved-problem of hypertext.
5. **Bidirectional links** (`[[wikilink]]` syntax) — table stakes per all PKM-system precedent.
6. **Local-first storage**, plain-text where possible (markdown + sidecar JSON for typed metadata) — for data ownership and AI privacy (§12).

Justification: 1 minimizes friction (collector's-fallacy mitigation requires that notes get *used*, but it begins with notes existing). 2 is the structural commitment that enables later metacognition without re-architecting. 3 enables every higher-level feature (re-engagement with source, marginalia review).

### v1: the metacognition surface

7. **Question dashboard** (open / parked / resolved status), filterable by depth tier (Graesser & Person; §3).
8. **Tension/contradiction inbox**: surfaces user-flagged tensions, unresolved.
9. **Self-explanation prompt at note-creation** *as an opt-in*, lightweight: "Explain in one sentence why this is true / how this works." (Bisra et al. 2018, g = 0.55.)
10. **Spaced retrieval prompts** for user-defined questions and claims, scheduled per SM-2-class algorithm (Cepeda et al. 2006; Roediger & Karpicke 2006).
11. **Time-based review feed** ("what I was thinking this week / month / year ago") (Sellen et al. 2007, episodic cuing).

Justification: this is where the trajectory thesis is tested. If users return weekly to surface and resolve open questions, the system has moved beyond capture-only.

### v2: the structured map

12. **Topic structure** (lightweight tags or hub-notes), with an OLM-style coverage view (Bull & Kay 2007, structured tree). Default visualization: yourself over time (Jivet et al. 2017 caution against social comparison).
13. **Typed connections** beyond `[[link]]`: `contradicts`, `generalizes`, `is-instance-of`, `prerequisite-of`, `analogous-to`, `resolves`. UI: type-as-you-link.
14. **Belief-revision history** for individual claims: when a claim is updated, prior version is preserved with a `supersedes` link and the trigger (the new note that changed your mind) annotated. (This is the Git-but-for-beliefs idea; novel territory — flagged as an experimental feature.)
15. **Integrated PDF and video annotation** with timecode/region anchors — already in v0 as capture but now first-class with replay.

### v3: the inferential layer

16. **LLM-assisted gap surfacing** (local where possible): scan recent notes for IOED candidates ("you've used 'spectral decomposition' three times across notes; can you generate a step-by-step explanation?"), analogy candidates, and contradiction candidates. **The LLM proposes; the user decides.** This is the IOED protocol operationalized.
17. **LLM-assisted question-generation in the Graesser depth taxonomy**: tier-1/2 questions for confirmation, tier-3 (mechanism) for IOED, tier-4 (stance) for trajectory.
18. **Prerequisite graph** for technical topics, semi-automatic. Math Academy demonstrates the manual upper bound; LLMs make a good-enough version tractable. Use it to flag "you're attempting topic X but haven't engaged with prerequisite Y."
19. **Open Learner Model visualization**: explicit, inspectable view of "what the system thinks you know," with the ability for the user to challenge it (negotiated OLM, Bull & Mabbott).

### v4 (optional): the social/imagined-reader layer

20. **"Garage-door-up" public publishing** of selected evergreen notes (Matuschak's pattern). The audience-effect literature is mixed (§12 below) but the *option* to publish appears to drive higher-quality construction in self-reports.
21. **Import/export to standard formats** (Markdown, RDF triples for typed connections) — for portability and second-brain interop.

---

## 12. Meta-questions / blind spots

These are issues you didn't ask about that the literature suggests will dominate the project's success or failure.

### A. The collector's fallacy is the dominant failure mode of PKM

Tietze (zettelkasten.de), Doto (writing.bobdoto.computer), and the broader Zettelkasten community consistently identify *piling without processing* as the modal failure. **Practitioner sources only,** but consistent across decades of practice. Operational counter: every note older than N days that has never been linked, reviewed, or referenced should be visible (and ideally make the user mildly uncomfortable). The system should make non-engagement legible.

### B. Privacy, data ownership, and AI

For *personal cognition data* — including questions you didn't realize you didn't know the answer to — the privacy stakes are higher than ordinary notes. Sellen & Whittaker (2010) raise this directly for lifelogging. Concrete implications:
- **Local-first by default** (Kleppmann et al. 2019, "Local-first software," *Onward!*).
- **Embeddings and retrieval should be local** where feasible; sentence-transformers and similar run on commodity hardware.
- **LLM features should be opt-in and ideally support local models.** Cloud inference for personal cognition is a privacy regression. Where cloud is necessary, no-training and zero-retention contracts.
- **Plain-text storage** so the user can leave.

### C. The local-vs-cloud LLM tension

The user's question (12) anticipates this. The current evidence: locally-runnable models (8B–70B parameter range) can usefully do summarization, embedding, question-generation, and contradiction-flagging at quality acceptable for surfacing-not-deciding. The *deciding* happens with the user. Where cloud is used, scope it to the inferential layer (v3) and never to capture or storage.

### D. The capture-vs-structure tension is genuine and unresolved in the literature

- Marshall & Shipman: users defer formalization, even at the cost of later findability.
- Halasz (1988): tailorability vs. structure is the persistent tension.
- The pragmatic resolution that has shipped: **typed primitives at capture (cheap), formal structure progressive (during review)**. The Roam/Logseq journal-first pattern is one operationalization; Heptabase's whiteboard layer is another.

### E. Long-term cost of accumulated notes

Bergman & Whittaker (2016), *The Science of Managing Our Digital Stuff*, MIT Press — keepers accumulate, prune rarely, and re-find rarely. Lansdale's curve of decreasing re-engagement with age. Implication: build *deletion* and *archive* as first-class flows, not afterthoughts. Fading visibility for stale unreferenced notes is more humane than hard delete.

### F. Audience effects on writing quality

The audience-effect literature (Park 1982; Holliway & McCutchen 2004; Magnifico 2010) is mostly developmental and pedagogical. The cleanest finding: **observing readers' responses to similar writing improves one's own subsequent writing** (Holliway & McCutchen 2004, *Reading and Writing*). Matuschak's "work with the garage door up" pattern is a deliberate exploit. The cost: audience-awareness can also produce blockage and self-censorship (Matuschak's own note explicitly warns of this).

### G. What deeply differentiates this from journaling

Pennebaker's expressive-writing literature (Pennebaker 1997 onward; Frattaroli 2006 meta-analysis, *Psychological Bulletin* 132 — d ≈ 0.15 for expressive writing on health/wellbeing) addresses *emotional processing*, not *technical understanding*. The trajectory use case here is **third-person about ideas**, not first-person about feelings. Both are diary-like; the differentiator is the *typed-thought* primitive plus *belief versioning*. Plain journaling does not preserve "I asked this question on date X; here's what I believed then; here's how that belief evolved." That structural commitment is what enables the trajectory feature class.

### H. What the literature is silent on (research gaps you should be aware of)

- **Direct studies of "question-asking trajectory as gap signal"** — extrapolated from PREG, not validated.
- **"Belief revision history UIs" for personal cognition** — no peer-reviewed studies I located.
- **Long-term efficacy of integrated SR + note systems** (Quantum Country, RemNote) over years rather than months — practitioner reports only.
- **Comparative HCI studies of Roam/Obsidian/Logseq/Tana/Heptabase** — almost entirely blog-based. This is an open research opportunity.
- **The "tension between effortless capture and meaningful structure"** has practitioner consensus but limited controlled study.
- **Whether OLM-style metacognition surfaces actually drive behavior change in *adult, sophisticated, self-directed* learners (n=1, you).** The OLM literature is overwhelmingly about students in courses. A sophisticated math-trained user is a population of size ~1 in this evidence base.

### I. The "feeling smart" failure mode

A subtle risk: visible OLMs and graph views *feel* like sophisticated thinking. They are not. The Bjork desirable-difficulties argument applies: *visualizing* connections is fluent; *generating* them is constructive. Make sure users do the construction; the visualization should be a consequence, not a substitute.

---

## Final synthesis

**First-class citizen:** The **typed thought**, anchored to a source, embedded in a session, capable of belief revision, and connectable to other thoughts via typed links. A *note* is a container of one or more thoughts. This is closer to an IBIS/Toulmin micro-argument than to an Evernote note.

**Type system for thoughts:** Six types — `question`, `claim`, `observation`, `explanation`, `tension`, `connection`. Capture defaults to `observation`; type promotion is one keystroke. Each carries lightweight metadata: status (open/parked/resolved/superseded), confidence (for claims), depth tier 1–4 (for questions, per Graesser collapsed scheme). Six is well within the "abandonment ceiling" reported for argumentation systems.

**Type system for connections:** Eight typed link kinds — `responds-to`, `contradicts`, `generalizes`, `is-instance-of`, `prerequisite-of`, `analogous-to`, `resolves`, `supersedes`. Untyped `[[link]]` allowed as default. This is the smallest set that supports the trajectory + IOED + analogy + prerequisite use cases in §1, §10.

**Information architecture:** A graph of typed thoughts and typed connections, with **time as first-class** (every thought has session and timestamp; every claim has a revision history) and **source as first-class** (every thought may anchor to a source span). Default surfaces: timeline, open-questions inbox, tension inbox, topic/OLM map, today's review queue. Three search modalities: full-text (precise), embedding (associative), faceted (when faceted metadata accumulates).

**UI/UX direction:** **Local-first, multimodal, capture-fast, structure-progressive.** Mobile capture should default to a single-textarea-plus-attachment quick-create, sub-3-second. Desktop offers the same plus the structured surfaces. Ink for math/diagrams is essential (representational adequacy, not learning-effect, justification given the failed Mueller-Oppenheimer replications). Spatial canvases optional for triage. Outline mode for hierarchical material. The default review flow combines spaced retrieval + IOED-style "explain this in one sentence" prompts + question-trajectory review.

**Shipping order** (already detailed in §11). The key strategic claim: **the typed-thought primitive must ship in v0**, even though only v1+ users will perceive its value. Without it, the trajectory thesis cannot be tested; with it, every higher feature becomes possible without re-architecture.

**Where you are operating on intuition rather than evidence (be honest about this):**
- That a single user (n=1) will sustain engagement with a metacognitive tool over years (the OLM literature is on captive student populations).
- That the question-trajectory signal will reliably surface unrecognized gaps at *this* user's expertise level.
- That belief-revision history UIs will be usable rather than bureaucratic. 
- That sophisticated technical learners will tolerate the lightweight-but-non-zero overhead of typing thoughts. (Matuschak himself reports this is hard, even for him.)

These are reasonable bets to make, but they are bets, not findings. Treating them as research questions to instrument and validate against your own use is more honest — and more aligned with the trajectory/metacognition ethos — than shipping them as confirmed insights.