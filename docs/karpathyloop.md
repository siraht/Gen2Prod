Yes—this is the right conceptual jump. The new layer is not another “better refactoring prompt.” It is a **self-improving transformation-policy laboratory** built around the compiler architecture already described in Gen2Prod.

Your plan already contains most of the production substrate: uncertain inputs become typed plans; deterministic transformations materialize them; validators measure the result; localized repair loops address failures; and a scheduler selects subsequent passes.  It also already defines an artifact graph, a cost/risk-aware scheduler, a division between inferred and deterministic responsibilities, and a golden fixture library.    

The missing piece is a **meta-loop that improves Gen2Prod itself**.

## Executable status (2026-07-18)

The repository now runs all three loops for the static HTML/compiled-CSS scope and adds a bounded strict image-only evidence path. Hash-bound screenshots feed deterministic segmentation, local OCR, semantic/content hypotheses, BEM HTML/SCSS emission, browser image diff, explicit interaction uncertainty, project-isolated one-change research, idempotence replay, and accepted/rejected trajectory distillation. A paired synthetic curriculum scores both dirty-to-target and candidate-to-target renders, so source cleanliness cannot hide visual regression. Canonical policy promotion is sealed behind synthetic and natural-project holdouts; requested interventions must actually execute; threshold activation is withheld until independent benchmark coverage is sufficient; and distilled data is evidence-deduplicated, group-isolated and contradiction-quarantined before runtime shadow/active use.

This implementation does not relax the modality table below. The image path emits a reviewable semantic hypothesis; it does not claim that pixels prove content intent, URLs, behavior, responsive rules, token names, asset meaning, accessibility conformance, or production readiness. The default visual-probe capture sequence records bounded hover and non-activating focus frames, and their hash-bound pixel deltas are consumed into affected-region build hypotheses. They still require behavior contracts or authorized traces for side effects and implementation semantics. Current executable evidence and remaining boundaries are maintained in [implementation-matrix.md](implementation-matrix.md) and [image-only-loop.md](image-only-loop.md).

# The three-loop architecture

## 1. Production transformation loop

This is the existing page-level loop:

```txt
messy source
→ evidence extraction
→ semantic/component/BEM/token plans
→ deterministic patches
→ validation
→ localized repair
→ production output
```

Its job is to transform one project safely.

## 2. Autoresearch loop

This operates on a benchmark suite rather than a production project:

```txt
current transformation policy
→ identify benchmark failure pattern
→ modify one policy/rule/prompt/pass
→ run frozen evaluation
→ keep or revert
→ record result
→ repeat
```

Its job is to discover better:

* pass ordering;
* modality routing;
* prompts and schemas;
* deterministic heuristics;
* uncertainty thresholds;
* model assignments;
* candidate-selection rules;
* token-snapping policies;
* repair strategies.

## 3. Distillation loop

Once the research loop has accumulated enough accepted and rejected trajectories:

```txt
experiment traces
→ supervised examples + preferences + verifier labels
→ train pass selector / classifier / planner / verifier
→ replace expensive general-model calls where justified
```

The first thing worth training is probably **not an end-to-end HTML rewriter**. It is more likely to be:

1. a semantic-role and component-boundary classifier;
2. a candidate-plan verifier or reranker;
3. a next-pass policy;
4. eventually, a structured transformation planner.

The actual source modification should remain deterministic once a structured plan has been accepted.

# The correct mathematical formulation

This is best treated as **multimodal constrained program synthesis** with active evidence acquisition.

Let the available observations be:

```txt
O = {
  site and page intent,
  source AST,
  rendered DOM,
  accessibility tree,
  computed styles,
  layout boxes,
  screenshots and crops,
  interaction traces,
  component registry,
  token registry
}
```

Let the desired latent state be:

```txt
Z = {
  semantic DOM graph,
  component graph,
  BEM graph,
  style-ownership graph,
  token-binding graph,
  interaction contracts
}
```

I would explicitly name this target state **Gen2Prod Normal Form**, or **G2P-NF**. It is the canonical project-specific representation from which final HTML and SCSS are deterministically emitted.

The inference problem becomes:

```txt
Ẑ = Inferθ(O)
output = DeterministicCompile(Ẑ)
```

But your “fastest way to get there” question adds another variable. At every step, the system chooses an action:

