# Gen2Prod Plan v2.3.4 — Measured AI Website Generation + Refactoring Compiler

## Executive summary

Gen2Prod should not be framed as a one-shot prompt that “cleans up Tailwind.” It should be a **compiler + optimizer for AI-generated websites**.

Its job is to turn uncertain AI outputs — strategy notes, content drafts, wireframes, approved visual targets, mockups, Figma screenshots/exports, Tailwind-heavy prototypes, or existing code — into a **semantic, token-governed, BEM-structured, ACSS-powered, accessible, performant, testable production site**.

The central operating principle remains:

```txt
AI proposes meaning.
Typed plans capture proposed meaning with evidence, confidence, and source authority.
Deterministic transforms apply changes.
Validators measure scoped deltas and classify regressions.
Repair loops fix only localized failures.
The scheduler chooses the next pass from evidence, not vibes.
Reproducibility is achieved through hashes, schemas, manifests, and replay logs, not assumed LLM determinism.
```

The biggest v2 change is scope. v1 was strongest as a **legacy conversion pipeline**. v2 makes the original intent first-class:

```txt
strategy → content model → design system → mockups → semantic architecture → production code → validation → optimization
```

The system now has four explicit modes:

```txt
1. Greenfield generation
   Generate directly into the target architecture.

2. Legacy conversion
   Convert existing Tailwind/inline/div-soup pages into semantic BEM + ACSS SCSS.

3. Intentional redesign
   Allow visual change, but require explicit design intent and acceptance criteria.

4. Optimization-only
   Improve consistency, accessibility, performance, or maintainability without layout redesign.
```

Each mode uses different **delta thresholds**, **risk budgets**, and **pass-order constraints**. This avoids a common failure: treating a redesign like a visual-preservation conversion, or treating a visual-preservation conversion like a redesign. In this plan, **refactor** is a constraint profile inside legacy conversion or optimization-only mode, not a fifth operating mode.

For MVP execution, the narrowest useful wedge is **measurement-first single-page conversion**: freeze the rendered baseline, infer semantics/BEM/tokens, apply deterministic patches, validate, and repair locally. Greenfield generation and mockup convergence stay in the architecture, but they should be sequenced behind the evaluation harness and single-page conversion proof so the project does not become an unconstrained website generator before it can measure correctness.

---

## 0. Major revisions from v1

### 0.1 Add a true upstream generation architecture

v1 mostly focused on converting an already-generated page. v2 adds typed stages for **site strategy**, **content modeling**, **page blueprints**, **component inventories**, **mockup evaluation**, and **production contracts**.

Why this makes the project better:

A cleanup pipeline is useful, but the bigger opportunity is avoiding cleanup. If the system knows the sitemap, section goals, content hierarchy, component inventory, and token registry before it writes markup, it can generate directly into semantic BEM + ACSS SCSS and skip the Tailwind-to-BEM cleanup path for new builds.

### 0.2 Introduce an artifact graph instead of a linear checklist

v1 listed passes in a reasonable order. v2 models the whole process as a **directed artifact graph**:

```txt
artifact nodes: strategy, content, tokens, components, DOM, styles, screenshots, audits
pass edges: transforms that consume and produce artifacts
constraints: preconditions, postconditions, risk limits, validation gates
```

Why this makes the project better:

The “best order of operations” is not always one fixed list. It depends on which artifacts exist, which gates failed, and which pass has the best expected utility. A graph lets the system schedule work intelligently while still enforcing hard dependencies.

### 0.3 Add DTCG-compatible token governance on top of ACSS

v1 correctly made ACSS the runtime token authority. v2 adds a **DTCG-compatible token registry** as the machine-readable interchange layer:

```txt
DTCG-conformant token registry → runtime variable binding map → SCSS usage → audit reports
```

Important distinction:

```txt
DTCG token values store portable design-token data or DTCG token references.
ACSS/project CSS custom properties are runtime bindings recorded in metadata/extensions.
```

Why this makes the project better:

ACSS variables are excellent in CSS, but the compiler needs richer metadata: aliases, token types, modes, themes, provenance, deprecation state, allowed ranges, snapping thresholds, and exception status. A registry prevents token drift and makes future Figma/code synchronization possible without pretending that `var(--space-m)` is itself a portable DTCG dimension or color value.

### 0.4 Add Tailwind v4+ compatibility

v1 assumed a Tailwind config might be available. v2 treats Tailwind as **versioned input syntax**, not the source of truth. The converter must handle:

```txt
Tailwind v3 JavaScript config
Tailwind v4 CSS-first @theme configuration
compiled CSS truth
arbitrary values
arbitrary properties
arbitrary variants
dynamic utilities
container query variants
custom @source paths
conditional class selection from complete class strings
dynamic class construction that may be invisible or ungenerated
```

Why this makes the project better:

Modern Tailwind projects may not have a meaningful `tailwind.config.js`. Robust extraction must read the source templates, CSS entrypoints, generated CSS, and computed browser output.

### 0.5 Correct the optimization math

v1’s pass utility formula was conceptually useful but mathematically ambiguous. v2 uses constrained, weighted utility:

```txt
maximize: expected quality gain
subject to: visual, accessibility, build, token, and performance constraints
penalize: regression risk, churn, cost, instability, and design drift
```

Why this makes the project better:

A pass that improves token coverage but breaks accessibility should not “win” because its scalar score is high. Hard gates must be constraints; utility should rank only acceptable candidates or candidates inside an explicit repair loop. The scheduler must also treat pass order as a sequential decision problem: single-pass deltas are evidence for the next step, not proof of a globally optimal full sequence.

### 0.6 Add node matching for reliable delta measurement

v1 measured DOM/layout/style deltas, but did not fully specify how to match nodes after semantic rewrites. v2 adds a **node correspondence algorithm** using stable IDs, content fingerprints, accessibility names, asset URLs, bounding boxes, and subtree signatures.

Why this makes the project better:

Semantic rewrites change tags and classes. Without robust node matching, visual/style deltas become noisy or meaningless.

### 0.7 Add visual-test stabilization

v2 adds screenshot stabilization:

```txt
freeze animations
freeze time/randomness
normalize fonts
mock network data
mask dynamic regions
capture per browser/OS baseline
separate anti-aliasing noise from layout movement
```

Why this makes the project better:

Visual regression testing is powerful but brittle. Stabilization turns it from a noisy screenshot diff into a reliable quality gate.

### 0.8 Add accessibility beyond automated scans

v1 had accessibility gates. v2 splits them into:

```txt
static checks
computed accessibility tree checks
automated axe-style checks
keyboard flow tests
focus management tests
manual/assistive-technology review prompts for non-automatable issues
```

Why this makes the project better:

Automated scanners catch many common issues, but they cannot prove a page is usable. Gen2Prod should expose manual review tasks for things automation cannot decide.

### 0.9 Add security, privacy, and CMS safety

v1 did not emphasize security. v2 adds:

```txt
HTML sanitization
unsafe attribute detection
CSP friendliness
third-party script inventory
form privacy review
secret/key scanning
untrusted CMS content handling
```

Why this makes the project better:

AI-generated sites often include pasted scripts, unsafe embeds, invalid form handling, or brittle inline event handlers. Production readiness requires security and privacy gates.

### 0.10 Add developer-facing product features

v2 adds a more compelling product layer:

```txt
Pipeline Advisor
Token Drift Dashboard
Component Equivalence Detector
Exception Ledger
Design Delta Explorer
CI Review Bot
Pass Replay Log
Golden Fixture Library
```

Why this makes the project better:

The system becomes a useful developer product, not just a hidden refactoring script.

### 0.11 Add mockup-to-code convergence as a constrained visual-target loop

v2.2 makes image-based mockups usable as **approved visual targets** while preserving the document's core warning: screenshots can define visual intent, but they cannot prove semantics, behavior, responsive rules, or token names by themselves.

The added workflow is:

```txt
approved mockup → visual target IR → rendered candidate screenshot → semantic visual delta → constrained repair plan → re-render → repeat
```

Why this makes the project better:

This directly supports generative AI website development from image mockups. The math is useful as an objective function and scheduler signal, but the loop must remain constrained: candidate changes are discrete DOM/SCSS/token edits, not true gradient descent through CSS. The optimizer should propose small, schema-validated patches, measure whether they move the render closer to the target, and keep BEM, token, accessibility, performance, and security gates as hard constraints.

### 0.12 Clarify MVP boundaries and input authority

v2.3 makes the scope boundary more explicit:

```txt
MVP 0: prove the measurement harness on fixtures.
MVP 1: prove single-page conversion with deterministic validation.
MVP 2: add multi-page consistency.
MVP 3: add greenfield generation.
MVP 4: add mockup-to-code convergence.
MVP 5: add CI/productization.
```

Why this makes the project better:

The architecture can support strategy-to-code and mockup-to-code workflows, but the first product risk is measurement reliability. If the system cannot capture a baseline, classify nodes, snap tokens, validate BEM, and localize regressions on one page, adding greenfield generation or image convergence only multiplies uncertainty.

### 0.13 Tighten measurement semantics and statistical safeguards

v2.3.1 makes the measurement layer more explicit:

```txt
deltas are descriptive unless they are measured in paired sandbox runs
confidence scores are ordinal unless calibrated on fixtures
multiple LLM candidates from one prompt are correlated samples, not independent trials
hard gates dominate soft utility scores
MVP success requires accounted-for declarations, not just high aggregate coverage
```

Why this makes the project better:

The project depends on comparing before/after states, but not every difference is a causal improvement. A refactor can appear better because of measurement noise, fixture bias, model self-rating, or a lucky candidate. This revision keeps the math honest by separating measured facts, inferred confidence, regression risk, and decision utility.

### 0.14 Add source-authority and acceptance-accounting safeguards

v2.3.2 adds explicit authority rules for mixed inputs and stricter MVP acceptance accounting:

```txt
source artifacts declare what they are authoritative for
visual targets are authoritative for approved pixels/regions only
OCR/text extraction from images is advisory until approved by a text source or human review
classes are classified as style, behavior, framework, or unknown before removal
fixture thresholds remain provisional until the fixture suite is representative
```

Why this makes the project better:

The system has to combine code, screenshots, mockups, token registries, and AI interpretations. Without an explicit **source-authority matrix**, a visually plausible patch can silently overwrite real behavior, real content, or responsive logic. Acceptance accounting also prevents MVP demos from hiding failures behind aggregate coverage numbers.

### 0.15 Fix schema, measurement, and example-contract edge cases

v2.3.3 tightens small but important correctness details:

```txt
DTCG conformance is separated from non-normative/project adapter schemas
visual-region correspondence is separated from DOM-to-DOM node correspondence
LCB math no longer implies a valid standard error from correlated LLM samples
slot entropy defines the K=0 and K=1 cases explicitly
example BEM/SCSS no longer emits an orphan `hero__button` class
MVP fixture seeds are not treated as statistically calibrated thresholds
```

Why this makes the project better:

These are not feature additions; they remove places where a prototype could look mathematically or standards-compliant while hiding invalid evidence. The plan stays KISS: prove the harness, keep schemas explicit, and make every example obey the gates it recommends.

### 0.16 Tighten edge-case contracts after full-plan audit

v2.3.4 keeps the same architecture but closes remaining ambiguity around fixture calibration, visual-target authority, class-role safety, DTCG/runtime token boundaries, capture reproducibility, and MVP sequencing.

Why this makes the project better:

The system is only as trustworthy as its edge cases. These edits prevent a demo from passing because denominators were vague, a mockup was over-treated as semantic evidence, correlated model samples were treated as independent, or a CSS/token example violated the same gates the plan recommends.

---

# 1. Mission and output contract

## 1.1 Mission

Gen2Prod converts AI-generated web artifacts into production-ready website systems.

The target output is:

```txt
semantic HTML / framework markup
BEM-governed class architecture
SCSS authored with Sass nesting and ACSS variables
DTCG-compatible token registry
ACSS runtime variable usage
responsive and container-aware layout
accessible interaction patterns
declared behavior contracts for non-static components
SEO-ready content structure
performance-budgeted assets and CSS
cross-page-consistent components
machine-readable validation and provenance reports
```

## 1.2 Non-goals

Gen2Prod should not become:

```txt
an unconstrained page rewriter
an arbitrary visual redesign bot
a Tailwind-to-CSS text replacement script
a screenshot-only visual comparator
a token generator that invents unmanaged design values
a linter that reports problems but cannot localize repairs
```

## 1.3 Final code contract

### HTML / framework markup

