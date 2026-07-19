# Strict image-only reconstruction loop

Gen2Prod can capture a live page or import a generated/uploaded mockup, quarantine every non-image artifact, and use only declared pixels to emit a clean semantic hypothesis in BEM HTML/SCSS. The result is measured against the target screenshot and is useful for recursive improvement, but it is not automatically a production contract.

## Authority boundary

The builder may use the hash-bound target frames, deterministic palette and region analysis, local OCR observations, image-derived strategy hypotheses, reviewed overrides, and the current image reconstruction policy. It may not use the source URL, DOM, HTML, CSS, accessibility tree, network responses, Firecrawl output, or live link records.

Pixels are authoritative only for the captured visual state and viewport. OCR copy is advisory until reviewed. Semantics, destinations, side effects, responsive rules, asset meaning, legal text, and unobserved behavior remain hypotheses or explicit required actions. A full-page screenshot used as a CSS wallpaper is a hard leakage failure; bounded image-region crops are allowed only under the declared coverage policy and cannot contain OCR text.

## Live-page workflow

```bash
gen2prod image capture https://example.com \
  --target example-home --project example --split train \
  --capture-policy visual-probe-sequence \
  --output .gen2prod/image-only/live/example-home

gen2prod image run \
  .gen2prod/image-only/live/example-home/image-target.json \
  --output .gen2prod/image-only/builds/example-home

# Optional and strictly post-build: compare the emitted page with a
# quarantined extraction without allowing it to change builder inputs.
gen2prod image audit \
  .gen2prod/image-only/live/example-home/image-target.json \
  --build .gen2prod/image-only/builds/example-home
```

`still` records one visual state. `scroll-materialized` visits page positions before the final full-page image so common lazy content can render. `visual-probe-sequence` also records scroll checkpoints, temporal frames, and up to three safe hover plus three non-activating focus probes by default. Capture stage deadlines prevent a live page timer or stalled script from hanging the corpus run.

Analysis writes base-image observations separately from `image-state-analysis.json`. Build consumes only state frames declared in the target manifest, verifies their hashes, records affected regions and enriched hypotheses in provenance, and never converts a pixel delta into behavior certainty.

## Uploaded or generated mockups

```bash
gen2prod image import homepage.png \
  --target homepage-v1 --project homepage \
  --dirty-image homepage-dirty.png \
  --strategy content-strategy.md \
  --split validation \
  --output .gen2prod/image-only/imports/homepage-v1

gen2prod image run \
  .gen2prod/image-only/imports/homepage-v1/image-target.json \
  --output .gen2prod/image-only/builds/homepage-v1
```

The importer copies and hashes the image and optional dirty render. A supplied strategy is usable only when the contributor declares that it belongs to or was approved for that image. Otherwise the loop writes an unreviewed image-derived strategy and asks for review.

## Automatic.css bindings

Every configured image build uses the same versioned Automatic.css release as dirty-HTML compilation and research. The builder emits nested, class-only BEM SCSS with no utility or element selectors, uses registered ACSS spacing, typography, focus, radius, content-width, and palette variables, and writes `acss-image-bindings.json`. Exact image-observed palette/geometry values are registered as project ACSS override proposals so image-diff optimization stays calibrated. They are labeled `image-derived-unreviewed`: pixels can support a value observation, but not the proposed `primary`, `base`, `accent`, heading, or spacing meaning.

`build-provenance.json` records the ACSS version, source hash, registry hash, and binding artifact. Release defaults never outrank project settings. A reviewed project settings/token export should replace or approve the proposal before production sign-off.

## What is inferred from still images

The deterministic analyzer extracts palette proportions, horizontal bands, edge density, image dominance, OCR lines and coordinates, tentative region roles, page-type evidence, content hierarchy, conversion labels, and visual voice. The planner then proposes landmarks and sections, a BEM ownership graph, visible content placement, conservative interaction affordances, and exact unresolved concerns.

Still images support priors, not claims. A navigation-like label may justify semantic `<nav>`, but unresolved destinations remain noninteractive text rather than fabricated links. Focus/hover rules are emitted only when the markup contains a corresponding semantic interactive BEM component. A still does not prove a URL, dropdown, animation, form submission, carousel, video control, or click side effect. One desktop image does not prove mobile reflow or breakpoints.

## Dynamic-state inference

Dynamic evidence is tiered:

1. A single still yields only semantic priors, static semantic structure, and reduced-motion CSS. It may suggest possible focus, hover, or active states, but those selectors wait for an emitted interactive component and remain unresolved otherwise.
2. Temporal and scroll frames can prove that pixels changed at a coordinate or after scrolling. They still cannot prove the implementation mechanism.
3. Hover/focus probe pairs can associate a visual delta with a coordinate or focus step. Capture never activates the element, and the resulting hypothesis explicitly prohibits claims about URLs, side effects, timing, or JavaScript.
4. Reviewed state images or an authoritative behavior contract can approve open/closed, loading/error, carousel, video, menu, form, and motion semantics.
5. Active interaction traces from an authorized production workflow can establish behavior that pixels alone cannot.

Provide default, hover, focus, active, expanded, loading, error, success, video-playing, carousel-next, and reduced-motion frames whenever those states matter. Name the viewport, state, trigger and expected side effect for each image.

## Scoring and recursive research

Evaluation renders the emitted HTML and measures target-versus-candidate pixel loss, macro layout loss, OCR content recall, landmarks, one-H1 and BEM contracts, safe-state CSS, unresolved uncertainty coverage, source/raster leakage, page-height mismatch, and optionally dirty-versus-target recovery. A candidate that renders worse than the dirty image is rejected even when its source looks cleaner.

```bash
gen2prod image synth-prepare
gen2prod image synth-evaluate
gen2prod image research --budget 10

gen2prod distill \
  --image .gen2prod/image-only/research/<research-id>/image-trajectories.jsonl \
          .gen2prod/image-only/synthetic-evaluation/image-trajectories.jsonl \
  --target all
```

Research changes one policy dimension at a time, searches train projects, accepts only validation improvements without hard regressions, opens holdout projects only for the final audit, replays every final target for idempotence, and keeps rejected trajectories as verifier/preference data. The accepted image incumbent becomes the default for later `image build` and `image run` commands.

## Required human authority

The loop continues while recording these non-destructive handoffs:

- approve or correct OCR transcription and the image-derived content strategy;
- supply route destinations, form endpoints, action side effects and legal/privacy behavior;
- approve semantic roles, heading intent, asset meaning and alternative text;
- provide mobile/tablet images or explicit responsive contracts;
- provide state images, interaction traces or behavior specifications for dynamics;
- recapture pages flagged for large blank-like regions or confirm that the negative space is intentional.

An accepted image reconstruction means the deterministic candidate met the declared visual/structural gates for that target. It does not mean the page is ready to deploy until the required authority and broader production gates are satisfied.