```txt
aₜ ∈ {
  inspect source,
  capture computed styles,
  inspect accessibility tree,
  analyze full screenshot,
  crop and inspect one section,
  call semantic planner,
  run component detector,
  run token optimizer,
  apply patch,
  run targeted validator
}
```

The policy is:

```txt
aₜ = π(known artifacts, unresolved uncertainty, failed gates, remaining budget)
```

The objective is not merely “produce the highest-quality page.” It is:

```txt
minimize expected evidence and transformation cost

subject to:
  semantic gates pass
  behavior gates pass
  accessibility gates pass
  visual constraints pass
  BEM and token gates pass
  project consistency gates pass
```

Formally, this resembles a **partially observable sequential decision problem**. Operationally, you do not need full reinforcement learning at first. A **cost-aware receding-horizon controller** or contextual pass selector is sufficient.

That is how the system can learn that, for example:

* a repeated-card structure can be resolved from the DOM without vision;
* a visually separated but structurally flattened hero needs screenshot segmentation;
* an ambiguous link/button decision requires source behavior evidence;
* canonical component naming requires cross-page context;
* a local spacing mismatch needs only computed styles, not another model call.

# Synthetic data is viable—but the target cannot be raw HTML strings

Your “perfect page → deconstruct it → reconstruct it” idea is probably the strongest route to the initial dataset.

The pipeline should be:

```txt
Typed canonical page specification
        ↓
Gold semantic DOM + component graph + BEM graph + style plan
        ↓
Deterministic gold HTML/SCSS
        ↓
Gold renders, accessibility trees, computed styles, behavior traces
        ↓
Controlled corruption programs
        ↓
Messy source + exact corruption trace + node lineage
```

A fixture would therefore contain:

```txt
fixture.intent.json
fixture.components.json
fixture.gold.semantic.json
fixture.gold.bem.json
fixture.gold.tokens.json
fixture.gold.html
fixture.gold.scss
fixture.corrupted.html
fixture.corrupted.css
fixture.corruption-trace.json
fixture.node-correspondence.json
fixture.expected-gates.json
```

## Corruption grammar

The corruptor should support composable, provenance-preserving operations such as:

**Semantic erasure**

```txt
main/header/nav/section/article/list/button
→ div/span/a with missing or incorrect semantics
```

**Structural noise**

```txt
insert wrappers
flatten meaningful groups
split one component across wrappers
merge unrelated groups
duplicate subtrees
reorder nonessential wrappers
```

**Class degradation**

```txt
BEM classes → utilities
BEM classes → random names
remove classes
introduce visual names
create inconsistent names across pages
```

**Style lowering**

```txt
token references → raw values
component SCSS → utility classes
utility classes → inline styles
shared declarations → duplicated one-offs
```

**Design drift**

```txt
var(--space-m) → 15px / 17px / 18px
var(--text-m) → 15px / 16px / 17px
one radius → several near-radii
one semantic color → several near-colors
```

**Component corruption**

```txt
one canonical component → several false component names
multiple distinct components → one over-generalized component
modifier → duplicate block
external geometry → child component ownership
```

**Behavior and accessibility corruption**

```txt
button → anchor without valid navigation
behavior hook removed
focus order damaged
accessible name removed
ARIA added incorrectly
interaction state coupled to styling class
```

Because the corruption program is known, you get exact provenance and usually exact node correspondence. That is much stronger supervision than trying to infer the meaning of arbitrary Git diffs.

## The important correction: there is rarely one uniquely correct HTML result

A synthetically generated gold page is one **canonical normal form**, not necessarily the only semantically valid implementation.

For example:

* a visual region may legally be a `div` or `section`;
* a repeated item may or may not qualify as `article`;
* `feature-card` and `benefit-card` might both be linguistically reasonable;
* different wrapper structures may be semantically and visually equivalent.

Therefore, evaluation should operate on:

* semantic roles and constraints;
* graph topology;
* component ownership;
* accessibility-tree behavior;
* stable project vocabulary;
* token roles;
* visual and interaction invariants.

It should not primarily measure exact output-string equality.

Where the project demands determinism, establish a **canonicalization policy**:

```txt
canonical block vocabulary
canonical element-role names
canonical tag preference rules
canonical wrapper-elimination rules
canonical component ownership
canonical token preference order
canonical source formatting
```

Where multiple outputs remain valid, the fixture should express an allowed set or partial constraint rather than one exact string.

# Synthetic fixtures must be mixed with naturalistic AI failures