```txt
semantic elements are used when meaning is known
one main landmark per page
navigation landmarks are labelled when multiple navs exist
heading order is logical and content-driven
interactive element choice matches behavior
`<a>` elements navigate and have `href`
`<button>` elements perform actions and have an explicit `type`
images have intentional alt strategy
no inline visual style attributes except approved dynamic exceptions
no Tailwind utility classes in final production markup
no one-off visual classes
IDs are used for anchors/accessibility, not styling
generated IDs are deterministic, stable across reruns, and collision-checked per page
behavior hooks use data-* attributes or framework-native bindings, not styling classes
```

### Class architecture

Allowed class categories:

```txt
BEM blocks:
  .hero
  .feature-card
  .site-header

BEM elements:
  .hero__inner
  .feature-card__title

BEM modifiers:
  .hero--split
  .button--primary
  .feature-card--featured

BEM mixes:
  class="feature-grid__item feature-card" on the same node as separate class tokens

Approved composition/layout blocks:
  .layout-stack
  .layout-cluster
  .layout-grid
  only if project policy allows reusable layout primitives

Behavior/state is represented by attributes where possible:
  [data-state="open"]
  [aria-expanded="true"]
  [hidden]
```

The strictest configuration may disable composition/layout blocks and require everything to be expressed as BEM blocks/elements/modifiers. The practical configuration should allow a small, governed set of reusable **composition primitives** because they reduce duplication and make layouts more predictable.

A BEM mix is allowed in markup as multiple class tokens on one node. It should not become a combined CSS selector unless a documented state/theme relationship requires that extra specificity.

### SCSS

```txt
one partial per component, section, or layout primitive
Sass & nesting is allowed and preferred for BEM suffixing
no raw hex/rgb/oklch colors unless registered as token definitions
no raw governed design values for spacing, radius, shadow, z-index, transition, or breakpoint decisions unless approved
CSS structural constants are allowed when they are not design decisions, such as `1fr`, `100%`, `auto`, `none`, `solid`, and `minmax(0, 1fr)`
`0` is structural only when it represents reset/absence; deliberate zero spacing, zero radius, zero motion, or zero shadow must still be classified as a tokenized decision or an approved exception
no unmanaged magic numbers
no !important except documented framework overrides
no tag-qualified selectors for styled components
no ID selectors for styling
no combined selectors except approved state/theme cases
no orphan selectors
no orphan HTML classes
```

### Design system

```txt
ACSS/project variables are the runtime CSS source of truth
DTCG-compatible token files are the portable governance source
DTCG 2025.10 is a W3C Community Group Final Report with Candidate Recommendation classification, not a W3C Recommendation, W3C Standard, or W3C Standards Track deliverable; treat it as an interchange contract with versioned adapters
each project declares the exact DTCG modules, adapter schema version, and supported `$type` set before token validation
runtime binding metadata maps registered tokens to ACSS/project CSS variables
component-local custom properties must alias registered tokens
raw governed design values may exist only inside token definitions or approved exception records
all token exceptions expire or require reapproval
```

### Visual behavior

```txt
legacy conversion / refactor profile: visually and behaviorally equivalent within thresholds
legacy conversion / migration profile: minor semantic/layout deltas allowed but reviewed
intentional redesign mode: visual change allowed only if tied to approved intent and locked-region rules
optimization-only mode: no intentional visual change unless explicitly scoped
mockup convergence profile: visual change is allowed only toward a hashed, approved visual target and only while semantic/token/BEM/accessibility gates remain satisfied
all intentional visual or behavioral deltas are recorded with authority, rationale, and acceptance criteria
```

### Accessibility

```txt
WCAG 2.2 AA target by default
keyboard support validated for all interactive components
focus-visible style present and not obscured
accessible names present for controls
ARIA is valid, necessary, and not used where native HTML suffices
motion and reduced-motion preferences considered
color contrast validated against target level
```

### Performance

```txt
Core Web Vitals field targets and lab proxy budgets defined separately, with field data segmented by device class when available
lab proxies do not replace field Core Web Vitals data when enough real-user data exists
lab budgets record browser, CPU/network profile, throttling policy, and test hardware/container version
CSS payload budget defined
unused CSS tracked
critical images optimized
font loading strategy defined
third-party script budget defined
hydration/JS budget defined for app frameworks
```

---

# 2. Operating modes

## 2.1 Greenfield generation mode

Use this when no production page exists yet.

Goal:

```txt
Generate directly into semantic BEM + ACSS SCSS without passing through Tailwind.
```

Pipeline summary:

```txt
G0  Project intake and constraints
G1  Business/site strategy
G2  Sitemap and information architecture
G3  Page briefs and conversion goals
G4  Content model and content outline
G5  Section inventory
G6  Component inventory
G7  Token registry and ACSS configuration
G8  Semantic wireframe
G9  BEM/component graph
G10 Mockup generation/evaluation and Visual Target IR
G11 Production style plan
G12 Markup generation
G13 SCSS generation
G14 Interaction/state generation
G15 Validation
G16 Targeted repair
G17 Cross-page consistency audit
G18 Final report
```

Key rule:

```txt
Do not generate utility-heavy prototype code unless the user explicitly wants prototype speed over production architecture.
```

## 2.2 Legacy conversion mode

Use this when an existing AI-generated or hand-built page exists.

Goal:

```txt
Preserve visual and behavioral intent while replacing messy implementation with semantic BEM + ACSS SCSS.
```

Pipeline summary:

```txt
C0  Freeze baseline
C1  Parse source and rendered DOM
C2  Resolve utility classes and CSS rules
C3  Capture computed browser truth
C4  Detect component candidates
C5  Infer semantic rewrite plan
C6  Build BEM graph
C7  Build ACSS/DTCG token map
C8  Rewrite markup
C9  Generate SCSS
C10 Compile and validate
C11 Repair localized failures
C12 Prove idempotence
C13 Produce transformation report
```

Key rule:

```txt
The browser-computed baseline is more authoritative than a utility-class parser.
```

## 2.3 Intentional redesign mode

Use this when the user wants a better page, not just cleaner code.

Goal:

```txt
Improve visual design, content hierarchy, conversion quality, and UX while preserving approved business and content intent.
```

Required additional artifacts:

```txt
redesign brief
accepted mood/style direction
before/after rationale
regions allowed to change
regions locked from change
new success metrics
```

Key rule:

```txt
Visual delta is not a regression if it is explained by approved redesign intent.
```

## 2.4 Optimization-only mode

Use this after production architecture exists.

Goal:

```txt
Reduce drift, improve performance, improve accessibility, simplify CSS, and consolidate components.
```

Typical passes:

```txt
token normalization
component deduplication
CSS dead-code removal
specificity flattening
image optimization
font loading optimization
accessibility repairs
SEO metadata repairs
cross-page consistency repairs
```

Key rule:

```txt
No broad rewrite. Only localized, measurable improvements.
```

## 2.5 Mode selection and transition rule

Choose exactly one primary mode for each run. A run may enter a narrower profile, such as refactor or mockup convergence, only through an explicit checkpoint that records:

```txt
current mode
new mode/profile
reason for transition
baseline authority and visual-target authority
input artifact authority matrix
locked artifacts, regions, states, themes, and viewports
new or changed acceptance criteria
hard gates that remain unchanged
human approval requirement, if any
```

This prevents accidental scope creep, such as a legacy refactor silently becoming a redesign because a visual optimizer found a prettier local minimum.

---

# 3. Artifact graph architecture

## 3.1 Core idea

Instead of a single fixed sequence, Gen2Prod should maintain an **artifact graph**.

```txt
Artifact = versioned file/data object
Pass = deterministic or AI-assisted transform
Gate = assertion that an artifact set must satisfy
Report = measured facts, explanations, and decisions
```

Example graph:

```txt
site.brief.md
  ↓
strategy.ir.json
  ↓
sitemap.ir.json
  ↓
page.home.brief.json
  ↓
content.home.ir.json
  ↓
component.inventory.json
  ↓
tokens.registry.json → acss.registry.json
  ↓                     ↓
visual-target.home.ir.json → style.plan.json
  ↓                         ↓
page.home.bem.json → page.home.html
  ↓                     ↓
page.home.scss ← style.plan.json
  ↓
rendered snapshots / semantic visual diffs / audits / reports
```

## 3.2 Artifact manifest

Every run should produce a manifest.

```json
{
  "projectId": "acme-site",
  "runId": "2026-06-09T22-00-00Z",
  "mode": "legacy-conversion",
  "inputs": [
    { "path": "src/pages/home.html", "sha256": "..." },
    { "path": "src/styles/app.css", "sha256": "..." }
  ],
  "visualTargets": [
    { "path": "mockups/home/approved-1440.png", "sha256": "...", "viewport": "1440x1200" }
  ],
  "inputAuthorities": {
    "src/pages/home.html": ["content", "links", "forms", "behavior-hooks", "semantics-partial"],
    "mockups/home/approved-1440.png": ["visual-target-only"]
  },
  "acceptanceProfile": {
    "mode": "legacy-conversion/refactor",
    "lockedViewports": [360, 768, 1280, 1440],
    "requiresHumanApproval": false
  },
  "schemaVersions": {
    "manifest": "0.2.0",
    "bemPlan": "0.2.0",
    "tokenRegistryAdapter": "dtcg-2025-10+gen2prod-0.2.0"
  },
  "captureEnvironment": {
    "browser": "chromium",
    "browserVersion": "...",
    "os": "...",
    "deviceScaleFactor": 1,
    "timezone": "UTC",
    "locale": "en-US",
    "fontSetHash": "..."
  },
  "artifacts": [
    { "path": ".gen2prod/baseline/dom.json", "type": "dom-ir" },
    { "path": ".gen2prod/plans/bem-plan.json", "type": "bem-plan" },
    { "path": ".gen2prod/reports/visual.json", "type": "visual-report" }
  ],
  "toolVersions": {
    "gen2prod": "0.2.0",
    "node": "...",
    "sass": "...",
    "playwright": "...",
    "axe-core": "..."
  },
  "modelRuns": [
    {
      "pass": "semantic-inference",
      "model": "...",
      "promptHash": "...",
      "schema": "semantic-plan.schema.json",
      "samplingSettings": { "temperature": 0.1, "topP": 1 },
      "outputHash": "..."
    }
  ]
}
```

## 3.3 Pass interface

Every pass should expose:

```txt
name
mode compatibility
input artifacts
source-authority requirements for each input
output artifacts
minimum evidence required before acceptance
preconditions
postconditions
risk class
idempotence expectation
whether LLM-assisted
schemas for all structured outputs
validation gates to run afterward
repair strategy if gate fails
expected blast radius
side effects that must be remeasured
confidence/uncertainty fields for inferred facts
metrics produced and metric sign convention
evidence source for expected utility estimates
artifact ownership boundaries that the pass may edit
read-only artifacts and source-authority fields the pass must not change
whether the pass is destructive, reversible, or review-only
rollback patch or inverse-operation metadata when practical
stopping/escalation criteria
decision provenance requirements
```

Example:

```json
{
  "name": "bem-graph-inference",
  "kind": "llm-assisted-plan",
  "inputs": ["dom-ir", "content-ir", "component-candidates"],
  "authorityRequirements": {
    "dom-ir": ["rendered-structure", "accessibility-tree"],
    "content-ir": ["approved-content-intent"],
    "component-candidates": ["inferred-patterns"]
  },
  "outputs": ["bem-graph"],
  "minimumEvidence": ["matched source node", "content role signal", "style/layout role signal"],
  "preconditions": ["component-boundaries-exist"],
  "postconditions": ["all-styled-nodes-classified"],
  "riskClass": "medium",
  "idempotenceExpected": true,
  "confidenceFields": ["confidence", "evidence", "risk"],
  "metricsProduced": ["bem_coverage_gain", "classification_review_burden"],
  "utilityEvidenceSource": "fixture-derived-prior",
  "editableArtifacts": ["bem-graph"],
  "repairStrategy": "local-node-reclassification",
  "escalationCriteria": ["low-confidence block root", "unmatched styled node"]
}
```

---

# 4. Intermediate representations

## 4.1 Strategy IR

Captures why the site exists.

```json
{
  "businessGoal": "Generate qualified consultations",
  "primaryAudience": "Founders building AI-enabled service businesses",
  "conversionGoal": "Book a strategy call",
  "positioning": "Production-ready AI website systems, not disposable mockups",
  "trustSignals": ["case studies", "process transparency", "performance proof"],
  "constraints": ["ACSS", "BEM", "SCSS", "WCAG 2.2 AA"]
}
```

Why it matters:

A page cannot be judged only by visual similarity. It must satisfy intent: message clarity, conversion path, audience fit, and trust.

