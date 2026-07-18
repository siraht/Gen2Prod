# Implementation and conformance audit

This is the executable-scope audit for [the Gen2Prod plan](Gen2Prod_plan_v2_3_4_revised.md) and [the Karpathy-loop plan](karpathyloop.md). `Running` means the capability executes locally and is covered by tests or frozen evaluation evidence. `Bounded` means the contract is implemented for the current static-HTML/compiled-CSS runtime but a broader adapter, learned model, platform matrix, or external integration remains. `External` identifies work that cannot be completed truthfully without project authority or outside infrastructure.

## Executable layers

| Layer | Status | What runs now | Evidence and boundary |
| --- | --- | --- | --- |
| Artifact graph and G2P-NF | Running | Content-addressed manifest, lineage, authorities, replay events, 24 typed passes, strategy/content/component/DOM/style/BEM/token/interaction/visual-target IRs, exported schemas | Schema, hashing, replay, and CLI-doctor tests |
| Evidence capture | Running, bounded | Source tree, materialized rendered DOM, accessibility tree, computed styles, boxes, screenshots/crops, interactions, font hashes, decoded-image waits, fixed clock/randomness, animation/caret/transition suppression | Chrome-backed tests; current runner is local Chromium/Linux, not a cross-browser/OS lab |
| Legacy compiler | Running, bounded | Ingest, cascade resolution, semantic inference, component/BEM planning, token binding, markup/SCSS emission, targeted repair, exact second-pass idempotence | Static HTML plus embedded/external compiled CSS is production scope; JSX/Vue/Svelte/Astro, CMS-builder, shadow-DOM, and source Tailwind-config patch adapters are not implemented |
| Greenfield generation | Running, bounded | Strategy, page brief, content model, section/component inventory, token registry, semantic wireframe, BEM graph, browser-rendered mockup, production HTML/SCSS and validation | Deterministic archetype/content-family generator proves the full contract; it is not an open-ended frontier-model design agent |
| Source and visual authority | Running | Exact, reviewed partial, and non-1:1 policies; source content/URL/form recall; dirty/clean/candidate screenshots; project-isolated splits | Pixels never invent content, links, semantics, legal text, or behavior |
| Correspondence and image metrics | Running | ID-independent leaf-first node matching, stable anonymous-surface matching, box/style/text signals, pixel diff, diff PNGs, layout/computed-style deltas, dirty-to-candidate and dirty/candidate-to-gold scoring | Reviewed `px`/`fraction` masks make partial pairs region-scoped fitness; named-only regions remain annotations |
| Gates A–J | Running, bounded | Build, BEM, token accounting, inline code, accessibility, SEO/content, performance, security/privacy, cross-page consistency, and visual-target gates | 12 static evaluator mutations plus a rendered-image mutation must fire; manual assistive-tech, privacy, and production security sign-off remain external |
| Synthetic curriculum | Running | Three content families, seven structural archetypes, responsive gold conditions, strategies, briefs, approved content, mockups, gold/dirty marked and unmarked HTML, 11 composable corruptions, lineage, generator-family and split provenance | Procedural, imported model-generator, and accepted naturalistic sources are supported; continued diversity is an ongoing benchmark responsibility |
| Naturalistic corpus | Running | Six project identities assembled from `userdata`, five live-site captures, exact/partial/non-1:1 observed evidence, project-isolated train/validation/holdout partitions | Live deployed pages are advisory unless declared as approved one-to-one targets |
| Autoresearch | Running, bounded | Frozen preparation/fingerprint/evaluator, policy/pass/verifier tracks, A–F modality configurations, cost and latency accounting, lower-confidence-bound utility, lexicographic/Pareto keep-revert, TSV and JSONL trajectories | The current deterministic compiler consumes AST/CSS evidence directly; modality ablations are policy/resource experiments, not a learned multimodal router |
| Distillation | Running, bounded | Supervised, preference, and verifier datasets; reloadable selector/verifier/planner artifacts; natural production trajectories mixed with research trials | These are deterministic table/rule baselines, not trained neural checkpoints; provider/model selection, credentials, budget, and licensing are external choices |
| Mockup convergence | Running, bounded | Approved-image target, region metrics, stop criteria, gate-preserving discrete policy/style experiments | The loop ranks and accepts discrete patches; arbitrary asset synthesis and unrestricted layout generation are intentionally outside the deterministic compiler |
| Product reports | Running, bounded | Pipeline advisor, design delta explorer, token drift, component equivalence, exception ledger, pass replay, CI summary | Reports are emitted locally; posting review comments or status checks to a hosting provider is an unimplemented integration |

