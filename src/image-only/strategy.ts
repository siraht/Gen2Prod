import { join } from "node:path";
import { writeJsonAtomic } from "../core/fs.ts";
import { ImageDerivedContentStrategySchema, type ImageDerivedContentStrategy, type ImageOnlyAnalysis, type ImageStateSequenceAnalysis } from "../schemas/image-only.ts";

function pageType(text: string): string {
  const categories = [
    { label: "hospitality or restaurant landing page", pattern: /\b(?:restaurant|menu|dinner|lunch|reservation|chef|cuisine|ingredients)\b/gi },
    { label: "developer tool or web-production product page", pattern: /\b(?:css|wordpress|developer|component|framework|code)\b/gi },
    { label: "financial technology or platform marketing page", pattern: /\b(?:payments|financial|revenue|billing|platform|enterprise)\b/gi },
    { label: "consumer product campaign and catalog page", pattern: /\b(?:iphone|ipad|macbook|airpods|apple watch|laptop|phone|shop|product)\b/gi },
    { label: "creative studio or portfolio page", pattern: /\b(?:studio|design|agency|creative|portfolio|case study)\b/gi },
  ].map((category) => ({ ...category, matches: text.match(category.pattern)?.length ?? 0 }));
  return categories.sort((left, right) => right.matches - left.matches)[0]?.matches ? categories[0]!.label : "visual marketing landing page";
}

function audience(text: string): string {
  if (/\b(?:developer|code|css|wordpress)\b/i.test(text)) return "web developers, designers, or site builders (hypothesis from visible language)";
  if (/\b(?:enterprise|business|revenue|platform)\b/i.test(text)) return "business and product decision-makers (hypothesis from visible language)";
  if (/\b(?:dinner|menu|reservation|restaurant)\b/i.test(text)) return "prospective local diners and event guests (hypothesis from visible language)";
  return "prospective customers evaluating the visible offer (generic semantic prior)";
}

function regionGoal(role: string): string {
  const goals: Record<string, string> = {
    header: "establish identity and expose primary navigation labels",
    navigation: "orient visitors among primary destinations",
    hero: "state the primary promise and establish visual tone",
    "card-grid": "organize repeated benefits, products, proof, or options",
    gallery: "show visual examples or a collection",
    media: "provide image-led evidence or atmosphere",
    "call-to-action": "invite the next conversion step",
    modal: "present an interruptive offer or required decision",
    footer: "close with secondary navigation, trust, and legal information",
    content: "advance the page narrative with supporting information",
    unknown: "requires content and semantic review",
  };
  return goals[role] ?? goals.unknown!;
}

export function deriveImageContentStrategy(analysis: ImageOnlyAnalysis, states?: ImageStateSequenceAnalysis): ImageDerivedContentStrategy {
  const allText = analysis.text.map((item) => item.text).join(" ");
  const actionPattern = /\b(?:buy|book|contact|get started|start|reserve|sign up|learn more|view|shop|try|join|subscribe|download)\b/i;
  const labels = [...new Set(analysis.text.map((item) => item.text.replace(/\s+/g, " ").trim()).filter((value) => actionPattern.test(value) && value.length <= 80))].slice(0, 12);
  const dominant = analysis.palette[0]?.hex ?? "#ffffff";
  const luminance = dominant ? [1, 3, 5].map((index) => Number.parseInt(dominant.slice(index, index + 2), 16)).reduce((sum, value) => sum + value, 0) / (3 * 255) : 1;
  const visualVoice = [luminance < 0.35 ? "dark, high-contrast visual system" : "light, open visual system"];
  if (analysis.regions.filter((region) => region.visualRole === "card-grid").length >= 2) visualVoice.push("modular, card-led information architecture");
  if (analysis.regions.some((region) => region.imageDominance >= 0.5)) visualVoice.push("image-led storytelling");
  if (analysis.dimensions.height / analysis.dimensions.width >= 5) visualVoice.push("long-form progressive narrative");
  const motionAndStateExpectations: ImageDerivedContentStrategy["motionAndStateExpectations"] = (states?.hypotheses ?? []).map((hypothesis) => ({ hypothesis: hypothesis.kind, evidence: hypothesis.evidenceObservationIds.join(", "), safeDefault: hypothesis.safeImplementation, confidence: hypothesis.confidence }));
  if (!motionAndStateExpectations.length) motionAndStateExpectations.push({ hypothesis: "unobserved dynamic behavior", evidence: "no material multi-frame evidence", safeDefault: "preserve semantic focus/hover affordances and reduced-motion support without inventing animation", confidence: 0.35 });
  return ImageDerivedContentStrategySchema.parse({
    schemaVersion: "0.1.0", targetId: analysis.targetId, sourceFrameHash: analysis.sourceFrameHash, provenance: "image-derived-unreviewed",
    pageTypeHypothesis: pageType(allText), audienceHypothesis: audience(allText),
    conversionHypothesis: { labels, interpretation: labels.length ? "visible action-oriented labels suggest one or more conversion paths; destinations and side effects remain unknown" : "no reliable conversion label was extracted; conversion intent remains unresolved", confidence: labels.length ? 0.58 : 0.28 },
    visualVoice,
    contentHierarchy: analysis.regions.map((region) => ({ regionId: region.regionId, visualRole: region.visualRole, goalHypothesis: regionGoal(region.visualRole), visibleMessages: analysis.text.filter((item) => item.bbox.y + item.bbox.height / 2 >= region.bbox.y && item.bbox.y + item.bbox.height / 2 <= region.bbox.y + region.bbox.height).sort((left, right) => right.bbox.height - left.bbox.height).slice(0, 4).map((item) => item.text), confidence: region.confidence })),
    mockupSummary: { dimensions: analysis.dimensions, palette: analysis.palette.map((item) => item.hex), regionCount: analysis.regions.length, imageDominantRegions: analysis.regions.filter((region) => region.imageDominance >= 0.35).length },
    motionAndStateExpectations,
    requiredReview: ["approve OCR transcription and content hierarchy", "supply link destinations and form/action contracts", "approve informative versus decorative image meaning and alt text", "provide mobile/tablet mockups", "capture or specify hover, focus, open, loading, error, carousel, video, and motion states", ...(analysis.quality.targetQualityReviewRequired ? [analysis.quality.reason] : [])],
  });
}

export async function writeImageContentStrategy(analysis: ImageOnlyAnalysis, outputDirectory: string, states?: ImageStateSequenceAnalysis): Promise<ImageDerivedContentStrategy> {
  const strategy = deriveImageContentStrategy(analysis, states);
  await writeJsonAtomic(join(outputDirectory, "image-content-strategy.json"), strategy);
  return strategy;
}