## 4.2 Content IR

```json
{
  "page": "home",
  "sections": [
    {
      "id": "hero",
      "goal": "communicate value proposition and drive CTA",
      "requiredElements": ["eyebrow", "h1", "lede", "primaryCta", "secondaryCta", "proofPoint"],
      "seoIntent": "AI website generation production workflow",
      "contentStatus": "draft"
    }
  ]
}
```

## 4.3 Component Contract IR

```json
{
  "name": "feature-card",
  "type": "component",
  "description": "Reusable card for one product capability or benefit",
  "props": {
    "title": { "type": "string", "required": true },
    "text": { "type": "richText", "required": true },
    "icon": { "type": "icon", "required": false }
  },
  "variants": ["default", "featured", "compact"],
  "states": ["default", "hover", "focus-visible"],
  "slots": ["icon", "title", "text", "action"],
  "bem": {
    "block": "feature-card",
    "elements": ["icon", "title", "text", "action"],
    "modifiers": ["featured", "compact"]
  }
}
```

Why it matters:

A component contract prevents the system from inventing five different card structures across five pages.

## 4.4 DOM IR

```json
{
  "nodeId": "n42",
  "tag": "div",
  "attributes": {
    "class": "rounded-2xl bg-white p-8 shadow-xl"
  },
  "textFingerprint": "...",
  "children": ["n43", "n44"],
  "sourceLocation": {
    "file": "src/pages/home.html",
    "start": 120,
    "end": 188
  }
}
```

## 4.5 Style Intent IR

```json
{
  "nodeId": "n42",
  "styleRole": "card-surface",
  "layoutRole": "grid-item-content-wrapper",
  "contentRole": "pricing-plan-card",
  "confidence": 0.86,
  "confidenceKind": "ordinal-uncalibrated",
  "evidence": ["computed styles", "nearby heading text", "repeated card pattern"],
  "visualProperties": {
    "padding": "large card padding",
    "radius": "large rounded surface",
    "shadow": "raised card elevation",
    "background": "light surface"
  }
}
```

## 4.6 Token Registry IR

```json
{
  "$extensions": {
    "gen2prod": {
      "conformsTo": [
        "DTCG Format Module 2025.10",
        "DTCG Color Module 2025.10"
      ],
      "schema": "./schemas/design-tokens-format-2025-10.schema.json",
      "schemaAuthority": "project adapter schema; DTCG report is normative, schema is a validation helper"
    }
  },
  "spacing": {
    "m": {
      "$type": "dimension",
      "$value": { "value": 1, "unit": "rem" },
      "$extensions": {
        "gen2prod": {
          "runtimeVariable": "--space-m",
          "runtimeExpression": "var(--space-m)",
          "source": "acss",
          "usage": ["gap", "padding", "margin"],
          "sampledValues": {
            "default@1280": { "value": 16, "unit": "px" }
          }
        }
      }
    }
  },
  "color": {
    "surface": {
      "$type": "color",
      "$value": {
        "colorSpace": "srgb",
        "components": [0.96, 0.97, 0.98],
        "alpha": 1
      },
      "$extensions": {
        "gen2prod": {
          "runtimeVariable": "--base-ultra-light",
          "runtimeExpression": "var(--base-ultra-light)",
          "source": "acss"
        }
      }
    }
  }
}
```

Do not put raw CSS custom-property expressions such as `"var(--space-m)"` in typed DTCG `$value` fields. Store the portable token value or token reference in `$value`, then store the CSS runtime binding in `$extensions.gen2prod`.

Do not assume there is a single canonical public JSON Schema URL for DTCG 2025.10. Schema validation should use a project-vendored or adapter-provided schema that is explicitly mapped to the supported DTCG modules; the report remains the normative conformance source. If the project needs token categories not defined by the current DTCG modules, store them as project-governed categories with explicit `$extensions` metadata rather than inventing incompatible `$type` values.

## 4.7 BEM Graph IR

```json
{
  "block": "hero",
  "semanticElement": "section",
  "elements": {
    "inner": { "class": "hero__inner", "nodeRole": "layout-container" },
    "content": { "class": "hero__content", "nodeRole": "content-stack" },
    "eyebrow": { "class": "hero__eyebrow", "nodeRole": "section-kicker" },
    "title": { "class": "hero__title", "nodeRole": "primary-heading" },
    "lede": { "class": "hero__lede", "nodeRole": "supporting-copy" },
    "actions": { "class": "hero__actions", "nodeRole": "cta-group" },
    "media": { "class": "hero__media", "nodeRole": "visual-proof" }
  },
  "modifiers": {
    "split": "hero--split",
    "dark": "hero--dark"
  },
  "childBlocks": [
    {
      "block": "button",
      "mountRole": "primary-cta",
      "classes": ["button", "button--primary"],
      "externalOwner": "hero__actions"
    }
  ],
  "mixes": []
}
```

## 4.8 Visual Target IR

Captures an approved mockup or screenshot as a visual objective without pretending it contains source semantics.

```json
{
  "targetId": "home-hero-approved-v1",
  "source": {
    "kind": "image-mockup",
    "path": "mockups/home/approved-1440.png",
    "sha256": "...",
    "viewport": { "width": 1440, "height": 1200 },
    "deviceScaleFactor": 1,
    "captureAssumptions": {
      "browser": "chromium",
      "fontSet": "approved-fonts-v1",
      "colorScheme": "light",
      "colorProfile": "sRGB",
      "dynamicRegionsMasked": []
    },
    "approval": {
      "status": "approved",
      "approvedBy": "human-or-design-system",
      "approvedAt": "2026-06-09T22:00:00Z"
    }
  },
  "authority": {
    "visual": "authoritative",
    "semantics": "not-authoritative",
    "behavior": "not-authoritative",
    "content": "not-authoritative-unless-approved-text-source",
    "textExtraction": "advisory-only",
    "responsiveRules": "not-authoritative",
    "tokenNames": "not-authoritative"
  },
  "regions": [
    {
      "regionId": "hero",
      "expectedRole": "primary-intro",
      "bbox": { "x": 0, "y": 0, "w": 1440, "h": 760 },
      "locked": false,
      "weights": { "layout": 0.35, "typography": 0.25, "color": 0.15, "imagery": 0.15, "spacing": 0.10 }
    }
  ],
  "acceptance": {
    "requiresHumanApproval": true,
    "semanticGatesStillApply": true,
    "tokenAndBemGatesStillApply": true,
    "maxAutomatedRepairIterations": 3
  }
}
```

Why it matters:

A mockup can be the visual target for convergence, but the compiler must still derive HTML semantics from content, accessibility rules, and component contracts. OCR or image text extraction can help with review, but it must not become the source of truth for final copy unless a text artifact or human approval grants that authority. Color sampled from raster images is also advisory unless color-management assumptions and design-token authority are declared. This prevents the system from creating a visually close but semantically meaningless copy.

---

# 5. Source ingestion and adapters

## 5.1 Supported source types

```txt
static HTML
JSX / TSX
Vue SFC
Svelte component files
Astro components
Twig / Liquid / Nunjucks templates
WordPress / Bricks / builder-exported HTML where practical
compiled CSS
SCSS/Sass source
Tailwind CSS v3 config
Tailwind CSS v4 CSS-first config
Figma-exported design tokens or design metadata where available
design-system metadata exports
screenshots/mockups
```

Priority policy:

```txt
MVP 1 input: static HTML plus compiled CSS/Tailwind output
Next: JSX/TSX with a stable AST adapter
Later: Vue/Svelte/Astro/template/CMS adapters
Approved screenshots and mockups may be authoritative visual targets
Screenshots and mockups are never authoritative source code, semantics, behavior, or token-name evidence
```

A screenshot-only input can specify the desired visual state for a viewport, but it cannot reliably prove DOM semantics, behavior, token names, content intent, or responsive rules without corroborating source/design metadata. Treat it as a **visual target**, not a complete product contract. Conversely, source code may contain conditional branches not present in a captured render, so rendered truth is authoritative only for the captured states while source analysis remains necessary for unrendered states.

### 5.1.1 Input authority matrix

Every adapter should classify what each input is allowed to decide.

```txt
source HTML/framework code: content, URLs, forms, behavior hooks, conditional branches, and explicit semantics only; div-soup semantics remain hypotheses
compiled CSS/browser output: computed visual truth for captured states only
ACSS/project token registry: token names, runtime variable bindings, allowed aliases
Figma/design metadata: visual intent, component hints, token metadata when exported explicitly
approved screenshot/mockup: visual target for declared viewport/region only
OCR or image text extraction: advisory review signal only until approved
LLM inference: hypothesis with evidence and confidence, never sole authority for destructive edits
```

When authorities conflict, prefer the artifact with explicit authority for that concern and route destructive changes to review.

## 5.2 Parser strategy

Use deterministic parsers before AI interpretation:

```txt
HTML/template parsing: parse5 or framework adapter
JS/TS/JSX parsing: Babel / TypeScript AST
CSS parsing: PostCSS / CSSTree
SCSS parsing: postcss-scss plus Sass compile validation
Tailwind resolution: Tailwind compiler output + utility parser
Rendered truth: browser automation
Accessibility tree: browser protocol
```

## 5.3 Tailwind v3/v4 extraction policy

Tailwind must be treated as a **style source**, not an architectural destination.

Capture:

```txt
source class strings
compiled CSS rules
Tailwind version
CSS entrypoint
@theme variables
@source directives
@utility directives
@variant and @custom-variant directives
@config and @plugin compatibility inputs
Tailwind v4 `@source inline()` / `@source not inline()` safelist/blocklist equivalents and any v3 safelist/blocklist config
custom utilities
custom variants
plugin utilities
arbitrary values
arbitrary properties
arbitrary variants
container query variants
computed styles in browser
class composition helper usage such as `clsx`, `classnames`, `cva`, `tailwind-merge`, or framework-specific class bindings
```

Why compiled CSS is mandatory:

```txt
class parsing can miss plugin behavior
class order and generated CSS matter
variants can be custom or arbitrary
Tailwind v4 theme-driven utilities and variants are derived from CSS-first theme variables
browser defaults and inheritance affect final computed values
conditional classes may only appear in some rendered states
class-merging tools can delete or override utilities before they reach the rendered DOM
Tailwind scans source text for class-like tokens; dynamic class fragments and string interpolation must be mapped to complete static class strings or explicitly safelisted
dynamically constructed partial class names may never be generated by Tailwind unless safelisted or present as complete strings
```

Unknown classes should be classified as unknown, not guessed. They require compiled CSS evidence, rendered-state evidence, source evidence from complete class strings, or review.

## 5.4 Baseline capture

Before any rewrite:

```txt
raw source files
compiled CSS
approved visual targets/mockups when present
rendered DOM
computed styles, including relevant pseudo-elements and scripted/forced pseudo-class states
layout boxes
screenshots
accessibility tree
focus order
network waterfall
performance trace
SEO metadata
console errors
capture environment: browser version, OS, device scale factor, locale, timezone, font source, feature flags, auth/data fixture, and network policy
```

Viewports:

```txt
320
360
480
768
1024
1280
1440
1920 when relevant
```

States:

```txt
default
hover
focus-visible
active
disabled
open/closed
error
loading
empty
long-content
reduced-motion
forced-colors
```

Do not try to automate privacy-protected pseudo-states such as `:visited`; treat them as policy/lint checks instead of screenshot states.

Themes:

```txt
light
dark
brand themes
high contrast / forced colors when possible
```

## 5.5 Capture matrix policy

Do not require every viewport × state × theme combination on the first MVP run. Define a **capture matrix** with tiers:

```txt
MVP required:
  360, 768, 1280, 1440
  default, focus-visible, open/closed for declared interactive components
  light theme unless dark is in scope

Expanded validation:
  full configured viewport set
  hover/active/disabled/error/loading/empty/long-content
  dark, brand themes, reduced-motion, forced-colors

Release confidence:
  browser/OS matrix
  real or synthetic network conditions
  field-data comparison when available
```

This keeps MVP small while preserving a clear path to production-grade evidence.

---

# 6. Design-token architecture

## 6.1 Principle

ACSS variables are the CSS runtime authority. The token registry is the governance and tooling authority.

```txt
DTCG-conformant token value registry
  ↓ validates and enriches
runtime binding map to ACSS/project variables
  ↓ consumed by
SCSS declarations
  ↓ verified by
token usage audit
```

The registry answers “what design decision is this?” The runtime binding map answers “which CSS custom property implements it in this project?”

## 6.2 Token categories and DTCG type mapping