## Karpathy-loop coverage

| Requirement | Status | Implementation |
| --- | --- | --- |
| Production transformation loop | Running | Compile → browser capture → gates/image diff → repair/accept → trajectory export, with exact idempotence |
| Frozen autoresearch loop | Running | Immutable corpus/evaluator hashes, hidden project holdout, independent policy/pass/verifier mutations, keep/revert, no evaluator weakening |
| Distillation loop | Running, bounded | Accepted and rejected natural/synthetic trajectories become selector, verifier, and planner datasets/models; learned-model training remains optional external work |
| Corruption grammar | Running | Semantic erasure, structural noise, class degradation, stylesheet and inline-style lowering, design drift, component, behavior, accessibility, responsive, and focus-order damage |
| Naturalistic failure mixing | Running | Real generated HTML, screenshots, strategies and imperfect/evolved pairs are imported alongside procedural fixtures without treating redesigns as pixel failures |
| Non-unique-output evaluation | Running | Semantic/BEM/token contracts and hard gates dominate; visual loss, review burden, cost, and latency remain separate normalized/lexicographic dimensions |
| Modal evidence routing | Running, bounded | A–F evidence/cost configurations and uncertainty-triggered crop accounting execute; learned perception or dynamic model routing awaits a benchmark-proven bottleneck |
| Mutation-controlled verifier | Running | 12 static faults and one rendered visual fault are injected after compilation and must be detected on every frozen evaluation |

## Gen2Prod-plan coverage

The artifact graph, IRs, DTCG adapter, ACSS extraction, compiled Tailwind selector handling (including escaped arbitrary and leading-negative utilities), semantic inference, BEM/mix/specificity policy, responsive/state emission, node correspondence, normalized optimization math, Gates A–J, repair loop, replay, golden fixtures, and local developer reports are running in current scope. The compiler preserves source-authoritative copy, URLs, forms and safe resource links while quarantining executable behavior it cannot prove.

The following plan items remain deliberately bounded rather than silently claimed complete:

- Framework-native source rewriting for JSX/TSX, Vue, Svelte, Astro, WordPress/Bricks and other builders. Current output is canonical static HTML/SCSS/CSS.
- A maintained Chrome/Firefox/WebKit and Windows/macOS/Linux capture matrix, authenticated network fixtures, and production release-browser variance budgets.
- Real-user Core Web Vitals/RUM, production traffic segmentation, and third-party script ownership data.
- Full screen-reader/manual WCAG review, approved alternative-text quality, cognitive/error-recovery review, and complex-widget sign-off.
- Real form endpoints, privacy/retention/processors, CSP nonce/hash policy, CMS sanitization and dynamic enum authority.
- Hosted CI review-bot integration and dashboard UI; the repository emits machine-readable summaries but does not post externally.
- Neural model training or external frontier-model benchmarking. The local loop is keyless and deterministic; choosing a provider, data terms, prompt version and spend ceiling is a user-owned experiment.

These are not blockers for the local self-improving static compiler. They are explicit next adapters or authority-dependent production integrations, recorded in `requiredActions` while unrelated evaluation and research continue.

## Current frozen evidence

- Naturalistic corpus: 6 projects, 96 artifacts, 48 HTML files, 28 screenshots and 17 strategy documents, split by project identity into train/validation/holdout.
- Expanded procedural curriculum: 21 fixtures across three content families, with 12 train, 6 validation and 3 holdout cases and all 11 corruption operators represented.
- Hidden natural holdout after the correspondence/style fixes: 5/5 accepted, zero hard failures, 100% content/URL/form recall, 100% idempotence, 0.21% mean dirty-to-candidate pixel loss, and 2/2 exact-image non-regressions.
- Natural validation after the one-off-style isolation fix: 4/4 accepted, zero hard failures, 100% content/URL/form recall, 100% idempotence and 0.06% mean dirty-to-candidate pixel loss.
- Policy, pass and verifier autoresearch tracks all executed against frozen evaluation; non-improving hypotheses were reverted rather than weakening acceptance.
- Distillation emits reloadable datasets and model artifacts, including naturalistic trajectories; deterministic verifier holdout precision and recall are both 1.0 on the frozen baseline.

Thresholds remain provisional until the corpus spans more generator families, frameworks, browsers and independently reviewed production projects. That warning is a calibration requirement, not a reason to discard the current measurements.