Pure procedural corruption will teach the system to reverse the corruption operators you imagined. It may not generalize to the peculiar failures produced by Codex, Claude, page builders, Tailwind generators, or framework-specific component code.

The dataset therefore needs three sources:

1. **Procedural corruption pairs** with perfect lineage and controlled difficulty.
2. **Model-generated messy implementations** produced from the same page briefs and visual targets as the gold implementation.
3. **Accepted real conversions** from actual projects, with human-reviewed plans and validator results.

The splits must hold out more than page instances. Hold out:

* entire page archetypes;
* component families;
* corruption compositions;
* token scales;
* subject-matter domains;
* source frameworks;
* generator-model families.

Otherwise, autoresearch will discover benchmark-specific tricks rather than a general transformation policy.

Recent code self-training work supports the general direction but also warns against naïvely training on unchecked self-generated outputs. Solver–verifier self-play and rigorous synthetic-data filtering are the relevant pattern; rejected candidates can also become valuable verifier-training data. ([arXiv][1])

# Different modalities should be used at different levels

Your instinct about full-page recognition, section recognition, HTML inspection, and smaller slices is correct. The right architecture is **top-down and bottom-up reconciliation**, not one giant multimodal prompt.

| Evidence                    | Best use                                                                   | What it should not decide alone       |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| Site strategy and page plan | Page intent, section purpose, conversion role, naming vocabulary           | Actual rendered geometry              |
| Source AST                  | Content, URLs, forms, loops, conditionals, behavior hooks, source lineage  | Browser-computed appearance           |
| Rendered DOM                | Actual nodes and state-specific structure                                  | Unrendered conditional branches       |
| Accessibility tree          | Roles, names, focusability, landmark structure                             | Visual grouping                       |
| Computed styles and boxes   | Exact layout, inheritance, style vectors, clustering                       | Content meaning                       |
| Full-page screenshot        | Macro section boundaries, hierarchy, visual rhythm, prominent regions      | Semantics, behavior, responsive rules |
| Section crop                | Local grouping, card boundaries, media/text relationships, visual variants | Site-wide component identity          |
| Cross-page component graph  | Canonical names, reuse, variant detection                                  | Exact local pixel values              |

The existing plan’s source-authority matrix already makes the crucial distinction that screenshots provide visual evidence while source, accessibility, content, and registry artifacts govern other concerns. 

A practical recognition sequence is:

```txt
1. Establish global page/site intent.
2. Generate macro region candidates from DOM boxes and the full screenshot.
3. Reconcile regions with heading/content structure.
4. Detect repeated subtrees and visual component candidates.
5. Crop only uncertain regions for closer visual interpretation.
6. Infer semantic roles inside accepted component boundaries.
7. Reconcile component candidates across pages.
8. Generate BEM and style-ownership graphs.
9. Resolve declarations into tokens.
```

The slices should therefore be **confidence-adaptive**. Do not send every element through vision. Escalate from deterministic evidence to local multimodal analysis only when uncertainty is material.

# Yes, BEM can be resolved before token values

This is one of the most important separations in the design.

**BEM answers:**

```txt
What conceptual unit owns this node?
What role does the node play inside that unit?
Is this a block, element, modifier, or mix?
Who owns internal styling?
Who owns external geometry?
```

**Tokens answer:**

```txt
Which governed design decision supplies each value?
```

Those are related but separable.

You can first produce:

```txt
hero
hero__inner
hero__content
hero__title
hero__lede
hero__actions
hero__media
```

and a style-intent plan such as:

```txt
hero.title.typography → typography.page-title
hero.content.gap → spacing.content-stack
hero.inner.max-width → sizing.page-content
hero.media.radius → radius.prominent-surface
```

Only later does the binding layer resolve:

```txt
typography.page-title → var(--h1)
spacing.content-stack → var(--space-m)
sizing.page-content → var(--content-width)
radius.prominent-surface → var(--radius-xl)
```

This means the intermediate representation should contain **semantic token slots**, not invented CSS custom properties.

Bad unresolved output:

```scss
font-size: var(--some-heading-size-we-invented);
```

Better intermediate plan:

```json
{
  "property": "font-size",
  "tokenRole": "typography.page-title",
  "bindingStatus": "unresolved"
}
```

The Automatic.css adapter then does one of four things:

1. binds the role to an existing ACSS variable;
2. binds it to an approved project alias;
3. records a temporary exception;
4. raises a design-system gap proposal.