Distinguish **governance categories** from DTCG `$type` values. Categories describe product semantics; `$type` describes portable value syntax.

At minimum, govern these categories:

```txt
color → DTCG color
spacing / section spacing / radius / border width / breakpoint / container size / content width / icon size → DTCG dimension when portable
font family → DTCG fontFamily
typography size / letter spacing → DTCG dimension or sub-values of a DTCG typography composite token
typography weight → DTCG fontWeight or a sub-value of a DTCG typography composite token
line height → DTCG number when unitless; length-based line-height should be recorded as a project-governed extension unless the active DTCG adapter explicitly supports it
z-index / opacity → DTCG number
shadow / elevation → DTCG shadow or project elevation category mapped to shadow tokens
motion duration → DTCG duration
motion easing → DTCG cubicBezier
focus style → DTCG border/shadow/composite token or project category with explicit extensions
```

Do not invent unsupported DTCG `$type` strings such as `spacing`, `breakpoint`, or `focusStyle` merely because they are useful product categories. Use standard DTCG types where possible and place project-only semantics in names, groups, or `$extensions`. If an adapter supports a project-only `$type`, it must be namespaced, declared non-DTCG-conformant, and excluded from portable interchange exports. For non-portable values such as fluid functions, environment-dependent breakpoints, or keyword-based policies, store the governance category and runtime binding in extensions rather than forcing them into a portable DTCG value shape.

## 6.3 Token metadata

Each token should record:

```txt
name
runtime CSS variable
category
type
DTCG module/version when applicable
semantic role
allowed properties
theme/mode availability
aliases
source system
fallback value
sampled computed values by viewport/theme/state when fluid
status: active / deprecated / experimental / exception
introduced date
last reviewed date
owner
```

Example:

```json
{
  "name": "spacing.card.padding.default",
  "runtimeVariable": "--space-m",
  "type": "dimension",
  "category": "spacing",
  "semanticRole": "component-inner-spacing",
  "allowedProperties": ["padding", "gap"],
  "source": "acss",
  "status": "active"
}
```

## 6.4 ACSS extraction

Build `acss.registry.json` from the actual project, not hardcoded assumptions.

ACSS major versions are source-compatibility boundaries. For example, ACSS 4.x is more variable-first/BEM-first and is not a drop-in continuation of every 3.x workflow. The extractor must record the major version and avoid assuming that old utility modules, breakpoint presets, transparency variables, or color-mode variables exist.

Inputs:

```txt
compiled ACSS CSS
project ACSS settings export when available
ACSS version and module state: full / pro / classless / mixed
CSS custom properties from :root/theme scopes
known ACSS variable documentation fallback, marked lower authority than project artifacts
manual registry overrides
source artifact hashes
```

Outputs:

```txt
all available variables
version-scoped variable names
computed values at each baseline viewport/theme/state
token categories
valid aliases
missing expected tokens
project-specific additions
```

## 6.5 Token snapping

All snapping decisions must compare **computed values** across every configured viewport, theme, and relevant state. Fluid tokens are candidate functions over conditions, not single scalar values. Before snapping, classify values as scalar, color, tuple, list, keyword, function, structural constant, or layout-dependent; do not force `auto`, `normal`, `fit-content`, `minmax()`, gradients, or shadows into scalar distance formulas.

Do not tokenize CSS grammar merely for purity. Values such as `display: grid`, `grid-template-columns: minmax(0, 1fr)`, `width: 100%`, `object-fit: cover`, and `border-style: solid` are usually structural declarations, not design-token decisions, unless the project explicitly governs them.

For a candidate token `t`, compute errors per condition and aggregate with both mean and tail metrics:

```txt
conditions = viewport × theme × state
error_vector(x, t) = [error_c for c in conditions]
snap_allowed only if mean(error_vector), p95(error_vector), and max critical-state error satisfy policy
```

This avoids accepting a token that matches desktop/light/default while failing mobile/dark/hover. If the capture matrix is small, do not overinterpret p95; use the max and critical-state errors as the controlling safeguards until enough conditions exist for stable tail estimates. Values equal to zero require explicit classification before snapping: reset/absence, intentional design choice, collapsed layout artifact, or measurement noise.

### Spacing snap

For raw value `x` and candidate token value `t`:

```txt
relative_error(x, t) = abs(x - t) / max(abs(x), 1px)
absolute_error(x, t) = abs(x - t)
```

A snap must satisfy the relative band and any project-defined absolute tolerance for small values. For `x = 0`, relative error is not decision-worthy by itself; use absolute tolerance plus the zero-value classification.

Decision bands:

```txt
≤ 2%       exact/equivalent
≤ 8%       acceptable snap
≤ 18%      registered fluid/calc token candidate or review
> 18%      exception or new token candidate
```

### Color snap

Use one calibrated perceptual metric, such as **OKLab Euclidean distance** or **CIEDE2000**. Do not mix thresholds across metrics, do not label OKLab distance as ΔE unless the project defines that convention, and do not compare OKLCH hue angles naively when chroma is low. When alpha is involved, compare the composited result against the known background or record the missing-background uncertainty.

```txt
candidate = argmin perceptual_distance(raw_color, token_color)
```

Decision bands:

```txt
metric-specific distance very low       snap automatically
metric-specific moderate distance       review if semantic role agrees
metric-specific high distance           do not snap without redesign approval
```

Color mapping must consider role:

```txt
text-gray-900 used for body copy → text/base role
blue-600 used for CTA background → primary action role
red-600 used for error text → danger role
slate-950 used for dark section bg → base ultra-dark role
```

A color snap must also pass contrast checks for every affected text, icon, focus, and state pairing. A visually close color is still a failed snap if it breaks the configured accessibility target.

### Typography snap

Semantic level and visual size are independent.

```txt
<h2 class="section-header__title"> can use font-size: var(--h1)
```

The token resolver should consider:

```txt
semantic heading level
visual hierarchy
section depth
SEO outline
existing computed font-size
line-height
max-width
responsive behavior
```

## 6.6 Token exceptions ledger

Every raw value that survives must be recorded with provenance and measured impact.

```json
{
  "id": "token-exception-0042",
  "property": "transform",
  "value": "translateY(-3px)",
  "selector": ".feature-card:hover",
  "reason": "micro-interaction offset not represented in token registry",
  "risk": "low",
  "measuredImpact": { "visual": "none", "a11y": "none", "performance": "none" },
  "expires": "2026-09-01",
  "reviewAction": "add motion-distance token or remove exception"
}
```

Why this matters:

Exceptions are inevitable. Unrecorded exceptions become design-system erosion.

---

# 7. BEM, SCSS, and selector policy

## 7.1 Why SCSS remains justified

Native CSS nesting exists, but Sass still has a practical advantage for this project: Sass supports appending suffixes to the parent selector, which is ideal for BEM authoring.

```scss
.hero {
  &__title {
    font-size: var(--h1);
  }

  &--dark &__title {
    color: var(--base-ultra-light);
  }
}
```

Compiled output:

```css
.hero__title {
  font-size: var(--h1);
}

.hero--dark .hero__title {
  color: var(--base-ultra-light);
}
```

If using native CSS nesting, prefer explicit class selectors because native nesting is not a Sass replacement for BEM suffix concatenation.

## 7.2 BEM naming rules

```txt
block
block__element
block--modifier
block__element--modifier
```

Disallowed:

```txt
block__element__subelement
block--modifier__element
section.block
#block
.block.block--modifier for styling
```

`.block.block--modifier` above means a combined CSS selector. Markup may still contain both `block` and `block--modifier` classes on the same node.

## 7.3 Mix policy

Use BEM mixes when a node belongs to a parent layout and a reusable child block.

```html
<li class="feature-grid__item feature-card">
  <h3 class="feature-card__title">Fast setup</h3>
</li>
```

Ownership:

```txt
feature-grid__item owns grid placement and external geometry
feature-card owns internal card styling
```

## 7.4 Specificity budget

Default max specificity for component and section styles:

```txt
0,1,0 for normal block/element/modifier rules
0,2,0 for approved state/theme relationships
0,3,0 only with documented exception
```

Allowed:

```scss
.hero {}
.hero__title {}
.hero--dark {}
.hero--dark .hero__title {}
.button[data-state="loading"] {}
```

Base-layer resets may use low-specificity element selectors when they are not component styling.

Disallowed:

```scss
section.hero {}
#hero {}
.page .hero .hero__title {}
.hero.hero--dark {}
.hero > div > h1 {}
```

## 7.5 File structure

```txt
src/styles/
  abstracts/
    _breakpoints.scss
    _mixins.scss
    _functions.scss
  tokens/
    _aliases.scss
    _exceptions.scss
  base/
    _document.scss
    _typography.scss
    _media.scss
  layout/
    _stack.scss
    _cluster.scss
    _grid.scss
  components/
    _button.scss
    _feature-card.scss
    _testimonial-card.scss
    _pricing-card.scss
  sections/
    _site-header.scss
    _hero.scss
    _feature-grid.scss
    _pricing.scss
    _faq.scss
    _cta.scss
    _site-footer.scss
  pages/
    _home.scss
  main.scss
```

## 7.6 Responsive policy

Use:

```txt
container queries for component-local adaptation
media queries for viewport/page-level adaptation
logical properties for direction-agnostic spacing
ACSS variables for values
SCSS variables, CSS preprocessor variables, or build-supported custom media for query conditions
```

Important constraint:

```txt
CSS custom properties are valid in property values, but not as general replacements in selectors/query syntax. Breakpoint query conditions should be build-time variables or build-processed custom media, not `var(--breakpoint-l)` directly in raw media conditions.
```

Example:

```scss
.feature-grid {
  container-type: inline-size;

  &__list {
    display: grid;
    gap: var(--space-m);
    grid-template-columns: 1fr;

    @container (min-width: 48rem) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
}
```

---

# 8. Semantic HTML inference

## 8.1 General rules

```txt
Do not pick tags for visual appearance.
Do not pick heading levels based on font size.
Do not use ARIA where native HTML gives the right semantics.
Do not use button for navigation.
Do not use anchor for non-navigation actions.
Do not create landmarks for every visual section; name only regions that improve navigation.
Do not create heading IDs unless they are used by aria-labelledby or fragments.
```

## 8.2 Common transformations

```txt
top-level content wrapper → main
site top area → header
primary links → nav aria-label="Primary"
footer links → footer + nav where needed
major titled content group → section with a heading
named landmark-worthy region → section aria-labelledby
independently reusable/syndicable content card → article
repeated non-independent cards → ul/li
testimonial quote → figure + blockquote + figcaption
standalone referenced media → figure with optional figcaption
ordinary decorative/layout media wrapper → div
responsive raster image source selection → picture + img
FAQ item → details + summary when native disclosure behavior is sufficient and summary content is valid/non-interactive; otherwise button-controlled disclosure with an interaction contract
stat list → dl where name/value relation matters
icon-only button → button with accessible name
pure decoration → aria-hidden="true" or alt=""
meaningful image → descriptive alt
```

## 8.3 Semantic confidence scoring

Each proposed semantic rewrite receives confidence:

```json
{
  "nodeId": "n12",
  "from": "div",
  "to": "section",
  "confidence": 0.91,
  "signals": [
    "contains h2",
    "contains repeated feature cards",
    "large page region",
    "not independently syndicatable"
  ],
  "risk": "low"
}
```

Low-confidence rewrites should be isolated for review or limited to non-destructive improvements. Unless calibrated against the golden fixture library, `confidence` is an ordinal model/self-assessment field, not a probability that the semantic rewrite is correct.

---

# 9. Greenfield generation pipeline

## G0 — Project intake

Capture:

```txt
business type
audience
site goal
conversion goal
brand adjectives
competitors
must-have pages
must-have components
CMS/framework constraints
ACSS configuration
accessibility target
performance target
SEO target
```

Output:

```txt
project.brief.json
project.constraints.json
```

## G1 — Site strategy

Generate:

```txt
positioning
message hierarchy
audience objections
trust signals
conversion paths
primary/secondary CTAs
SEO topic clusters
content requirements
```

Output:

```txt
strategy.ir.json
```

Gate:

```txt
strategy has one primary conversion goal
page roles are distinct
CTA hierarchy is clear
trust/proof requirements are explicit
```

## G2 — Sitemap and IA

Generate:

```txt
sitemap
navigation groups
page intent
URL slugs
internal-link strategy
content dependencies
```

Output:

```txt
sitemap.ir.json
```

## G3 — Page briefs

Each page gets:

```txt
page goal
search intent
primary audience need
sections
required content
conversion role
schema/metadata needs
```

