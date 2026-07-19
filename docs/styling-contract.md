# Gen2Prod styling contract

This contract applies to every clean stylesheet emitted by dirty-HTML compilation, greenfield generation, synthetic gold generation, image-only reconstruction, convergence, and research candidates. Dirty inputs and evaluator mutations may violate it; accepted output may not.

## Selector architecture

- `:root` exists only as the runtime token registry. It may contain custom-property declarations and no document styling.
- Each top-level SCSS component rule is one kebab-case BEM block: `.block-name { ... }`.
- Elements, modifiers, pseudo-elements, and interactive states are authored inside their owner with Sass nesting: `&__element`, `&__element--modifier`, `&--modifier`, `&:hover`, and `&::before`.
- Compiled styling selectors must be class-only BEM selectors. Element, universal, ID, attribute, descendant, child, sibling, tag-qualified, cross-block, and utility selectors are hard failures.
- The supported class grammar is one block, at most one element, and at most one modifier. Multiple BEM classes may be mixed on one HTML node, but generated CSS does not couple those classes in a combined selector.
- Generated markup contains no Tailwind or ACSS utility classes. The imported ACSS class catalog is used to recognize and remove dirty framework classes; it is not an emission catalog.

This is intentionally stricter than allowing global reset selectors. Dirty `html`, `body`, `:host`, and `:root` document foundations are cascade-resolved onto the semantic `.page` block. Universal source foundations are lowered onto every generated primary BEM class because non-inherited properties such as `box-sizing` must retain their geometry without emitting `*`. The output does not style document elements directly.

## Values and tokens

- Every governed color, spacing, typography, border, radius, shadow, opacity, z-index, focus, and motion declaration has 100% direct `var(--token)` coverage.
- ACSS/project tokens are registered at `:root`, and every runtime reference must resolve through that registry.
- A component-local custom property is allowed only as a direct alias to a registered root token. Raw local values and dangling references fail Gate C.
- If dirty source contains a governed value with no compatible approved ACSS/project token, the compiler registers an exact `--g2p-*` experimental project alias and emits that variable. The run continues and records a `source-token-role-review` action; raw governed CSS is not emitted.
- Image-observed geometry and visual calibration values use registered `--g2p-image-*` project extensions or reviewed ACSS overrides in `acss-image-bindings.json`. Their semantic roles remain `image-derived-unreviewed` until approved.
- Sass variables are used for authoring-time values that CSS custom properties cannot represent reliably, such as media-query breakpoints.
- Structural CSS values are not disguised as design tokens. Keywords and constraints such as `grid`, `flex`, `auto`, `none`, `solid`, `1fr`, `100%`, and reset `0` remain structural when they do not encode a design decision.

## Enforcement

Gate B parses both SCSS and compiled CSS. It rejects non-class selectors, invalid BEM, utility selectors, cross-block coupling, top-level element/modifier/state rules, excessive specificity, and orphan selectors.

Gate C requires direct token coverage, complete runtime reference resolution, registered component aliases, no raw governed values, and no `!important`. The same analyzers run inside the image builder before artifacts are written and again in image evaluation.

The frozen verifier injects element selectors, flat BEM rules, utility selectors, unregistered variables, raw governed values, and other independent defects. All mutations must still be caught after every policy or compiler change.

Run the contract against any emitted page or run directory:

```bash
bun run cli -- validate path/to/output
```

The machine-readable report exposes selector and token metrics including `elementSelectors`, `universalSelectors`, `combinatorSelectors`, `flatBemRules`, `directTokenCoverage`, `unresolvedTokenReferences`, and `invalidLocalTokenDefinitions`.
