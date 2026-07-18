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
| `partial` | Some regions changed intentionally | Region-scoped supervision; locked and ignored regions must be declared before it becomes a hard target |
| `non-1-to-1` | Redesign, copy revision, changed sections, or an evolved implementation | Preference/planner supervision; no false exact-pixel failure is assigned |

Non-one-to-one examples still teach content-to-section planning, semantic choices, component boundaries, token usage, acceptable edits, and which output a reviewer preferred. If the source and result share only part of the page, name the shared or locked regions.

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
  "notes": "Screenshots captured in Chrome at 1280px with project fonts loaded."
}
```

Region names are initially annotations. Partial pairs remain non-hard supervision until their masks or bounding boxes have been reviewed.

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

The importer preserves the supplied material under `observed/`, writes `fixture.observed-pair.json`, creates an unmarked dirty input with lineage IDs removed, and adds the pair to the frozen corpus fingerprint. Exact observed screenshots participate directly in browser image-diff fitness. Partial and non-one-to-one pairs are retained for region and preference learning.

Do not include secrets, private customer data, licensed fonts/assets that cannot be used for evaluation, or credentials embedded in HTML. Replace sensitive content while preserving structure and annotate the substitution.