Output:

```txt
pages/{slug}.brief.json
```

## G4 — Content model

Generate structured content before layout.

```txt
headline variants
section copy
CTA copy
proof points
FAQ questions
testimonial requirements
image requirements
structured data candidates
```

Output:

```txt
content/{slug}.ir.json
```

## G5 — Section inventory

Derive reusable section patterns from the page briefs before deciding component granularity.

```txt
hero
problem/solution
feature grid
process
pricing
FAQ
testimonial/proof
CTA band
footer
```

Output:

```txt
section.inventory.json
```

Gate:

```txt
each section has a goal, required slots, allowed variants, and content dependencies
```

## G6 — Component inventory

Derive components from the whole site and section inventory, not a single page.

```txt
button
site-header
site-footer
hero
section-header
feature-grid
feature-card
testimonial-card
pricing-card
faq
cta-band
logo-cloud
stats-band
```

Output:

```txt
component.inventory.json
```

## G7 — Token registry and theme setup

Generate or import:

```txt
ACSS settings
token registry
runtime variable binding map
brand color roles
typography roles
spacing scale policy
radius/shadow/elevation policy
motion policy
focus policy
```

Gate:

```txt
all production style plans reference registered tokens
no component can invent a raw design value without exception record
```

## G8 — Semantic wireframe

Generate the HTML outline, not final styles.

```txt
landmarks
section order
heading levels
component placement
content slots
CTA placement
```

Output:

```txt
pages/{slug}.wireframe.json
```

## G9 — BEM graph

Generate block/element/modifier graphs for sections and components.

Output:

```txt
bem.graph.json
```

## G10 — Mockup generation, selection, and visual-target scoring

Mockups should be evaluated against strategy, content hierarchy, component feasibility, token compliance, and whether they can become a measurable visual target. Once selected, an approved mockup becomes `visual-target.{slug}.ir.json`; it is authoritative for visual appearance in the captured viewport, not for semantics or behavior.

Score dimensions:

```txt
message clarity
visual hierarchy
component reuse
responsive feasibility
region segmentability
component/region correspondence feasibility before implementation, then node/region correspondence feasibility after render
token compatibility
accessibility risk
performance risk
brand fit
conversion clarity
```

Output:

```txt
mockups/{slug}/candidates.json
mockups/{slug}/selected.json
visual-target.{slug}.ir.json
```

## G11 — Production style plan

Before writing SCSS, produce a structured style plan.

```json
{
  "block": "hero",
  "layout": {
    "display": "grid",
    "gap": "var(--space-xl-to-m)",
    "maxInlineSize": "var(--content-width)",
    "marginInline": "auto"
  },
  "elements": {
    "title": {
      "font-size": "var(--h1)",
      "line-height": "var(--heading-line-height)",
      "max-width": "var(--h1-max-width)"
    }
  }
}
```

The style plan should preserve token provenance. Prefer fields that carry both a stable token ID and the runtime expression, rather than storing only `var(...)` strings and losing the governance link.

## G12 — Markup generation

Generate markup from the semantic wireframe and BEM graph, not directly from a prose prompt.

Output:

```txt
pages/{slug}.html or framework equivalent
```

## G13 — SCSS generation

Generate SCSS from the production style plan.

Output:

```txt
styles/sections/_hero.scss
styles/components/_button.scss
```

## G14 — Interaction/state generation

Generate only declared interactions and states.

Output:

```txt
interaction.contracts.json
state.fixtures.json
framework scripts/components where needed
```

## G15 — Validation

Run all gates.

## G16 — Targeted repair

Repair only localized failures and remeasure affected gates.

## G17 — Site-wide audit

Run cross-page consistency and component reuse audits after all pages exist.

## G18 — Final report

Produce the manifest, delta report, remaining exceptions, and review checklist.

---

# 10. Legacy conversion pipeline

## C0 — Freeze baseline

Outputs:

```txt
baseline.html
baseline.dom.json
baseline.computed-styles.json
baseline.accessibility-tree.json
baseline.screenshots/
baseline.boxes.json
baseline.performance.json
baseline.network.json
baseline.console.json
baseline.seo.json
```

Gate:

```txt
baseline captured for all configured viewports/states/themes
```

## C1 — Parse source

Capture:

```txt
tag names
attributes
class lists
text
children
source locations
framework expressions
conditional rendering
loops/repeated templates
imports
asset references
event handlers
```

## C2 — Resolve styles

Build:

```txt
Tailwind Utility IR
CSS Rule IR
Computed Style IR
Cascade Layer IR
Custom Property IR
Specificity IR
```

Every class becomes one of:

```txt
known utility
custom utility
plugin utility
arbitrary value
arbitrary property
variant wrapper
state variant
container query variant
behavior-only class
framework/generated class
unknown class
non-style class
```

## C3 — Capture rendered truth

The browser determines:

```txt
computed values
box positions
visibility
overflow
focusability
accessibility roles
accessible names
stacking contexts
paint order where relevant
```

## C4 — Detect components

Signals:

```txt
repeated sibling structures
similar style vectors
similar content roles
visual cohesion
semantic boundaries
interaction patterns
asset patterns
layout independence
```

Score:

```txt
component_score =
  0.25 * repeatability +
  0.20 * visual_cohesion +
  0.20 * content_cohesion +
  0.20 * layout_independence +
  0.15 * semantic_evidence_score
```

This is a ranking heuristic, not a calibrated probability. Inputs must be normalized and thresholds should be tuned against the golden fixture library. `semantic_evidence_score` must come from a deterministic rubric or calibrated fixture model. If the only available signal is LLM ordinal confidence, use it for review priority or bucket ordering, not arithmetic weighting.

## C5 — Infer semantics

Output:

```txt
semantic-rewrite.plan.json
```

Do not apply yet.

## C6 — Build BEM graph

Output:

```txt
bem.plan.json
```

Every styled node must be classified as:

```txt
block root
block element
block modifier
BEM mix
composition primitive
behavior hook
unstyled semantic node
removed wrapper
```

## C7 — Map tokens

For each computed/raw value:

```txt
raw value
source class/rule
property
viewport/state/theme
candidate token
error/distance
value classification: governed design value / structural constant / browser default / content-dependent / exception candidate
semantic confidence
decision
exception if needed
```

Output:

```txt
token-map.json
token-exceptions.json
```

## C8 — Rewrite markup

Rules:

```txt
preserve content
preserve URLs
preserve forms
preserve or migrate behavior hooks only after class roles are classified; use data-* where possible
leave unknown classes in place or route to review until compiled CSS, source usage, and behavior evidence prove they are removable
remove Tailwind utility classes only when their style role is replaced and they are not behavior hooks
remove inline visual styles
add semantic tags
add BEM classes
add accessibility IDs/labels where needed
```

## C9 — Generate SCSS

Rules:

```txt
one owner for each declaration
external geometry belongs to parent block
internal styling belongs to component block
state styles use attributes/pseudo-classes/modifiers
all design values use registered tokens or approved exceptions
```

## C10 — Compile and validate

Run:

```txt
markup parse
framework typecheck/build
Sass compile
style lint
BEM lint
token lint
accessibility tests
visual regression
computed style diff
performance audit
SEO audit
security/privacy audit
```

## C11 — Repair

Repair only localized failures.

## C12 — Idempotence

Run mechanical passes again. Expected diff:

```txt
0 semantic changes
0 class churn
0 token remapping churn
0 formatting churn except stable formatter output
```

## C13 — Report

Output:

```txt
transformation-report.md
metrics.json
diff-summary.json
remaining-exceptions.json
review-checklist.md
```

---

# 11. Node correspondence for delta measurement

Semantic rewrites change tags and class names. Therefore, node IDs from the old DOM cannot be the only matching strategy.

## 11.1 Correspondence signals

```txt
stable source location
preserved temporary data-gen2prod-id during rewrite, stripped from production output unless explicitly approved
text fingerprint
accessible name
role
asset URL
href/action URL
form control name
subtree text hash
visual bounding box proximity
visual-target region membership when a mockup is approved
sibling index within matched parent
component role
```

## 11.2 Matching algorithm

```txt
1. exact data-gen2prod-id match
2. exact source-location lineage match
3. high-confidence content/asset/accessibility match
4. subtree similarity match
5. explicit wrapper insertion/removal or list-normalization event match
6. spatial match inside matched parent region
7. unresolved nodes go to manual/review bucket
```

The matcher should enforce one-to-one correspondence by default using a scored assignment step, such as weighted bipartite matching over candidate pairs after hard exact matches are removed. Each accepted match should record a correspondence confidence, decisive signals, and whether it is stable enough for automated repair. Many-to-one or one-to-many matches are allowed only for explicit wrapper insertion/removal, component extraction, or list normalization events recorded in the transformation plan.

## 11.3 Why this matters

A hero section may change from:

```html
<div class="px-6 py-24">
```

to:

```html
<section class="hero" aria-labelledby="hero-title">
```

The delta system must know this is the same conceptual node. Otherwise it will report false DOM deletions/additions instead of meaningful transformation quality.

---

# 12. Metrics and optimization math

## 12.1 State model

```txt
S = {
  Strategy,
  Content,
  IA,
  Components,
  DOM,
  CSS,
  SCSS,
  Tokens,
  BEM,
  Accessibility,
  Visual,
  VisualTarget,
  Performance,
  SEO,
  Security,
  Provenance
}
```

A pass is:

```txt
S' = P_i(S)
```

## 12.2 Delta vector

Deltas must have an explicit sign convention. Use **gain** metrics when higher is better, **loss** metrics when lower is better, **cost** metrics when lower is better but not necessarily a defect, and **risk** metrics for uncertainty or downside exposure. Never mix them inside one unnamed scalar.

```txt
Δ_i = {
  losses: {
    visual_loss,
    mockup_loss,
    layout_loss,
    computed_style_loss,
    semantic_regression_loss,
    a11y_loss,
    performance_loss,
    seo_loss,
    security_loss
  },
  gains: {
    token_coverage_gain,
    bem_coverage_gain,
    component_consistency_gain,
    accessibility_gain,
    performance_gain,
    seo_gain,
    security_gain,
    mockup_conformance_gain
  },
  costs: {
    code_churn,
    review_burden,
    runtime_cost,
    implementation_cost
  },
  risks: {
    regression_risk,
    correspondence_uncertainty,
    model_uncertainty,
    measurement_noise,
    instability
  }
}
```

### Measurement and attribution discipline

A reported delta must state:

```txt
baseline artifact hash
candidate artifact hash
measurement environment
metric direction
whether the claim is descriptive, causal, or inferred
known confounders
confidence calibration source, if any
```

A single before/after diff is descriptive. A causal claim requires a paired sandbox comparison where the candidate patch is isolated, rendered under the same stabilized capture settings, and evaluated with the same correspondence map. Historical and fixture data can inform priors, but they do not prove that a new pass caused a new project-level improvement. For each underlying measurement, use either a gain or a loss representation in a given utility calculation, not both, unless the terms measure different concerns; otherwise the model double-counts the same evidence.

## 12.3 Hard constraints

Some gates are not negotiable in normal modes:

```txt
build must pass
SCSS must compile
no invalid HTML/framework syntax
no severe accessibility regression
no broken keyboard path, focus behavior, or critical interaction
no broken critical CTA
no broken navigation
no new critical security/privacy issue
no unapproved content change in locked or text-authoritative regions
no unapproved raw governed design values
no unexpected visual regression beyond mode threshold
no unapproved movement in locked visual-target regions
no net movement away from an approved mockup target in target-eligible critical regions unless justified by a higher-priority hard gate and recorded as an exception
```

## 12.4 Utility function

Every expected value must record its evidence source:

```txt
paired sandbox measurement
measured audit delta
fixture-derived prior
historical project data
model-proposed estimate
human review
```

Treat expected utility as a posterior estimate, not a fact. A model-proposed estimate can inform priors, but it must not be the sole evidence for a high-risk pass. When a patch can be sandboxed cheaply, measured candidate performance should dominate model speculation.

All utility terms must be normalized before weighting. Do not add raw pixel percentages, Lighthouse milliseconds, token coverage percentages, and review minutes directly. Convert each metric to a bounded project score or keep it as a separate Pareto dimension.

For candidate pass `P_i`:

```txt
U(P_i) =
  α_quality * E[quality_gain]
  + α_coverage * E[coverage_gain]
  + α_consistency * E[drift_reduction]
  - β_risk * E[regression_risk]
  - β_cost * E[cost]
  - β_churn * E[code_churn]
  - β_instability * σ(outcome)
  - β_review * E[review_burden]
```