The final emitted SCSS must not contain an unresolved binding.

One nuance: BEM does not require the numeric design system, but canonical BEM naming does require a **project component ontology**. Without a cross-page component inventory, the system may independently invent `feature-card`, `benefit-card`, and `value-card` for the same pattern.

Your current ordering rules already correctly place semantic/component ownership before tokenization and SCSS generation. 

# CSS consolidation is a constrained compression problem

The inconsistent-value issue can be formalized cleanly.

For each governed declaration (i), observe its value (v_i(c)) over conditions (c), where conditions include viewport, theme, and state. Assign it to an existing token, a proposed new token, or an exception.

A useful objective is:

```txt
minimize:

Σᵢ,c wᵢ,c · distance(vᵢ(c), tokenᵢ(c))
+ λnew · number_of_new_tokens
+ λexception · number_of_exceptions
+ λdrift · slot_entropy
+ λchurn · visual_change
```

Subject to:

```txt
property/token compatibility
semantic-role compatibility
contrast constraints
critical-region visual thresholds
behavior preservation
mode-specific change permissions
```

This is effectively a combination of **quantization**, **minimum-description-length optimization**, and constrained clustering.

It gives the desired behavior:

* repeated near-identical values in the same semantic role collapse to one token;
* visually similar values used for different semantic roles may remain separate;
* an unmatched value repeated across many relevant slots becomes a token-gap candidate;
* an isolated strange value remains an exception;
* existing ACSS tokens are preferred because they have no token-creation cost;
* a new token is created only when it materially reduces distortion or exception burden.

## Detecting a genuine design-system gap

A missing token should be surfaced when all of these are true:

```txt
no existing token maps within the allowed error
the value recurs with meaningful support
the occurrences share a stable semantic role
the value cannot be explained by a component variant or state
creating the token reduces exceptions or drift
the token remains useful across more than one isolated location
```

Frequency alone is insufficient. An AI generator can repeat the same accidental value many times.

## Refactor versus normalization

There is an important mode boundary here.

Changing `15px` to `14px` or `16px` is a visual design change, even when it improves consistency. In a strict legacy-refactor profile, the system should:

* find an exact token or alias;
* register an exact project token when warranted;
* or preserve it as an exception.

Actual snapping and consolidation belong in optimization, migration, or intentional redesign modes, under corresponding visual thresholds. Your plan already distinguishes these change authorities. 

# The Karpathy-style research harness

Karpathy’s autoresearch pattern works because it radically constrains the experiment: one editable file, fixed evaluation budget, and a single mechanically reported outcome. ([GitHub][2])

The Gen2Prod analogue should look approximately like:

```txt
prepare.ts
  Frozen fixture generation, corruption programs, splits, and manifests.

evaluate.ts
  Frozen validators, metric computation, resource accounting, and reports.

passes/
  Versioned primitive transformations and evidence-acquisition actions.

policy.ts
  The only editable artifact during policy-research runs.

program.md
  Research-agent instructions and boundaries.

results.tsv
  Experiment, hypothesis, patch hash, metrics, cost, keep/revert outcome.
```

`policy.ts` would control things such as:

```txt
which pass runs next
which model handles a particular inference
when to request a screenshot crop
how many candidates to sample
which candidate verifier to use
confidence thresholds
repair escalation thresholds
prompt versions
pass precedence
token-selection priors
```

A research iteration would be:

```txt
1. Read incumbent policy, failures, and experiment history.
2. Form one falsifiable hypothesis.
3. Modify one bounded aspect of policy.ts.
4. Run the same benchmark slice under the same resource budget.
5. Reject immediately on any new hard-gate failure.
6. Compare the remaining multi-objective fitness.
7. Keep or revert.
8. Log the complete result.
9. Periodically evaluate a hidden holdout suite.
```

The research agent must never modify the transformation policy and its evaluator in the same experiment. Otherwise, it can improve its score by weakening the test.

Separate research tracks should be used:

```txt
Policy track:
  edits policy.ts only

Pass track:
  edits exactly one pass implementation
  policy and evaluator frozen

Verifier track:
  edits one verifier
  evaluated against frozen positive and negative controls
```

# Do not reduce the objective to one naïve number

The fitness should initially be a **lexicographic vector** or Pareto comparison:

