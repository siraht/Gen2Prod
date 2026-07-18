export type EvaluatorMutation = {
  id: string;
  expectedGate: string;
  apply: (input: { html: string; scss: string; css: string }) => { html: string; scss: string; css: string };
};

export const EVALUATOR_MUTATIONS: EvaluatorMutation[] = [
  { id: "remove-href", expectedGate: "E", apply: (input) => ({ ...input, html: input.html.replace(/(<a\b[^>]*?)\s+href="[^"]+"/, "$1") }) },
  { id: "button-to-div", expectedGate: "E", apply: (input) => {
    if (/<button\b/.test(input.html)) return { ...input, html: input.html.replace("<button", "<div").replace("</button>", "</div>") };
    return { ...input, html: input.html.replace(/<a\b([^>]*class="[^"]*\bbutton\b[^"]*"[^>]*)>/, "<div$1>").replace("</a>", "</div>") };
  } },
  { id: "raw-governed-color", expectedGate: "C", apply: (input) => ({ ...input, scss: `${input.scss}\n.mutation { color: #123456; }`, css: `${input.css}\n.mutation { color: #123456; }` }) },
  { id: "orphan-selector", expectedGate: "B", apply: (input) => ({ ...input, scss: `${input.scss}\n.orphan-component { display: block; }`, css: `${input.css}\n.orphan-component { display: block; }` }) },
  { id: "element-selector", expectedGate: "B", apply: (input) => ({ ...input, scss: `${input.scss}\nbutton { color: var(--primary); }`, css: `${input.css}\nbutton { color: var(--primary); }` }) },
  { id: "flat-bem-element", expectedGate: "B", apply: (input) => ({ ...input, scss: `${input.scss}\n.page__main { display: block; }`, css: `${input.css}\n.page__main { display: block; }` }) },
  { id: "utility-selector", expectedGate: "B", apply: (input) => ({ ...input, scss: `${input.scss}\n.mt-4 { margin-top: var(--space-m); }`, css: `${input.css}\n.mt-4 { margin-top: var(--space-m); }` }) },
  { id: "remove-alt", expectedGate: "E", apply: (input) => ({ ...input, html: input.html.replace(/\s+alt="[^"]*"/, "") }) },
  { id: "inline-event", expectedGate: "D", apply: (input) => ({ ...input, html: input.html.replace("<body", '<body onclick="alert(1)"') }) },
  { id: "leaked-secret", expectedGate: "H", apply: (input) => ({ ...input, html: `${input.html}\n<!-- api_key=sk-abcdefghijklmnopqrstuvwxyz -->` }) },
  { id: "skip-heading-level", expectedGate: "F", apply: (input) => ({ ...input, html: input.html.replace("<h1", "<h3").replace("</h1>", "</h3>") }) },
  { id: "suppress-focus-outline", expectedGate: "E", apply: (input) => ({ ...input, scss: `${input.scss}\n.button:focus { outline: none; }`, css: `${input.css}\n.button:focus { outline: none; }` }) },
  { id: "positive-tabindex", expectedGate: "E", apply: (input) => ({ ...input, html: input.html.replace(/<(a|button)\b/, '<$1 tabindex="7"') }) },
  { id: "duplicate-false-component", expectedGate: "I", apply: (input) => {
    const scssDeclarations = input.scss.match(/\.button(?:--[a-z0-9-]+)?\s*\{([^{}]+)\}/)?.[1] ?? "display: inline-flex;";
    const cssDeclarations = input.css.match(/\.button(?:--[a-z0-9-]+)?\s*\{([^{}]+)\}/)?.[1] ?? "display: inline-flex;";
    return { ...input, html: input.html.replace(/class="([^"]*\bbutton\b[^"]*)"/, 'class="$1 imposter-component"'), scss: `${input.scss}\n.imposter-component {${scssDeclarations}}`, css: `${input.css}\n.imposter-component {${cssDeclarations}}` };
  } },
  { id: "delete-behavior-hook", expectedGate: "E", apply: (input) => ({ ...input, html: input.html.replace(/\s+data-hook="[^"]+"/, "") }) },
];