Here `σ(outcome)` means an uncertainty proxy derived from calibrated fixture history, comparable repeated runs, or candidate-spread diagnostics. It is not a formal standard deviation unless independence and comparability are justified.

Only evaluate `U` after filtering candidates by known hard constraints and preconditions. After a candidate is applied in a sandbox, hard gates must be rechecked against measured artifacts before the patch can be accepted. If a hard gate and the scalar utility disagree, the hard gate wins.

## 12.5 Lower confidence bound

For LLM-assisted passes, sample multiple candidates when risk justifies it, but avoid **pseudo-replication**.

```txt
n = number of independent comparable observations
if n >= 2 and independence is justified: SE(U_i) = stddev(U_i) / sqrt(n)
if n < 2 or independence is not justified: no formal SE; use conservative prior + candidate-spread downside penalty
LCB(P_i) = center(U_i) - k * uncertainty_penalty(U_i) - λ * downside_tail(U_i)
where center(U_i) is a measured candidate score, a calibrated posterior mean, or a conservative prior—not the mean of correlated prompt samples treated as independent data
```

Multiple stochastic candidates from one prompt are useful, but they are correlated samples, not automatically independent observations. Until independence is justified, set formal `n = 1`, do not compute a pretend standard error, and treat candidate spread as an empirical downside/risk signal unless fixture history or repeated comparable runs justify a formal standard error. Selecting the best of many candidates creates a **winner's curse** risk; use holdout fixtures, paired sandbox measurement, or a stronger downside penalty before accepting a high-churn candidate.

Choose the pass with the best lower-bound outcome, not merely the best optimistic outcome. Do not confuse statistical uncertainty with regression risk: regression risk remains an explicit utility penalty and hard-gate concern.

## 12.6 Pareto frontier

Some candidates trade off different goals:

```txt
candidate A: lower visual risk, smaller token gain
candidate B: higher token gain, higher churn
candidate C: lower churn, weaker semantic improvement
```

Keep the **Pareto frontier** and choose based on mode:

```txt
legacy conversion / refactor profile favors visual stability
optimization-only mode favors low churn
intentional redesign mode favors quality gain against approved intent
legacy conversion / migration profile balances maintainability and fidelity
mockup convergence profile favors visual-target improvement under hard gates
```

## 12.7 Idempotence metric

```txt
idempotence_error(P, S) = distance(P(P(S)), P(S))
```

For AI-assisted passes, apply this to the materialized structured plan or cached output, not to an uncached fresh model call. A regenerated model response may be acceptable if it validates to the same semantic plan and produces the same patch.

Required to be near zero for:

```txt
formatting
token snapping
BEM lint repair
inline style removal
class rewrite
SCSS generation from structured plan
specificity repair
accessibility attribute normalization
```

## 12.8 Sequence dependence and scheduler policy

Pass effects are path-dependent. A token pass before component ownership may create churn; a BEM pass before semantic inference may preserve meaningless wrappers. Therefore, Gen2Prod should use a **receding-horizon scheduler**:

```txt
1. filter candidates by hard preconditions
2. reject candidates that violate hard gates outside a repair sandbox
3. estimate one-step utility and uncertainty with recorded evidence sources
4. account for known pass interactions and ordering constraints
5. prefer low-cost measurements when uncertainty is decision-changing
6. apply one pass or a short top-k beam sequence
7. remeasure artifacts before choosing again
```

MVP scheduler:

```txt
greedy one-step ranking + explicit precedence constraints + mandatory remeasurement
```

Later scheduler:

```txt
beam search over short pass sequences with fixture-derived priors and value-of-information sampling
```

---

# 13. Visual and computed-style regression

## 13.1 Visual-test stabilization

Before screenshots:

```txt
disable or freeze animations
force deterministic system time
mock remote content
load fixed or metric-compatible fonts
normalize screenshot crop and font rendering assumptions against any approved visual target
prefer explicit readiness signal; use network-idle waits only when they are reliable for the stack
set viewport/device scale factor
set color scheme
record color profile / color-management assumptions when comparing to raster mockups
set reduced motion
record browser version, OS, device scale factor, and font source
mask dynamic regions
hide cursors/carets where needed
```

## 13.2 Metrics

Use several metrics:

```txt
pixel diff with anti-aliasing tolerance
SSIM / perceptual similarity
layout box delta
computed style delta
text reflow delta
overflow detection
scroll height delta
focus ring visibility
```

## 13.3 Layout delta

```txt
position_delta(e) = abs(x - x') / viewport_width + abs(y - y') / viewport_height
size_delta(e) = abs(w - w') / max(w, 1px) + abs(h - h') / max(h, 1px)
layout_delta(e) = w_position * position_delta(e) + w_size * size_delta(e)
```

Use area weighting and semantic region weighting when aggregating. Report mean, p95, max, and critical-region deltas separately. Cap extreme outliers only for the aggregate score; never hide the uncapped outlier report. Do not let full-page normalization hide movement of small critical controls, focus rings, or CTAs. Unmatched added/removed visible nodes are not ordinary layout deltas; they are correspondence failures or explicit structural-change events. Intentionally removed wrappers may be excluded only when a recorded correspondence event explains the removal.

Aggregate by region:

```txt
header
hero
section
card grid
footer
modal/popover
```

## 13.4 Mode-specific thresholds

```txt
legacy conversion / refactor profile:
  very strict visual/layout thresholds

legacy conversion / migration profile:
  strict thresholds, but semantic wrapper differences tolerated

intentional redesign:
  visual thresholds are replaced by design-brief conformance plus locked-region checks

mockup convergence profile:
  visual thresholds measure movement toward the approved visual target, not similarity to the initial render

optimization-only:
  no unexpected layout movement
```

Thresholds must be calibrated from golden fixtures and real project baselines. They should not be copied blindly between brands, browsers, font stacks, or rendering environments.

## 13.5 Computed-style categories

Track separately:

```txt
layout display/position/grid/flex
spacing
sizing
typography
color
border/radius
shadow/elevation
motion
interaction states
```

This prevents small color changes from hiding large layout regressions.

## 13.6 Semantic visual diff for mockup convergence

When an approved mockup exists, visual comparison should be interpreted through regions and roles, not only pixels.

```txt
1. segment approved mockup into regions using approved design metadata when available, otherwise model-assisted/manual segmentation with uncertainty recorded
2. render candidate implementation under stabilized conditions
3. match rendered DOM nodes to visual-target regions using visual-region correspondence, while using DOM-to-DOM node correspondence only for before/after lineage
4. record segmentation, visual-region correspondence, and node-lineage uncertainty for each region
5. compute per-region losses for layout, spacing, typography, color, imagery, and overflow
6. classify likely causes: token mismatch, BEM owner mismatch, layout model mismatch, content length mismatch, asset mismatch, or unsupported mockup detail
7. classify any text extracted from the mockup as advisory unless a text source has approved it
8. propose the smallest structured patch that should reduce the highest-priority loss
9. rerender and accept the patch only if gates pass and total constrained utility improves
```

The math should act as a **black-box optimization objective** over discrete patches. It can rank candidate edits and stop bad iterations, but it should not pretend CSS/HTML generation is differentiable gradient descent. The visual-target image has regions and pixels; only the rendered implementation has DOM nodes, so the system must keep visual-region correspondence separate from DOM node correspondence.

Example objective:

All terms must be normalized to comparable bounded scales before weighting; otherwise large pixel regions or easy-to-measure color differences can swamp critical semantics or CTA layout.

```txt
mockup_loss =
  w_layout * region_layout_loss +
  w_spacing * spacing_token_loss +
  w_type * typography_loss +
  w_color * perceptual_color_loss +
  w_image * asset_alignment_loss +
  w_overflow * overflow_loss

constrained_score =
  -mockup_loss
  + semantic_contract_score
  + token_bem_compliance_score
  - regression_risk
  - code_churn_penalty
```

Hard gates still dominate. A patch that improves pixel similarity but damages headings, CTA behavior, token governance, accessibility, or performance is rejected or routed to an explicit review sandbox.

## 13.7 Stop criteria for convergence loops

Stop iterating when any of these is true:

```txt
approved visual threshold is met
marginal constrained utility falls below threshold
the same failure repeats after two localized repairs
the next likely fix requires a new token, component variant, asset, or content decision
visual closeness conflicts with accessibility, semantics, or performance
human review is required for subjective design intent
```

---

# 14. Validation gates

## Gate A — Build and syntax

```txt
framework build passes
HTML/template parses
SCSS compiles
imports resolve
assets resolve
routes resolve
no new console errors in target flows
existing baseline console errors triaged separately
```

## Gate B — BEM/class architecture

```txt
all styled classes match approved taxonomy
no Tailwind utilities remain in final production markup
no elements of elements
no orphan selectors
no orphan HTML classes
no tag-qualified component selectors
no styling IDs
specificity budget respected
```

## Gate C — Token governance

```txt
all governed color values use tokens
all governed spacing values use tokens
all governed typography values use tokens
all governed radius/shadow/border/motion/focus values use tokens
all component custom properties alias registered tokens
CSS structural constants are allowed only when classified as structural declarations rather than governed design values
no unapproved raw governed design values
no expired exceptions
no unapproved calc expressions outside registered fluid tokens or approved exceptions
coverage denominators are reported by property category and cannot be inflated by broad structural-constant classification
```

## Gate D — Inline style elimination

```txt
style attributes = 0 unless approved dynamic exception
inline event attributes in emitted HTML = 0 unless framework requires and reviewed
framework event bindings are allowed only when typed, idiomatic, and not emitted as unsafe inline attributes
style-like framework props = 0 unless approved
arbitrary CSS escape hatches = 0 unless recorded
```

## Gate E — Accessibility

```txt
WCAG 2.2 AA target configured
axe-style automated checks pass or are triaged
keyboard path covers all interactive components
focus order is logical
focus-visible is present and not obscured
interactive controls have accessible names
interactive targets meet configured target-size policy or have recorded exceptions
forms have labels/errors/help text
images have intentional alt text
ARIA is valid and necessary
color contrast passes
reduced-motion mode is acceptable
manual review tasks generated for non-automatable issues
automated checks do not claim full WCAG conformance without scoped human review
```

## Gate F — SEO/content

```txt
one clear H1 per page unless justified
metadata exists and matches page intent
canonical URL policy defined
Open Graph/Twitter metadata where needed
structured data candidates validated
internal links support sitemap strategy
CTA hierarchy matches page brief
no duplicate generic headings across pages
```

## Gate G — Performance

```txt
Core Web Vitals field budgets defined when enough real-user data exists, segmented by mobile/desktop or relevant device class
lab proxy budgets defined separately for CI
LCP candidate optimized
CLS sources identified
INP risks identified through interaction tests, long-task analysis, or field data rather than Lighthouse score alone
CSS payload within budget
unused CSS tracked
critical fonts optimized
images sized with width/height
lazy/eager image strategy intentional
third-party script budget enforced
```

## Gate H — Security/privacy

```txt
no unsafe inline scripts
no unknown third-party scripts without inventory
forms have privacy/data-handling review
no secrets or API keys in source
untrusted CMS/user content sanitized
external links reviewed for rel policy
CSP compatibility considered, including nonce/hash strategy for approved inline artifacts
inline JSON-LD allowed only when sanitized, generated from trusted data, and CSP-compatible via nonce, hash, or approved policy
```

## Gate I — Cross-page consistency

```txt
same component has same contract
same variant has same visual output
same slot uses same token role
duplicate visual patterns are detected
component names are canonicalized
raw value recurrence is flagged
orphan/unused tokens are reviewed
breakpoint/query policy is consistent
```

## Gate J — Approved visual target conformance

```txt
approved mockup is recorded as Visual Target IR
rendered candidate is captured under matching viewport/device/font assumptions
region correspondence is recorded
critical regions move toward target or have documented exception
visual closeness does not override semantic, behavior, BEM, token, accessibility, performance, or security gates
remaining visual gaps are classified as patchable, asset/content-dependent, or design-review-dependent
```

---

# 15. Accessibility strategy

## 15.1 Automation tiers

```txt
static lint:
  obvious code-level issues

DOM/accessibility-tree checks:
  roles, names, focusability, landmarks

automated WCAG checks:
  axe-style browser checks

scripted keyboard tests:
  tab order, escape behavior, open/close behavior, focus return

manual review prompts:
  alt quality, reading order nuance, cognitive clarity, screen-reader UX
```

## 15.2 Components requiring interaction contracts

```txt
navigation menu
dropdown
accordion
modal/dialog
tabs
carousel, with no autoplay by default and pause/stop/hide controls when motion is present
popover/tooltip
form fields
custom select/combobox
skip link
```

