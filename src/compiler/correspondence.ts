import type { DomNode } from "../schemas/normal-form.ts";
import type { NodeCorrespondence, PlannedNode } from "./types.ts";

function sourceNodes(root: DomNode): DomNode[] {
  return [root, ...root.children.flatMap(sourceNodes)];
}

function targetNodes(root: PlannedNode): PlannedNode[] {
  return [root, ...root.children.flatMap(targetNodes)];
}

export function matchPlannedNodes(sourceRoot: DomNode, targetRoot: PlannedNode): NodeCorrespondence[] {
  const source = sourceNodes(sourceRoot);
  const target = targetNodes(targetRoot);
  const used = new Set<string>();
  return source.map((node): NodeCorrespondence => {
    const exact = target.find((candidate) => candidate.nodeId === node.nodeId && !used.has(candidate.nodeId));
    if (exact) {
      used.add(exact.nodeId);
      return { sourceNodeId: node.nodeId, targetNodeId: exact.nodeId, score: 1, confidence: "high", signals: ["stable data/source lineage"], event: "one-to-one" };
    }
    const candidates = target.filter((candidate) => !used.has(candidate.nodeId)).map((candidate) => {
      const signals: string[] = [];
      let score = 0;
      if (candidate.text.trim() && candidate.text.trim() === node.text.trim()) { score += 0.45; signals.push("text fingerprint"); }
      if (candidate.originalTag === node.tag) { score += 0.2; signals.push("original tag"); }
      const href = node.attributes.find((attribute) => attribute.name === "href")?.value;
      if (href && candidate.attributes.href === href) { score += 0.25; signals.push("href"); }
      return { candidate, score, signals };
    }).sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best || best.score < 0.4) return { sourceNodeId: node.nodeId, targetNodeId: "", score: 0, confidence: "low", signals: [], event: "unresolved" };
    used.add(best.candidate.nodeId);
    return { sourceNodeId: node.nodeId, targetNodeId: best.candidate.nodeId, score: best.score, confidence: best.score >= 0.8 ? "high" : "medium", signals: best.signals, event: "one-to-one" };
  });
}

export function correspondenceCoverage(matches: NodeCorrespondence[]): number {
  return matches.length === 0 ? 1 : matches.filter((match) => match.event !== "unresolved").length / matches.length;
}
