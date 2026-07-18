# Implementation matrix

This matrix turns the two design documents into independently testable build slices.

| Layer | Status | Runtime artifacts | Acceptance evidence |
| --- | --- | --- | --- |
| Artifact graph | Running | manifest, hashes, lineage, authorities, 24 typed passes, replay events | schema/content-addressing and CLI doctor tests |
| G2P-NF | Running | strategy/content/component/DOM/style/BEM/token/interaction/visual-target IRs | Zod + exported JSON Schemas and canonical fixtures |
| Evidence | Running | source tree, rendered DOM, accessibility tree, styles, boxes, screenshots/crops, interactions | Chrome-backed capture/accessibility tests |
| Compiler | Running | ingest, detect, infer, map, rewrite, emit, capture, repair plan | browser-backed legacy and greenfield runs pass |
| Scheduler | Running | precedence, hard constraints, LCB-style utility, value of information | deterministic scheduling tests and policy experiment accounting |
| Gates A–J | Running | build/BEM/token/inline/a11y/SEO/perf/security/consistency/visual target | 11 static plus one rendered-image mutation control fire; real runs recheck controls |
| Correspondence and metrics | Running | ID-independent node/region matching, dirty/gold/candidate PNG diffs, delta vector, Pareto/lexicographic fitness, idempotence, slot entropy | marked and unmarked paths have zero semantic/BEM/hard/idempotence error; six fixtures are pixel-identical and the authority-limited form differs by 0.074% |
| Synthetic curriculum | Running | content families, strategies, page briefs, approved content, browser mockups, gold outputs, marked/unmarked corruptions, naturalistic and observed-pair imports, lineage, split and generator-family provenance | seven archetypes, held-out form family, exact screenshot fitness, non-1:1 import test |
| Autoresearch | Running | frozen preparation/evaluation/corpus fingerprint, A–F evidence ablation, three tracks, keep/revert, TSV/trajectory log | live accepted/rejected experiments with hidden holdout; production trajectories feed back |
| Distillation | Running | SFT/preference/verifier data; selector/verifier/planner models | reload tests; verifier 1.0 P/R on deterministic holdout |
| Product reports | Running | advisor, delta explorer, drift, equivalence, exceptions, replay, CI summary | emitted on every production run |

The first implementation supports static HTML plus compiled CSS, then uses the same IR and gate contracts for greenfield generation. Browser evidence uses installed Chrome when Playwright-managed Chromium is unavailable. Model-assisted interfaces have a deterministic local implementation, so the full loop runs without a model key; external model providers are optional evidence sources rather than runtime prerequisites.