Each contract defines:

```txt
keyboard behavior
focus management
ARIA attributes
state model
escape/close behavior
reduced-motion behavior
screen-reader announcement expectations
```

## 15.3 Accessibility repair examples

```txt
missing button name
  local repair: add aria-label or visible text

link used as button
  local repair: convert to button if it performs action

heading skip caused by visual sizing
  local repair: preserve semantic heading level and apply visual token

focus obscured by sticky header
  local repair: scroll-margin or focus offset strategy
```

---

# 16. Performance and production hardening

## 16.1 Performance budgets

Separate:

```txt
field Core Web Vitals targets: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at the 75th percentile when enough real-user data exists, segmented by mobile/desktop or relevant device class
lab proxy budgets: Lighthouse/WebPageTest/Playwright traces used for CI feedback
interaction proxy budgets: scripted interaction latency, long tasks, and main-thread blocking used to estimate INP risk before field data exists
```

Track:

```txt
LCP
INP
CLS
HTML size
CSS size
unused CSS percentage
JS size
hydration cost
image bytes
font bytes
third-party bytes
request count
critical render path
```

## 16.2 CSS performance

Goals:

```txt
remove Tailwind utility payload when no longer needed
switch ACSS to Pro/Classless mode only after class usage audit proves removed utilities are no longer required
compile only used SCSS partials
avoid high-specificity override chains
avoid duplicate component declarations
avoid unbounded selector nesting
```

## 16.3 Image strategy

```txt
meaningful dimensions
responsive srcset/sizes
modern formats where pipeline supports them
lazy loading below fold
eager/high priority only for LCP image
alt text policy
aspect-ratio to prevent CLS
```

## 16.4 Font strategy

```txt
minimize families/weights
font-display policy
preload only critical fonts
fallback metrics where possible
avoid layout shift from late font swap
```

## 16.5 JS/hydration strategy

```txt
prefer static HTML for static content
hydrate only interactive islands when stack allows
avoid shipping builder/editor scripts to production
remove dead interaction code after semantic rewrites
```

---

# 17. Security, privacy, and CMS safety

## 17.1 Security checks

```txt
no executable inline script/event attributes in generated HTML
inline JSON-LD is allowed only as a reviewed SEO artifact generated from trusted data and made CSP-compatible with nonce, hash, or approved policy
no untrusted HTML insertion without context-appropriate sanitization
no javascript: URLs
no leaked secrets/API keys
no unpinned risky third-party embeds
no form action to unknown endpoint
external links policy reviewed, including `target="_blank"` rel behavior
```

## 17.2 CMS dynamic values

For CMS-controlled visual values, prefer constrained enums.

Bad:

```html
<section style="background-color: #ad22ff">
```

Better:

```html
<section class="campaign-section" data-theme="accent">
```

```scss
.campaign-section {
  &[data-theme="accent"] {
    background-color: var(--accent);
  }
}
```

Last-resort dynamic custom property:

```html
<section class="campaign-section" style="--campaign-accent: #ad22ff">
```

Allowed only when:

```txt
value is sanitized and parsed as the expected CSS value type, not accepted as an arbitrary string
contrast is validated when the value affects foreground/background relationships
property is constrained
exception is recorded
CMS editor guidance exists
```

---

# 18. Cross-page consistency system

## 18.1 Slot matrix

```txt
slot                       page        token/class
hero.padding               home        --section-space-xl-to-m
hero.padding               services    --section-space-xl-to-m
section.title.size         home        --h2
section.title.size         about       --h2
feature-card.padding       home        --space-m
feature-card.padding       services    --space-m
button.primary.background  all         --primary
```

## 18.2 Entropy score

```txt
H(slot) = -Σ p(token|slot) log p(token|slot)
H_norm(slot) = 0 when K = 1
H_norm(slot) is undefined and skipped when K = 0
H_norm(slot) = H(slot) / log(K) when K = number of observed token choices and K > 1
```

Interpretation:

```txt
H_norm = 0       perfect consistency
low H_norm       acceptable variation
high H_norm      drift, false variants, or inconsistent modeling
```

Use minimum support thresholds. Do not penalize variation that is explained by an explicit component variant, theme, breakpoint, or content-density rule. Do not compare entropy scores across slots with very different support without reporting sample counts; sparse slots and single-observation slots should be review hints, not automated repair triggers.

## 18.3 Component equivalence detector

Detect the same visual pattern with different names.

Signals:

```txt
similar DOM structure
similar style vector
similar content roles
similar dimensions
similar interaction states
similar tokens
```

Example issue:

```txt
home: .benefit-card
services: .feature-card
about: .value-card
```

Resolution:

```txt
canonical block: .feature-card
variants: .feature-card--compact, .feature-card--featured
```

## 18.4 Drift report

Report:

```txt
duplicate components
same BEM class with different output
same visual component with different BEM names
raw value recurrence
unapproved calc recurrence
orphan tokens
unused component classes
breakpoint inconsistency
heading inconsistency
button variant inconsistency
card radius/shadow inconsistency
```

---

# 19. Repair loop

## 19.1 Rule

Never run a broad rewrite to fix a localized failure.

## 19.2 Process

```txt
1. identify failed assertion
2. localize affected nodes/selectors/tokens
3. classify failure type
4. generate narrow repair plan
5. apply deterministic patch
6. rerun targeted tests
7. rerun broader tests only if targeted tests pass
8. escalate after repeated failure with the exact blocker and smallest next decision needed
```

## 19.3 Failure types

```txt
build failure
SCSS compile failure
BEM violation
token violation
semantic regression
visual mismatch
layout mismatch
computed-style mismatch
accessibility regression
SEO regression
performance regression
security/privacy issue
orphan selector/class
idempotence failure
```

## 19.4 Repair example

Failure:

```txt
.hero__title font-size changed from 56px to 48px at 1280px viewport.
```

Localized cause:

```txt
text-6xl was snapped to var(--h2) instead of var(--h1).
```

Allowed repair:

```scss
.hero {
  &__title {
    font-size: var(--h1);
  }
}
```

Forbidden repair:

```txt
rewrite entire hero section
rename unrelated classes
change component structure
change CTA copy
```

---

# 20. LLM governance and determinism

## 20.1 LLM responsibilities

```txt
semantic intent inference
component boundary proposals
BEM naming proposals
content role classification
design intent explanation
candidate token mapping with rationale
accessibility risk identification
visual-target interpretation and region labeling
repair plan proposal
```

## 20.2 Deterministic responsibilities

```txt
parsing
class extraction
CSS rule resolution
computed-style capture
schema validation
source patching
SCSS generation from structured specs
formatting
linting
visual diffing
semantic visual diffing against approved targets
accessibility scanning
performance measurement
metric calculation
report generation
```

## 20.3 Structured output only

LLM outputs should be validated against JSON schemas.

Bad:

```txt
Rewrite this page into better code.
```

Good:

```txt
Return semantic-rewrite.plan.json matching this schema.
Do not output source code.
Each node must include confidence and rationale.
```

## 20.4 Replayability

Every AI-assisted decision should record:

```txt
input artifact hashes
prompt version
schema version
model name/version
sampling settings
candidate count
selected candidate
selection rationale
validation result
output artifact hash
```

## 20.5 Instability controls

```txt
low temperature for schema work, while recognizing temperature 0 is not a determinism guarantee
multiple candidates only when value justifies cost
consensus on high-risk semantic changes must use diverse evidence or human review, not mere majority vote among correlated samples from one prompt
LCB scoring for stochastic passes only with valid independence assumptions or fixture-derived priors
cache identical pass inputs
run idempotence checks on materialized plans and patches
prefer deterministic repair when possible
never treat model self-confidence as calibrated probability without fixture calibration
never assume model inference is bit-deterministic across time or providers
```

Replayability means the system can reuse cached structured outputs by hash or prove that a regenerated output satisfies the same schemas and gates. It does not require trusting the model to reproduce identical text forever.

---

# 21. Developer-facing product features

## 21.1 Pipeline Advisor

Shows the recommended next pass.

Example:

```txt
Recommended next pass: token-normalization
Reason: BEM coverage is already 97%, but token coverage is 71% and raw spacing recurrence is high.
Risk: low
Estimated gain: +18 percentage points token coverage
Evidence: fixture prior + current raw-value recurrence
Uncertainty: medium; visual diff required before acceptance
Required gates after pass: token lint, visual diff, SCSS compile
```

## 21.2 Design Delta Explorer

A review UI/report that groups changes by:

```txt
semantic structure
BEM classes
SCSS declarations
token mappings
visual regions
accessibility tree
performance metrics
```

## 21.3 Token Drift Dashboard

Shows:

```txt
token coverage
raw values
exception count
expired exceptions
slot entropy
duplicate values that should be tokens
unused tokens
component-local aliases
```

## 21.4 Component Equivalence Detector

Finds duplicate or near-duplicate components and suggests canonicalization.

## 21.5 Exception Ledger

Tracks every approved violation:

```txt
raw value
inline style
over-specific selector
visual mismatch
accessibility waiver
performance waiver
security waiver
```

Each exception has:

```txt
owner
reason
risk
expiry date
repair recommendation
```

## 21.6 CI Review Bot

On pull requests, comment:

```txt
BEM coverage changed from 94% → 99%
Tailwind classes changed from 212 → 0
raw color values changed from 18 → 1
visual diff passed at 5/6 breakpoints; 768px needs review
LCP lab proxy improved by 320ms
2 accessibility issues remain
```

## 21.7 Pass Replay Log

Records every pass as a reproducible event:

```txt
input artifact hashes
selected pass and mode/profile
structured plan hash
patch hash
gates run before and after
metric deltas
rollback metadata
human approval events
```

This is the debugging spine of the product. It explains why the scheduler acted, makes regressions attributable, and lets teams replay or reject individual changes instead of reviewing an opaque rewrite.

## 21.8 Golden Fixture Library

Start this before the first rewrite MVP. The fixture library is the calibration set for utility weights, visual thresholds, token snapping thresholds, and idempotence expectations.

Maintain sample pages for:

```txt
hero + CTA
feature grid
pricing
FAQ
testimonial
navbar dropdown
modal
form
long-content page
responsive image-heavy page
```

Each fixture includes:

```txt
frozen dependency/tool/browser versions or a declared compatibility range
input messy version
expected semantic version
expected BEM graph
expected token map
expected SCSS
expected validation report
negative-control failures with expected gate messages
optional approved visual target and expected semantic visual diff report
```

---

# 22. Revised best order of operations

## 22.1 Greenfield best order

```txt
1. Define project constraints, source authorities, and success metrics
2. Generate strategy and conversion architecture with one primary conversion goal
3. Generate sitemap and page briefs
4. Generate structured content model
5. Derive section inventory
6. Derive component inventory across the site
7. Define/import ACSS + token registry + runtime binding map
8. Create semantic wireframes
9. Generate BEM/component graph
10. Generate/evaluate mockups against tokens and components
11. Promote selected mockup to Visual Target IR when appropriate
12. Generate style plan
13. Generate semantic markup
14. Generate SCSS from style plan
15. Generate declared interactions/states
16. Validate build/accessibility/visual/performance/SEO/security/visual-target conformance
17. Run targeted repairs or mockup-convergence patches
18. Run cross-page consistency audit
19. Produce final report
```

## 22.2 Legacy conversion best order

```txt
1. Freeze rendered baseline and declare source authorities
2. Parse source and rendered DOM
3. Classify class authority: style, behavior, framework/generated, unknown
4. Resolve utilities/CSS into declarations
5. Capture computed browser truth
6. Infer component boundaries
7. Infer semantic rewrite plan
8. Build BEM graph
9. Build ACSS/DTCG token map
10. Generate markup patch
11. Generate SCSS patch
12. Compile/build
13. Compare rendered output
14. Repair localized failures
15. Prove idempotence
16. Audit cross-page consistency
17. Produce transformation report
```

## 22.3 Optimization-only best order

```txt
1. Load existing contracts and baselines
2. Identify drift/coverage/performance/accessibility gaps
3. Rank candidate passes by constrained utility
4. Apply the lowest-risk high-confidence pass
5. Validate targeted gates
6. Recompute site-wide metrics
7. Repeat until marginal utility falls below threshold
```

## 22.4 Critical ordering constraints

