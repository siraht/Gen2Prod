import { ImageOnlyBuildPlanSchema, type ImageOnlyAnalysis, type ImageOnlyBuildPlan, type InteractionHypothesis } from "../schemas/image-only.ts";

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[|]{2,}/g, " ").trim();
}

function regionText(analysis: ImageOnlyAnalysis, region: ImageOnlyAnalysis["regions"][number]) {
  return analysis.text.filter((item) => {
    const middle = item.bbox.y + item.bbox.height / 2;
    return middle >= region.bbox.y && middle <= region.bbox.y + region.bbox.height;
  }).filter((item) => item.confidence >= 0.35 && normalizedText(item.text).length >= 2);
}

function roleContract(role: ImageOnlyAnalysis["regions"][number]["visualRole"]): { tag: ImageOnlyBuildPlan["regions"][number]["tag"]; block: string } {
  switch (role) {
    case "header": return { tag: "header", block: "site-header" };
    case "navigation": return { tag: "nav", block: "site-navigation" };
    case "hero": return { tag: "section", block: "hero" };
    case "card-grid": return { tag: "section", block: "card-grid" };
    case "gallery": return { tag: "section", block: "media-gallery" };
    case "media": return { tag: "figure", block: "media-panel" };
    case "call-to-action": return { tag: "section", block: "call-to-action" };
    case "modal": return { tag: "aside", block: "dialog-panel" };
    case "footer": return { tag: "footer", block: "site-footer" };
    default: return { tag: "section", block: "content-section" };
  }
}

function interactionForRegion(region: ImageOnlyAnalysis["regions"][number], text: ReturnType<typeof regionText>): InteractionHypothesis[] {
  const hypotheses: InteractionHypothesis[] = [];
  const lower = text.map((item) => item.text).join(" ").toLowerCase();
  if (region.visualRole === "header" || region.visualRole === "navigation") hypotheses.push({
    hypothesisId: `${region.regionId}-navigation`, regionId: region.regionId, semanticKind: "navigation", evidenceTier: "semantic-affordance", confidence: 0.62,
    cues: ["top-of-page grouped labels", `region-role:${region.visualRole}`], safeStates: ["hover", "focus-visible"],
    prohibitedClaims: ["link destinations", "mobile menu mechanics", "dropdown behavior"],
    verification: { required: true, actions: ["Provide or actively probe navigation destinations", "Capture mobile navigation open and closed states"] },
  });
  if (region.visualRole === "call-to-action" || /\b(?:buy|book|contact|get started|start|reserve|sign up|learn more|view|shop)\b/.test(lower)) hypotheses.push({
    hypothesisId: `${region.regionId}-action`, regionId: region.regionId, semanticKind: "link", evidenceTier: region.visualRole === "call-to-action" ? "observed-static-cue" : "semantic-affordance", confidence: region.visualRole === "call-to-action" ? 0.72 : 0.54,
    cues: ["short action-oriented visible label"], safeStates: ["hover", "focus-visible", "active"],
    prohibitedClaims: ["destination", "submission side effect", "analytics event"],
    verification: { required: true, actions: ["Confirm whether the control navigates or performs an in-page action", "Supply the destination or action contract"] },
  });
  if (region.visualRole === "modal") hypotheses.push({
    hypothesisId: `${region.regionId}-dialog`, regionId: region.regionId, semanticKind: "dialog", evidenceTier: "observed-static-cue", confidence: 0.76,
    cues: ["layered panel interrupts page composition"], safeStates: ["focus-visible", "open"],
    prohibitedClaims: ["open trigger", "dismiss mechanics", "focus return target", "persistence rules"],
    verification: { required: true, actions: ["Capture the triggering and dismissed states", "Verify focus trap, Escape dismissal, and focus return"] },
  });
  if (region.visualRole === "gallery") hypotheses.push({
    hypothesisId: `${region.regionId}-gallery`, regionId: region.regionId, semanticKind: "carousel", evidenceTier: "convention-prior", confidence: 0.31,
    cues: ["repeated image-dominant horizontal region"], safeStates: ["focus-visible", "reduced-motion"],
    prohibitedClaims: ["carousel existence", "autoplay", "slide count", "swipe or arrow behavior"],
    verification: { required: true, actions: ["Provide multiple time/state frames or actively probe the region", "If animated, specify reduced-motion behavior"] },
  });
  return hypotheses;
}

export function planImageOnlyBuild(analysis: ImageOnlyAnalysis): ImageOnlyBuildPlan {
  const plannedRegions = analysis.regions.map((region) => {
    const contract = roleContract(region.visualRole);
    const text = regionText(analysis, region);
    const candidates = [...text].sort((left, right) => right.bbox.height - left.bbox.height || left.bbox.y - right.bbox.y);
    const headingCandidate = ["header", "footer", "media"].includes(region.visualRole) ? undefined : candidates[0];
    const heading = headingCandidate ? normalizedText(headingCandidate.text) : undefined;
    const copy = text.filter((item) => item !== headingCandidate).map((item) => normalizedText(item.text)).filter(Boolean).slice(0, 48);
    return { regionId: region.regionId, tag: contract.tag, block: contract.block, ...(heading ? { heading } : {}), copy, bbox: region.bbox, confidence: Math.min(region.confidence, headingCandidate?.confidence ?? region.confidence) };
  });
  const interactions = analysis.regions.flatMap((region) => interactionForRegion(region, regionText(analysis, region)));
  return ImageOnlyBuildPlanSchema.parse({
    schemaVersion: "0.1.0",
    targetId: analysis.targetId,
    sourceFrameHash: analysis.sourceFrameHash,
    strategy: {
      pageType: analysis.regions.some((region) => region.visualRole === "hero") ? "visual marketing landing page" : "image-derived web page",
      visualNarrative: analysis.regions.map((region) => region.visualRole).filter((role, index, values) => role !== "unknown" && role !== values[index - 1]).join(" → ") || "unresolved visual narrative",
      sectionOrder: analysis.regions.map((region) => region.regionId),
      confidence: analysis.text.length > 0 ? 0.58 : 0.41,
      provenance: "image-derived",
    },
    regions: plannedRegions,
    interactions,
    unresolved: [
      { concern: "visible-text-authority", reason: "OCR or vision transcription from pixels is advisory until reviewed", requiredEvidence: ["reviewed content strategy or approved transcription"] },
      { concern: "destinations-and-side-effects", reason: "a still image does not encode URLs, form endpoints, or click side effects", requiredEvidence: ["source behavior contract or active interaction trace"] },
      { concern: "dynamic-states", reason: "hover, focus, open, loading, error, autoplay, and animation timing are not proven by one still", requiredEvidence: ["state image sequence or active visual probes"] },
      { concern: "responsive-rules", reason: "one viewport does not determine breakpoints, reflow, or mobile interaction patterns", requiredEvidence: ["approved images at additional viewports"] },
      { concern: "asset-meaning", reason: "pixels do not prove informative image alt text or decorative intent", requiredEvidence: ["content/asset inventory review"] },
    ],
    provenance: { allowedInputHashes: [analysis.sourceFrameHash], usedQuarantinedArtifacts: false },
  });
}
