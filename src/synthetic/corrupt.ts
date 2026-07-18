import { sha256 } from "../core/hash.ts";
import { Prng } from "./prng.ts";
import type { CanonicalPageSpec, CorruptionOperation, CorruptionTrace } from "./types.ts";

export type CorruptedFixture = {
  html: string;
  css: string;
  trace: CorruptionTrace;
  correspondence: { goldNodeId: string; corruptedNodeId: string; confidence: number; lineage: string }[];
};

type Mutable = { html: string; css: string; operations: CorruptionOperation[] };

function operation(kind: CorruptionOperation["kind"], before: string, after: string, targetNodeIds: string[], expectedGateFailures: string[]): CorruptionOperation {
  return { id: `${kind}-${sha256(`${before}:${after}`).slice(0, 8)}`, kind, targetNodeIds, before, after, reversible: true, expectedGateFailures };
}

function semanticErasure(state: Mutable): void {
  const tags = ["main", "section", "article", "nav", "header", "footer", "figure", "figcaption", "blockquote", "ul", "li"];
  const before = state.html;
  let after = before;
  for (const tag of tags) after = after.replaceAll(new RegExp(`<${tag}(?=[ >])`, "g"), "<div").replaceAll(`</${tag}>`, "</div>");
  if (after !== before) {
    state.html = after;
    state.operations.push(operation("semantic-erasure", "semantic elements", "generic div elements", ["main"], ["E", "F"]));
  }
}

function structuralNoise(state: Mutable): void {
  const pattern = /(<div[^>]*data-g2p-node="([^"]+)"[^>]*>)/;
  const match = state.html.match(pattern);
  if (!match?.[1] || !match[2]) return;
  state.html = state.html.replace(match[1], `<div class="wrapper-${match[2]}" data-g2p-wrapper-for="${match[2]}">${match[1]}`).replace(`</body>`, `</div>\n</body>`);
  state.operations.push(operation("structural-noise", match[1], `wrapper + ${match[1]}`, [match[2]], ["B"]));
}

function classDegradation(state: Mutable): void {
  const classNames = new Set([...state.html.matchAll(/class="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/)).filter(Boolean));
  const mapping = new Map([...classNames].map((name, index) => [name, `u-${index + 1}`]));
  const before = [...classNames].join(" ");
  state.html = state.html.replace(/class="([^"]+)"/g, (_, names: string) => {
    const values = names.split(/\s+/);
    const modifiers = values.filter((name) => name.includes("--"));
    return `class="${values.map((name) => mapping.get(name) ?? name).join(" ")}"${modifiers.length ? ` data-g2p-variants="${modifiers.join(" ")}"` : ""}`;
  });
  // Replace complete selector class tokens. Prefix replacement corrupts BEM
  // families (`.hero` would turn `.hero__inner` into `.u-2__inner`) and makes
  // the generated dirty HTML/CSS pair internally inconsistent.
  for (const [from, to] of mapping) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    state.css = state.css.replace(new RegExp(`\\.${escaped}(?![\\w-])`, "g"), `.${to}`);
  }
  state.operations.push(operation("class-degradation", before, [...mapping.values()].join(" "), [], ["B"]));
}

function styleLowering(state: Mutable): void {
  const before = state.css;
  state.css = state.css.replace(/var\(--space-m\)/g, "16px").replace(/var\(--space-s\)/g, "12px");
  if (state.css !== before) state.operations.push(operation("style-lowering", "registered spacing tokens", "raw pixel values", [], ["C"]));
}

function designDrift(state: Mutable, prng: Prng): void {
  const rawValues = [...state.css.matchAll(/\b(12|16|32|48|80)px\b/g)];
  if (rawValues.length === 0) return;
  const original = prng.pick(rawValues)[0];
  const drifted = `${Number.parseInt(original, 10) + prng.pick([-3, -1, 1, 2, 3])}px`;
  state.css = state.css.replace(original, drifted);
  state.operations.push(operation("design-drift", original, drifted, [], ["C", "J"]));
}

function componentCorruption(state: Mutable): void {
  const match = state.html.match(/class="([^"]*(?:card|hero|faq|pricing)[^"]*)"/);
  if (!match?.[0] || !match[1]) return;
  const renamed = match[1].split(/\s+/).map((name) => name.includes("card") ? `visual-box-${sha256(name).slice(0, 4)}` : name).join(" ");
  state.html = state.html.replace(match[0], `class="${renamed}"`);
  state.operations.push(operation("component-corruption", match[1], renamed, [], ["B", "I"]));
}

function behaviorCorruption(state: Mutable): void {
  const anchor = state.html.match(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>/);
  if (anchor?.[0]) {
    const after = anchor[0].replace(/\s+href="([^"]+)"/, ' data-g2p-destination="$1"');
    state.html = state.html.replace(anchor[0], after);
    state.operations.push(operation("behavior-corruption", anchor[0], after, [], ["E", "H"]));
    return;
  }
  const type = state.html.match(/ type="submit"/);
  if (type?.[0]) {
    state.html = state.html.replace(type[0], "");
    state.operations.push(operation("behavior-corruption", type[0], "button type removed", [], ["E"]));
  }
}

function accessibilityCorruption(state: Mutable): void {
  const alt = state.html.match(/ alt="([^"]*)"/);
  if (alt?.[0]) {
    state.html = state.html.replace(alt[0], "");
    state.operations.push(operation("accessibility-corruption", alt[0], "alt removed", [], ["E"]));
    return;
  }
  const label = state.html.match(/<label[^>]*data-g2p-node="([^"]+)"[^>]*>.*?<\/label>/s);
  if (label?.[0]) {
    state.html = state.html.replace(label[0], "");
    state.operations.push(operation("accessibility-corruption", label[0], "label removed", label[1] ? [label[1]] : [], ["E"]));
  }
}

const CORRUPTORS = { semanticErasure, structuralNoise, classDegradation, styleLowering, designDrift, componentCorruption, behaviorCorruption, accessibilityCorruption };
export type CorruptorName = keyof typeof CORRUPTORS;

export function corruptFixture(spec: CanonicalPageSpec, gold: { html: string; css: string }, seed: number, selected?: CorruptorName[]): CorruptedFixture {
  const prng = new Prng(seed);
  const pool = selected ?? prng.shuffle(Object.keys(CORRUPTORS) as CorruptorName[]).slice(0, prng.integer(2, 5));
  const state: Mutable = { html: gold.html.replace('href="gold.css"', 'href="corrupted.css"'), css: gold.css, operations: [] };
  for (const name of pool) {
    if (name === "designDrift") CORRUPTORS[name](state, prng);
    else CORRUPTORS[name](state);
  }
  const nodeIds = [...gold.html.matchAll(/data-g2p-node="([^"]+)"/g)].flatMap((match) => match[1] ? [match[1]] : []);
  return {
    html: state.html,
    css: state.css,
    trace: { schemaVersion: "0.1.0", fixtureId: spec.id, seed, difficulty: state.operations.length <= 2 ? "easy" : state.operations.length <= 4 ? "medium" : "hard", operations: state.operations },
    correspondence: nodeIds.map((nodeId) => ({ goldNodeId: nodeId, corruptedNodeId: nodeId, confidence: 1, lineage: "preserved data-g2p-node" })),
  };
}
