# Dataset intake: dirty pages, mockups, and clean outcomes

Real examples are useful even when the before and after are not one-to-one. Gen2Prod records the alignment policy so an intentional redesign is never treated as a failed pixel-preserving refactor.

## Most valuable bundle

Provide as many of these as exist; missing optional artifacts do not prevent ingestion:

1. Dirty HTML and its compiled CSS.
2. A dirty screenshot at a named viewport, theme, and interaction state.
3. Clean HTML and CSS, when available.
4. A clean screenshot or approved image mockup under the same capture conditions.
5. The content strategy, page brief, or prompt used to create the mockup.
6. A small change manifest distinguishing intentional edits from defects.
7. Relevant assets, fonts, routes, form behavior, and content authority.

Record the browser/OS, viewport width, theme, state, device scale, fonts, and any masked dynamic regions. A few well-documented examples are more valuable than many unexplained diffs.

## Alignment policies

| Alignment | Use | Evaluator treatment |
| --- | --- | --- |
| `exact` | Refactor or cleanup intended to preserve the approved render | Clean screenshot is a hard pixel target; dirty and candidate images are scored against it |
| `partial` | Some regions changed intentionally | Reviewed coordinate masks activate region-scoped image-diff fitness; locked pixels are scored and ignored pixels are excluded |
| `non-1-to-1` | Redesign, copy revision, changed sections, or an evolved implementation | Preference/planner supervision; no false exact-pixel failure is assigned |

Non-one-to-one examples still teach content-to-section planning, semantic choices, component boundaries, token usage, acceptable edits, and which output a reviewer preferred. If the source and result share only part of the page, name the shared or locked regions.

Even a small number of imperfect dirty-to-clean builds is useful. The highest-value addition is a short note or mask explaining what changed intentionally. Without it, the pair still trains planning and preference selection; with reviewed shared regions, it can also train localized image recovery. Mockups paired with the content strategy or page brief used to create them are particularly useful because they supervise the otherwise uncertain intent-to-hierarchy step.

## Change manifest

```json
{
  "schemaVersion": "0.1.0",
  "intentionalChanges": [
    "headline revised after stakeholder review",
    "pricing section removed"
  ],
  "lockedRegions": ["site-header", "hero-media"],
  "ignoredRegions": ["dynamic-customer-count"],
  "regionMasks": [
    {
      "id": "site-header",
      "x": 0,
      "y": 0,
      "width": 1,
      "height": 0.12,
      "unit": "fraction",
      "mode": "locked"
    },
    {
      "id": "dynamic-customer-count",
      "x": 910,
      "y": 640,
      "width": 220,
      "height": 80,
      "unit": "px",
      "mode": "ignore"
    }
  ],
  "notes": "Screenshots captured in Chrome at 1280px with project fonts loaded."
}
```

`fraction` coordinates are relative to the compared image and must stay in the `0..1` range; `px` coordinates are absolute screenshot pixels. Named `lockedRegions` and `ignoredRegions` remain useful annotations, but a partial pair is preference-only until at least one reviewed `regionMasks` bounding box is supplied. Once supplied, the frozen evaluator measures both dirty and candidate renders against the clean image inside the declared mask and uses that recovery in fitness and Gate J without treating intentionally changed page regions as defects.

## Import

```bash
gen2prod synth import canonical-spec.json dirty.html \
  --css dirty.css \
  --family generator-model-version \
  --alignment non-1-to-1 \
  --dirty-image dirty-1280.png \
  --clean-image clean-1280.png \
  --clean-html clean.html \
  --clean-css clean.css \
  --strategy content-strategy.md \
  --change-manifest changes.json \
  --viewport 1280 \
  --split holdout
```

The importer preserves the supplied material under `observed/`, writes `fixture.observed-pair.json`, creates an unmarked dirty input with lineage IDs removed, and adds the pair to the frozen corpus fingerprint. Exact observed screenshots participate directly in browser image-diff fitness. Partial pairs with reviewed coordinate masks participate in masked fitness; named-only partial pairs and non-one-to-one pairs remain preference/planner evidence.

## Image-only mockups and live captures

When HTML is unavailable, import the mockup directly:

```bash
gen2prod image import clean-mockup.png \
  --target client-home-v2 \
  --project client-home \
  --dirty-image earlier-render.png \
  --strategy content-strategy.md \
  --split validation \
  --output .gen2prod/image-only/imports/client-home-v2
```

Or acquire a live visual target without exposing its source to the builder:

```bash
gen2prod image capture https://example.com \
  --target example-home \
  --capture-policy visual-probe-sequence \
  --split holdout
```

For a still-image project, the most useful bundle is:

1. Full-page images at desktop, tablet, and mobile widths.
2. The content strategy, page plan, approved copy, and asset inventory.
3. State images for hover, focus, active, expanded/open, loading, error, success, reduced motion, carousel/video states, and any scroll-triggered reveal.
4. A behavior contract naming routes, actions, form endpoints, focus movement, keyboard behavior, timing, and side effects.
5. Optional dirty images and an alignment/change manifest so recovery can be measured rather than guessed.

A still image cannot establish implementation mechanism or behavior. State pairs can prove that pixels change after a declared trigger, but route destinations, side effects, animation timing, responsive rules, and semantics remain unapproved until the matching contract or trace is supplied. See [image-only-loop.md](image-only-loop.md) for the full authority model.

Do not include secrets, private customer data, licensed fonts/assets that cannot be used for evaluation, or credentials embedded in HTML. Replace sensitive content while preserving structure and annotate the substitution.
