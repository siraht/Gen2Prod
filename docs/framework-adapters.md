# Framework and CMS output adapters

Gen2Prod keeps one canonical compiler and fans an accepted G2P-NF page out to static HTML/SCSS/CSS, React/JSX, Vue, Svelte, Astro, WordPress, and Bricks. The framework outputs do not re-infer semantics or restyle the page. They serialize the same semantic tree, BEM ownership graph, interaction contracts, metadata, and byte-identical token-governed CSS/SCSS.

## Targets

| Target | Native artifact | Build/render validation | Metadata and behavior |
| --- | --- | --- | --- |
| React | `PageDocument.tsx` plus direct-imported BEM components | Bun JSX build, React server rendering | exported metadata; a client boundary only for an explicit verified interaction |
| Vue | `Page.vue` plus Vue SFC components | Vue SFC compilation and Vue server rendering | `document.ts`; lifecycle runtime only for an explicit verified interaction |
| Svelte | `Page.svelte` plus Svelte components | Svelte server compilation and rendering | native `<svelte:head>`; verified runtime only when required |
| Astro | `Page.astro` plus Astro components | compiler validation and an actual Astro static build | native document head; verified runtime only when required |
| WordPress | block-theme page template/pattern and PHP integration fragments | core-block envelope/stack validation and canonical render | head/enqueue fragments and a lossless vendor-neutral CMS tree |
| Bricks | importable element payload and integration metadata | parent/child, ID, inline-style, and CMS-tree validation | Bricks metadata plus the same lossless CMS tree |

Every target includes `page.scss`, `page.css`, `adapter-manifest.json`, `adapter-validation.json`, a native preview, and—when browser validation is enabled—a canonical capture, adapter capture, and diff PNG.

## Invariants

- Styling remains in shared nested SCSS with class-only BEM selectors. Components contain semantic BEM classes, never emitted utility classes, element styling, CSS-in-JS, scoped-style rewrites, or framework style props.
- ACSS/project custom properties remain the value authority. The adapter validator requires the emitted CSS bytes to match the canonical compiler output.
- Component boundaries follow stable BEM block ownership. They do not invent prop APIs, abstractions, or client state merely to appear framework-native.
- Native metadata surfaces are emitted without dropping the canonical document contract.
- Dynamic code is emitted only from a typed interaction contract. Still images alone cannot authorize routes, side effects, focus movement, animation timing, or a JavaScript mechanism.
- Structural sibling whitespace is explicit in each template dialect so native compilers cannot change inline geometry.

## Validation and promotion

`gen2prod run` emits configured adapters after canonical validation. Each adapter is a critical Gate A assertion: native compilation, native rendering, semantic structure, content/URL/form recall, BEM coverage, token stylesheet preservation, selector safety, and browser image difference must pass. The default hard visual ceiling is 0.1% changed pixels; the frozen dialog and inline-form regression fixtures currently require exact zero-pixel difference across all six targets.

The adapter research loop starts from an intentionally weak page-level/document-metadata policy, changes one policy field at a time, and evaluates actual emitted source. Evaluator and corpus hashes are frozen, requested mutations must change source or quality, mutation controls must retain full recall, and the holdout is opened only after search. Promotion requires search improvement, sealed-holdout non-regression, and exact output-hash replay.

```bash
# Emit the promoted adapters as part of a normal conversion.
gen2prod run page.html --css page.css --adapters react,vue,svelte,astro,wordpress,bricks

# Emit or evaluate from an accepted run/fixture benchmark.
gen2prod adapter emit .gen2prod/runs/<run-id>
gen2prod adapter evaluate --fixtures fixtures/generated/manifest.json --split validation

# Search, audit the sealed holdout, replay, and promote the best policy.
gen2prod adapter research --fixtures fixtures/generated/manifest.json --budget 3 --fresh

# Blend accepted and rejected adapter trials into distillation.
gen2prod distill --adapter .gen2prod/adapters/research/trajectories.jsonl --target all
```

The promoted policy is stored at `.gen2prod/adapters/research/incumbent-policy.json` and is automatically consumed by production runs. Framework/CMS **output** is implemented. Direct ingestion and source-preserving patching of an existing dynamic JSX/SFC/Astro/CMS project remains a separate adapter boundary because conditional branches, application state, router conventions, plugin versions, and destination merge authority cannot be reconstructed from canonical static evidence.
