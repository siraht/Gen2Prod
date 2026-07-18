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
  { id: "remove-alt", expectedGate: "E", apply: (input) => ({ ...input, html: input.html.replace(/\s+alt="[^"]*"/, "") }) },
  { id: "inline-event", expectedGate: "D", apply: (input) => ({ ...input, html: input.html.replace("<body", '<body onclick="alert(1)"') }) },
  { id: "leaked-secret", expectedGate: "H", apply: (input) => ({ ...input, html: `${input.html}\n<!-- api_key=sk-abcdefghijklmnopqrstuvwxyz -->` }) },
];
