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

## Extending

To add a persona, copy any agent file and change: identity, world/tools background, personality, the "What you look for" bullets, and the header of the output format. Keep the output skeleton identical — it's the contract that makes swarm synthesis cheap.