```txt
fitness = (
  critical_gate_failures ↓,
  content_and_behavior_errors ↓,
  semantic_contract_error ↓,
  accessibility_error ↓,
  visual_loss ↓,
  unaccounted_governed_declarations ↓,
  BEM_and_component_graph_error ↓,
  cross_page_drift ↓,
  idempotence_error ↓,
  review_burden ↓,
  normalized_compute_cost ↓
)
```

This prevents an experiment from “winning” because it raised token coverage while breaking navigation or deleting ambiguous elements.

For model training that requires a scalar reward, normalize each dimension and apply the weighted reward only after hard feasibility constraints pass. The scalar reward should not be the canonical acceptance rule.

Also include **mutation testing for the evaluator**:

```txt
Take known-good output
→ inject one controlled defect
→ verify the correct gate fails
```

Examples:

* remove `href`;
* replace button with noninteractive `div`;
* insert raw governed color;
* create orphan selector;
* change heading hierarchy;
* remove focus-visible style;
* duplicate a component under a false name;
* silently delete a behavior hook.

Before allowing autoresearch to optimize Gen2Prod, you need evidence that the evaluator catches attempts to game it.

# The first useful benchmark

The first research suite should be narrower than the full site generator:

```txt
static HTML
compiled CSS or Tailwind output
fixed project/ACSS registry
single-page or section fixtures
no complex framework state
known content and page intent
known gold component/BEM/token graphs
360px, 768px, and 1280/1440px render conditions
```

Use a compact set of archetypes already implied by the fixture plan:

```txt
hero + CTA
feature grid
pricing cards
FAQ/disclosure
testimonial
navigation
form
```

Then run a controlled modality ablation:

```txt
A. Source AST only
B. Source AST + rendered DOM + computed styles
C. B + page/content plan
D. C + full-page screenshot
E. D + uncertainty-triggered section crops
F. E + cross-page component inventory
```

For each configuration, record:

```txt
semantic accuracy
component-boundary accuracy
BEM graph accuracy
token assignment accuracy
visual/behavioral preservation
review burden
LLM tokens
vision calls
browser captures
wall-clock cost
```

That experiment directly answers the central question you raised: **which kind of intelligence is valuable at which stage, and what is the least expensive evidence sequence that reaches the required state?**

# Recommended learning order

The strongest development sequence is:

## Stage 1 — Optimize the skill and policy

Use frontier models as interchangeable planners. Optimize schemas, prompts, pass order, evidence routing, deterministic rules, and candidate selection.

## Stage 2 — Train the verifier and pass selector

Use accepted and rejected candidate plans, validator vectors, costs, and localized failure reasons.

These models are easier to evaluate mechanically and can immediately reduce expensive generation calls.

## Stage 3 — Distill the structured planner

Train on:

```txt
observation bundle
→ semantic/component/BEM/token plan
```

Do not train it directly to emit final HTML and SCSS.

## Stage 4 — Specialize perception only where the benchmark proves a bottleneck

A small section-boundary or component-region model may eventually make sense. Training a custom screenshot-to-code or end-to-end vision model should come much later.

# The central conclusion

The mathematical object is not really:

```txt
messy HTML → clean HTML
```

It is:

```txt
multimodal observations
→ recover latent semantic and design-system structure
→ canonicalize that structure
→ deterministically serialize it
```

Each part is a different kind of problem:

```txt
semantic HTML       = structured role inference
componentization    = repeated-subgraph discovery and compression
BEM                 = canonical ownership and naming
tokenization        = role-conditioned value quantization
SCSS generation     = deterministic serialization
repair              = localized constrained program repair
autoresearch        = transformation-policy optimization
```

So yes: the system can generate synthetic data, evaluate its own techniques, discover better pass sequences, and eventually train smaller or more specialized models from its accumulated traces. But the compounding asset is not initially a recursively self-editing model. It is the combination of a **canonical target IR, corruption factory, mechanically trustworthy evaluator, experiment log, and cost-aware transformation policy**.

The next plan revision should add an explicit **Autoresearch and Synthetic Curriculum Layer** above the existing artifact graph, with `canonical-normal-form`, `corruption-trace`, `experiment-result`, and `trajectory` artifacts, plus separate policy-, pass-, and verifier-optimization tracks.

[1]: https://arxiv.org/abs/2502.14948?utm_source=chatgpt.com "Learning to Solve and Verify: A Self-Play Framework for Code and Test Generation"
[2]: https://github.com/karpathy/autoresearch "GitHub - karpathy/autoresearch: AI agents running research on single-GPU nanochat training automatically · GitHub"
