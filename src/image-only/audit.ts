import { dirname, join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "../core/fs.ts";
import { ImageOnlyAnalysisSchema, ImageOnlyTargetManifestSchema } from "../schemas/image-only.ts";
import { flatten, parseElements } from "../validation/dom.ts";

const STOPWORDS = new Set("the and for with this that from your you our are was were have has not but all can more into get its their they them will about page home skip content main menu close open copyright privacy terms".split(" "));

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? []).filter((word) => word.length >= 3 && !STOPWORDS.has(word) && !/^https?$/.test(word)));
}

function recall(reference: Set<string>, candidate: Set<string>): number {
  return reference.size ? [...reference].filter((word) => candidate.has(word)).length / reference.size : 1;
}

export type PostBuildSourceAudit = {
  schemaVersion: "0.1.0";
  targetId: string;
  phase: "post-build-only";
  builderInputsChanged: false;
  auditArtifact: string;
  metrics: { auditTokens: number; ocrTokens: number; candidateTokens: number; auditToOcrRecall: number; auditToCandidateRecall: number; ocrToCandidateRecall: number; discoveredLinks: number };
  likelyCaptureIncomplete: boolean;
  findings: string[];
  requiredActions: { id: string; summary: string; detail: string; blocking: boolean }[];
};

export async function auditLiveImageBuild(manifestPathInput: string, buildDirectoryInput: string, outputPath?: string): Promise<PostBuildSourceAudit> {
  const manifestPath = resolve(manifestPathInput);
  const buildDirectory = resolve(buildDirectoryInput);
  const manifest = ImageOnlyTargetManifestSchema.parse(await readJson(manifestPath));
  const auditArtifact = manifest.quarantinedArtifacts.find((artifact) => artifact.kind === "web-extraction" && artifact.permittedUse === "post-build-audit");
  if (!auditArtifact) throw new Error(`No post-build web extraction is declared for ${manifest.targetId}`);
  const audit = await readJson<{ markdown?: string; links?: unknown[] }>(resolve(auditArtifact.path));
  const analysisPath = await Bun.file(join(buildDirectory, "image-analysis.json")).exists() ? join(buildDirectory, "image-analysis.json") : join(dirname(manifestPath), "image-analysis.json");
  const analysis = ImageOnlyAnalysisSchema.parse(await readJson(analysisPath));
  const html = await Bun.file(join(buildDirectory, "page.html")).text();
  const candidateText = flatten(parseElements(html).roots).map((element) => element.text).join(" ");
  const auditTokens = words((audit.markdown ?? "").replace(/https?:\/\/\S+/g, " ").replace(/[\[\]()`*_#!>|-]/g, " "));
  const ocrTokens = words(analysis.text.map((item) => item.text).join(" "));
  const candidateTokens = words(candidateText);
  const auditToOcrRecall = recall(auditTokens, ocrTokens);
  const auditToCandidateRecall = recall(auditTokens, candidateTokens);
  const ocrToCandidateRecall = recall(ocrTokens, candidateTokens);
  const likelyCaptureIncomplete = auditTokens.size >= 20 && auditToOcrRecall < 0.22;
  const findings = [
    `The builder remained image-only; this audit ran after HTML/SCSS emission against quarantined web extraction ${auditArtifact.path}.`,
    `OCR covers ${(auditToOcrRecall * 100).toFixed(1)}% of unique nontrivial audit tokens; candidate markup covers ${(auditToCandidateRecall * 100).toFixed(1)}%.`,
    `Candidate markup preserves ${(ocrToCandidateRecall * 100).toFixed(1)}% of image-observed OCR tokens.`,
    `${audit.links?.length ?? 0} link records are available for later authority review but were not exposed to the image-only builder.`,
  ];
  const requiredActions = [
    { id: "approve-visible-transcription", summary: "Review image-derived transcription", detail: "Approve/correct visible OCR content before treating it as production copy.", blocking: false },
    { id: "supply-route-contract", summary: "Supply destinations and action contracts", detail: `${audit.links?.length ?? 0} live link records exist in quarantine; explicitly approve which routes/actions belong in the clean build.`, blocking: false },
    ...(likelyCaptureIncomplete ? [{ id: "recapture-incomplete-page", summary: "Recapture likely unmaterialized page content", detail: `Only ${(auditToOcrRecall * 100).toFixed(1)}% of audit vocabulary appeared in the captured image. Use scroll-materialized/alternate-browser frames or confirm that the audit contains hidden/non-home content.`, blocking: false }] : []),
  ];
  const result: PostBuildSourceAudit = { schemaVersion: "0.1.0", targetId: manifest.targetId, phase: "post-build-only", builderInputsChanged: false, auditArtifact: auditArtifact.path, metrics: { auditTokens: auditTokens.size, ocrTokens: ocrTokens.size, candidateTokens: candidateTokens.size, auditToOcrRecall, auditToCandidateRecall, ocrToCandidateRecall, discoveredLinks: audit.links?.length ?? 0 }, likelyCaptureIncomplete, findings, requiredActions };
  await writeJsonAtomic(outputPath ?? join(buildDirectory, "post-build-source-audit.json"), result);
  return result;
}
