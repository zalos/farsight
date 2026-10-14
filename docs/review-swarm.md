# Review Swarm — 8 reviewer personas

Eight reviewer agents live in `.claude/agents/`. They are **generic enterprise personas** — people from teams that live in Confluence, Jira, PowerPoint, and ServiceNow — with no baked-in product knowledge. They review only the materials you hand them, which keeps them honest as a proxy for real adopters encountering Farsight (or anything else) cold.

## The roster

| Role | Persona | Agent | Temperament | Pulls the review toward |
|---|---|---|---|---|
| Leadership | Diane Okafor, VP Engineering | `review-exec-skeptic` | Blunt, ROI-driven, time-poor | Decision value, boardroom-safety, cost of ownership |
| Leadership | Marcus Webb, Dir. Transformation | `review-transformation-champion` | Enthusiastic, story-driven | Adoption, rollout, day-2 operations, demo-ability |
| Business | Priya Raman, Senior BA | `review-business-analyst` | Literal, precise, relentless | Semantic precision, traceability, exports, terminology |
| Business | Tom Gallagher, Product Owner | `review-ops-product-owner` | Candid, non-technical | Plain language, self-service, jargon toll gates |
| Developer | Sofia Marchetti, Staff Engineer | `review-staff-engineer` | Terse, skeptical | Accuracy, staleness, beat-grep-or-die, escape hatches |
| Developer | Devon Park, early-career dev | `review-onboarding-dev` | Curious, honest about confusion | Learnability, orientation, blast radius, metaphors that teach |
| QA | Anna Kowalski, SDET lead | `review-sdet-systematic` | Checklist-driven, boundary-probing | Impact analysis, coverage mapping, determinism, APIs |
| QA | Rafael Ortiz, Exploratory QA lead | `review-qa-explorer` | Observant, narrative | Consistency, accessibility, honest states, cognitive load |

Each pair is deliberately opposed (skeptic/champion, precisionist/plain-speaker, veteran/newcomer, checklist/exploration) so the swarm covers a dimension from both ends rather than agreeing eight times.

## Running the swarm

Every persona expects the same input: paths to the materials under review — screenshots/PNGs, mockups, HTML prototypes, feature lists, proposal docs. They read images with the Read tool, so screenshot paths work directly.

From a Claude session in this repo, launch all eight in parallel (single message, multiple Task/Agent calls), each with the same brief, e.g.:

> Review the following materials for the product they depict. Screenshots: docs/screenshots/*.png (take your own). Feature description: docs/proposals/design-concepts-2026-07.md. Return your review in your standard format.

Tips:

- **Same materials to everyone.** The value is eight readings of one artifact, not eight artifacts.
- **Don't pre-explain the product.** These personas simulate cold first contact; briefing them defeats the purpose. If you want a "after the sales pitch" round, run it as a second pass and compare.
- **Scope per run.** A focused packet (one view or one concept + 3–6 screenshots) produces sharper reviews than the whole product at once.

## Synthesizing

All eight return the same skeleton — Verdict, Fit score, sections, then `[BLOCKER]/[MAJOR]/[MINOR]` findings, Questions, Top 3 asks — so synthesis is mechanical. After the swarm returns, have the main session (or a ninth agent) produce:

1. **Verdict board** — the eight verdicts + fit scores in one table; the spread matters more than the average.
2. **Convergent findings** — anything flagged by 3+ personas across different roles. These are real; fix them first.
3. **Tension log** — where personas directly conflict (e.g. Sofia wants density, Tom wants plain language; Diane hates the HUD aesthetic, Devon loves it). Tensions are design decisions to make deliberately, not defects — this is where the synergy between differing needs actually surfaces.
4. **Single-voice gems** — high-severity findings only one persona could have caught (Rafael's accessibility items, Anna's bypass paths). Don't let vote-counting drown them.
5. **Unanswered questions** — the union of every persona's "questions I'd ask" is a ready-made FAQ/backlog.

## The outsiders — a comprehension round, not a review (2026-10-13)

The eight personas judge *Farsight*. Three further agents judge **how much of the application a stranger can
understand through Farsight** — they are shown a demo and asked to say the application back, not to score the tool.

| Outsider | Agent | Needs to leave with |
|---|---|---|
| Nadia Ferreira, new implementation consultant | `review-outsider-consultant` | roles, the record's flow with its side paths, the rules before approval, what is configurable — well enough to train a client |
| Grant Whitfield, head of operations at a prospective customer | `review-outsider-customer` | who approves, what is checked, how a vendor is proven real, the bad paths, where money moves, built vs promised |
| Eleanor Voss, non-executive director doing diligence | `review-outsider-board` | the one-paragraph story, where money moves and what it depends on, the controls, what is real, the audit-committee risks |

They share one output skeleton (*could I explain it* · understanding n/10 · confidence n/10 · the application in my
words with every claim marked `[sure]` / `[think so]` / `[guessing]` · questions asked and whether the tool answered
them · what I still cannot say · where I was misled · where the tool got in my way · three things I'd tell the team),
so the three merge the same way the eight do.

**The demo guide lives in the application's own repository**, not here: an agent that drives the read-only Farsight
server on that application, narrates each stop in plain words, answers questions, and knows **only what Farsight
shows** — it never reads the application's code or docs. Everything it cannot answer goes into a gap log: the
question, what Farsight showed instead, and what knowledge about the application Farsight would have needed (a
manifest field, a config block, a doc tag, a parser capability). The outsiders' wrong guesses and the guide's gap log
are the round's product: the first says where Farsight misleads, the second what to add from the application. Run:
the guide walks the stops and writes the pack (PNGs + narration + the seed questions through ASK); the outsiders read
the pack, say it back and ask; the lead relays the questions to the guide, who answers from new screenshots; the
outsiders write their reports; synthesize as a comprehension board, what all three got right, what all three got wrong
or could not say, and the gap log ranked by how many asked. Reports and PNGs stay outside the repo.

## Extending

To add a persona, copy any agent file and change: identity, world/tools background, personality, the "What you look for" bullets, and the header of the output format. Keep the output skeleton identical — it's the contract that makes swarm synthesis cheap.
