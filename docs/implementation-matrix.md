# Implementation matrix

This matrix turns the two design documents into independently testable build slices.

| Layer | Runtime artifacts | Acceptance evidence |
| --- | --- | --- |
| Artifact graph | manifest, hashes, lineage, authorities, pass/replay events | schema and content-addressing tests |
| G2P-NF | strategy/content/component/DOM/style/BEM/token/interaction/visual-target IRs | schema fixtures and canonical serialization |
| Evidence | source AST, rendered DOM, accessibility tree, styles, boxes, screenshots/crops, interactions | deterministic capture fixture |
| Compiler | ingest, detect, infer, map, rewrite, emit, capture, repair | single-page end-to-end conversion |
| Scheduler | precedence, hard constraints, expected utility, value of information | deterministic selection scenarios |
| Gates A–J | build/BEM/token/inline/a11y/SEO/perf/security/consistency/visual target | positive and mutation controls |
| Correspondence and metrics | node/region matching, delta vector, Pareto/lexicographic fitness, idempotence | graph and metric tests |
| Synthetic curriculum | typed page specs, gold outputs, corruptions, lineage, splits | seven archetypes and held-out compositions |
| Autoresearch | frozen preparation/evaluation, policy/pass/verifier tracks, keep/revert, TSV/trajectory log | accepted and rejected experiments |
| Distillation | supervised/preference/verifier export; selector, verifier, planner models | train/evaluate/reload smoke test |
| Product reports | advisor, delta explorer, drift, equivalence, exceptions, replay, CI summary | generated JSON and Markdown reports |

The first implementation supports static HTML plus compiled CSS, then uses the same IR and gate contracts for greenfield generation. Browser evidence uses installed Chrome when Playwright-managed Chromium is unavailable. Model-assisted interfaces have a deterministic local implementation, so the full loop runs without a model key; external model providers are optional evidence sources rather than runtime prerequisites.