```txt
Do not write code before strategy/content structure exists in greenfield mode.
Do not tokenize governed design values before component roles are known.
Do not generate SCSS before BEM ownership is stable.
Do not judge refactors by source diff alone.
Do not run visual regression before compiled output exists.
Do not run cross-page consistency until multiple pages/components exist.
Do not run broad repair after localized validation failure.
Do not trust LLM-generated code patches without deterministic validation.
Do not remove or rename classes until their style, behavior, framework, or unknown role is classified.
Do not infer global optimal order from independent-looking single-pass deltas; pass effects are path-dependent and often non-causal without paired sandbox evidence.
Do not use screenshots as the sole source of semantics, behavior, responsive logic, content intent, or token truth.
Do not optimize visual similarity to a mockup by violating semantic, token, BEM, accessibility, performance, or security gates.
Do not report aggregate coverage or success without denominators, excluded classes/properties, and unresolved review buckets.
```

---

# 23. Example transformation

## Input

```html
<div class="bg-slate-950 px-6 py-24 sm:py-32">
  <div class="mx-auto max-w-7xl grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-blue-400">
        AI Web Systems
      </p>
      <h1 class="mt-4 text-5xl font-bold tracking-tight text-white sm:text-6xl">
        Launch beautiful sites faster
      </h1>
      <p class="mt-6 text-lg leading-8 text-slate-300">
        Generate, refactor, and validate pages with a consistent design system.
      </p>
      <div class="mt-10 flex items-center gap-x-6">
        <a href="/start" class="rounded-md bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
          Get started
        </a>
      </div>
    </div>
    <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      <img class="rounded-xl shadow-2xl" src="/mockup.webp" alt="Dashboard mockup">
    </div>
  </div>
</div>
```

## Output HTML

```html
<section class="hero hero--split hero--dark" aria-labelledby="hero-title">
  <div class="hero__inner">
    <div class="hero__content">
      <p class="hero__eyebrow">AI Web Systems</p>

      <h1 class="hero__title" id="hero-title">
        Launch beautiful sites faster
      </h1>

      <p class="hero__lede">
        Generate, refactor, and validate pages with a consistent design system.
      </p>

      <div class="hero__actions">
        <a class="button button--primary" href="/start">
          Get started
        </a>
      </div>
    </div>

    <div class="hero__media">
      <img
        class="hero__image"
        src="/mockup.webp"
        alt="Dashboard UI preview showing generated page checks"
        width="1200"
        height="800"
        loading="eager"
        fetchpriority="high"
        decoding="async"
      />
    </div>
  </div>
</section>
```

## Output SCSS

```scss
.hero {
  padding-block: var(--section-space-xl-to-m);
  padding-inline: var(--gutter);

  &__inner {
    max-width: var(--content-width);
    margin-inline: auto;
    display: grid;
    gap: var(--space-xl-to-m);
  }

  &__content {
    display: grid;
    gap: var(--space-m);
  }

  &__eyebrow {
    font-size: var(--text-s);
    font-weight: var(--font-weight-semibold);
    letter-spacing: var(--letter-spacing-wide);
    text-transform: uppercase;
    color: var(--primary-light);
  }

  &__title {
    font-size: var(--h1);
    line-height: var(--heading-line-height);
    font-weight: var(--heading-font-weight);
    color: var(--heading-color);
    max-width: var(--h1-max-width);
  }

  &__lede {
    font-size: var(--text-l);
    line-height: var(--text-line-height);
    color: var(--text-color);
    max-width: var(--text-max-width);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: var(--space-s);
    flex-wrap: wrap;
  }

  &__media {
    padding: var(--space-s);
    border-radius: var(--radius-xl);
    background-color: var(--hero-media-surface);
    border: var(--border-width) solid var(--hero-media-border);
  }

  &__image {
    display: block;
    inline-size: 100%;
    border-radius: var(--radius-l);
    box-shadow: var(--box-shadow-xl);
  }

  &--dark {
    background-color: var(--base-ultra-dark);
    color: var(--base-ultra-light);
  }

  &--dark &__title {
    color: var(--base-ultra-light);
  }

  &--dark &__lede {
    color: var(--base-light);
  }

  &--split &__inner {
    @media (min-width: $breakpoint-l) {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      align-items: center;
    }
  }
}
```

Note:

```txt
Variable names must be validated against the project’s actual ACSS/project registry. Unknown names are compile/token-gate failures, not harmless placeholders. In the example, `--hero-media-surface` and `--hero-media-border` must be registered aliases, not ad hoc component inventions.
The example intentionally omits some browser-reset/base-layer details. A real conversion must check inherited defaults before attributing every computed difference to the component SCSS.
The image `width` and `height` values are illustrative. A real conversion must preserve or derive the actual intrinsic dimensions to prevent CLS and avoid distorting the approved visual target.
The revised image alt text is an illustrative accessibility repair. In a strict legacy refactor, changed alt text requires content authority, human review, or an explicit accessibility exception record.
The `.button` child block, including focus-visible styling, is assumed to live in its own component partial and contract. The hero example does not add a `hero__button` mix because `hero__actions` already owns CTA-group spacing and placement.
The example intentionally keeps structural CSS constants such as `grid`, `auto`, `100%`, and `minmax(0, 1fr)` as CSS grammar rather than tokenizing them.
```

---

# 24. MVP roadmap

## MVP 0 — Evaluation harness and fixture seed

Scope:

```txt
3–5 golden fixtures as a seed set, not a statistically representative calibration set
negative-control fixtures for known failure modes
baseline capture script
fixture compatibility matrix for browser/tool/dependency versions
artifact manifest schema
BEM/token lint fixture expectations
basic visual diff fixture expectations
calibration notes for thresholds and confidence fields, marked non-calibrated until the suite is representative
report schema
```

Success:

```txt
fixtures run in CI
known-good output passes
intentional-bad output fails for the expected reason
thresholds are explicit, not implicit
thresholds are marked provisional until the fixture suite is representative
fixture count and coverage gaps are reported beside every provisional threshold
```

## MVP 1 — Single-page conversion proof

Prioritized scope:

```txt
MVP 1A: static HTML input, compiled CSS/Tailwind output, class inventory, rendered baseline capture
MVP 1B: semantic/BEM plan, fixed ACSS/project seed registry, token map, markup rewrite, SCSS generation
MVP 1C: build + BEM + token gates, basic visual regression, one localized repair retry, transformation report, idempotence check
```

Defer from MVP 1:

```txt
framework adapters beyond static HTML/limited JSX
multi-page consistency
complex interaction synthesis
screenshot-only source inference
open-ended redesign
full scheduler optimization
```

Success:

```txt
0 Tailwind styling classes in final production markup; required behavior hooks are preserved as `data-*` or framework-native bindings
0 unapproved inline visual styles
0 unresolved hard-gate failures for build, critical accessibility, critical behavior, or security/privacy
100% of governed declarations accounted for as tokenized, structural, browser default, content-dependent, or approved exception
≥ 95% token coverage for governed design properties, with denominator and exclusions reported by property category
≥ 95% BEM coverage for styled nodes
visual diff within fixture-calibrated legacy conversion / refactor-profile threshold
critical CTA, navigation, keyboard path, and focus behavior preserved
SCSS compiles
all remaining exceptions and review prompts are listed with owner, reason, risk, and next action
idempotence passes on materialized mechanical passes and generated patches
```

## MVP 2 — Multi-page consistency

Add:

```txt
component inventory across pages
slot entropy
component equivalence detector
token drift dashboard
cross-page repair suggestions
```

## MVP 3 — Greenfield generator

Prerequisite: MVP 1 conversion and MVP 2 consistency gates are stable enough that greenfield output can be judged by the same harness instead of by model self-evaluation.

Add:

```txt
strategy IR
page briefs
content model
semantic wireframe
component contract generation
mockup scoring
Visual Target IR for selected mockups
production code generation
```

## MVP 4 — Mockup-to-code convergence

Add:

```txt
approved image mockup ingestion
region segmentation and correspondence
semantic visual diff report
constrained patch ranking
small iterative style/layout repairs
fixture-calibrated acceptance thresholds
stop criteria and human review handoff
```

Defer from MVP 4 unless the loop is already stable:

```txt
fully automated screenshot-only site generation
open-ended redesign from arbitrary images
large structural rewrites driven only by pixel loss
training custom vision models
```

MVP 4 should start with style/layout convergence on known semantic fixtures before accepting screenshot-only source requests. That preserves the mockup-to-code intent without turning the MVP into unconstrained image reconstruction.

### Current bounded screenshot-only implementation

The measurement harness is now stable enough to accept screenshot-only requests as a strict **input/evidence path**, not as a fifth production operating mode. Live or uploaded images are hash-bound; source, DOM, CSS and web extraction are quarantined from the builder; local OCR/segmentation yields unreviewed strategy and semantic hypotheses; deterministic emission produces one-H1 BEM HTML/SCSS; and the browser render is scored for pixel/macro loss, content recall, semantic contracts, uncertainty coverage, dirty-to-clean recovery, idempotence and source/raster leakage. One-change research uses project-isolated train/validation/holdout splits and exports accepted/rejected trajectories.

The original defer remains in force for claims of unrestricted automation. A visually accepted reconstruction is not a complete production site until copy, routes/actions, responsive states, asset meaning, accessibility and dynamic behavior receive authoritative evidence. Temporal/scroll/hover/focus frames prove only observed pixel deltas; they do not prove URLs, side effects, JavaScript mechanisms or animation timing. See [image-only-loop.md](image-only-loop.md) for the executable authority contract.

## MVP 5 — CI/productization

Add:

```txt
CI review bot
published artifact manifest format
replay log UI
exception ledger UI
pull request comments
expanded fixture suite
```

---

# 25. Final operating principle

The project becomes powerful when it stops asking:

```txt
Can the LLM rewrite this page?
```

And starts asking:

```txt
Which artifact is least certain?
Which visual target, if any, is authoritative?
Which pass has the best expected utility under current constraints?
What changed, why did it change, and did it improve the site?
Can we make the next run replayable enough that churn is detected, bounded, and attributable?
```

That is the difference between an AI website prompt and a production-grade **measured generation compiler**.

---

# References checked/updated for v2.3.4 on 2026-06-11

- Automatic.css 4.x documentation overview: https://docs.automaticcss.com/
- Automatic.css Pro Mode & Classless Workflow: https://docs.automaticcss.com/fundamentals/pro-mode-and-classless-workflow
- Automatic.css 4.x changes: https://docs.automaticcss.com/setup/whats-new-in-4
- Automatic.css Spacing Variables: https://docs.automaticcss.com/spacing/spacing-variables
- Automatic.css Typography Variables: https://docs.automaticcss.com/typography/typography-variables
- Tailwind CSS v4.0 announcement: https://tailwindcss.com/blog/tailwindcss-v4
- Tailwind CSS Theme Variables: https://tailwindcss.com/docs/theme
- Tailwind CSS Detecting Classes in Source Files: https://tailwindcss.com/docs/detecting-classes-in-source-files
- Tailwind CSS Functions and Directives: https://tailwindcss.com/docs/functions-and-directives
- BEM CSS methodology: https://bem.info/en/methodology/css/
- Sass parent selector: https://sass-lang.com/documentation/style-rules/parent-selector/
- MDN CSS `var()` function: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/var
- MDN CSS custom properties guide: https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascading_variables/Using_custom_properties
- MDN CSS nesting: https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Nesting/Using
- MDN HTML `<article>` element: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/article
- MDN HTML `<section>` element: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/section
- MDN HTML `<figure>` element: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/figure
- W3C WCAG overview: https://www.w3.org/WAI/standards-guidelines/wcag/
- web.dev Core Web Vitals thresholds: https://web.dev/articles/defining-core-web-vitals-thresholds
- Design Tokens Community Group 2025.10 Format Module: https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/
- Design Tokens Community Group 2025.10 Color Module: https://www.w3.org/community/reports/design-tokens/CG-FINAL-color-20251028/
- Design Tokens Community Group 2025.10 Resolver Module: https://www.w3.org/community/reports/design-tokens/CG-FINAL-resolver-20251028/
- DTCG 2025.10 status note: Community Group reports are stable implementation targets but not W3C Recommendations/Standards/Standards Track deliverables.
- DTCG 2025.10 schema note: treat project-vendored schemas as validation adapters, not normative public schema URLs.

Note: the DTCG 2025.10 reports are W3C Community Group Final Reports with Candidate Recommendation classification, not W3C Recommendations, W3C Standards, or W3C Standards Track deliverables. Treat them as stable interoperability specifications, not formal W3C standards. Project artifacts remain more authoritative than documentation fallbacks when extracting ACSS/runtime variables. Do not depend on a fictional canonical public JSON Schema URL; use an explicitly versioned project adapter schema if schema validation is needed.
