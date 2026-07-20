import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCanonicalGraph, canonicalize, sha256, type CanonicalGraphRuntime, type DesignCandidate } from "@website-ontology/contracts";
import { canonicalJson } from "../src/core/hash.ts";

const RESERVE_BYTES = 20 * 1024 ** 3;
const LIGHTHOUSE_VERSION = "13.4.1";
const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/sitespec-v2-campaign.ts <external-evidence-directory>");

type CommandRecord = { id: string; command: string[]; exitCode: number; stdout: string; stderr: string; startedAt: string; finishedAt: string };
const records: CommandRecord[] = [];

async function freeBytes(): Promise<number> {
  const output = await Bun.$`df -B1 --output=avail ${root}`.text();
  return Number(output.trim().split(/\s+/).at(-1));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, canonicalJson(value), "utf8");
}

async function run(id: string, args: string[], allowed = [0]): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const child = Bun.spawn(args, { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const record = { id, command: args, exitCode, stdout, stderr, startedAt, finishedAt: new Date().toISOString() };
  records.push(record);
  await writeJson(join(root, "commands", `${String(records.length).padStart(2, "0")}-${id}.json`), record);
  if (!allowed.includes(exitCode)) throw new Error(`${id} exited ${exitCode}: ${stderr || stdout}`);
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) return {};
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return { output: stdout.trim() }; }
}

async function cli(id: string, args: string[], allowed = [0]): Promise<Record<string, unknown>> {
  return run(id, ["bun", "src/cli.ts", "--json", "--no-input", ...args], allowed);
}

function artifact(graph: CanonicalGraphRuntime) {
  return { artifactType: "canonical-site-spec", schemaVersion: graph.schemaVersion, revision: graph.revision, spec: graph };
}

function rebuild(graph: CanonicalGraphRuntime, update: (entity: Omit<CanonicalGraphRuntime["entities"][number], "revision">) => void): CanonicalGraphRuntime {
  return buildCanonicalGraph({ schemaVersion: graph.schemaVersion, kind: graph.kind, id: graph.id, uid: graph.uid, rootRefs: graph.rootRefs, entities: graph.entities.map(({ revision: _revision, ...entity }) => { const next = structuredClone(entity); update(next); return next; }) });
}

async function fileArtifact(id: string, path: string, mediaType: string) {
  const contents = new Uint8Array(await readFile(path));
  const hash = sha256(contents);
  return { schemaVersion: "website-ontology-artifacts/2.0" as const, kind: "artifact-ref" as const, id, hash, uri: pathToFileURL(path).href, mediaType, byteLength: contents.byteLength };
}

async function candidate(id: string, graph: CanonicalGraphRuntime, screenshot: string, sourceFile?: string): Promise<DesignCandidate> {
  const page = graph.entities.find((entity) => entity.uid === "sitespec://northstar/pages/home")!;
  return {
    schemaVersion: "website-ontology-artifacts/2.0",
    kind: "design-candidate",
    id,
    pageSubjectRef: page.uid,
    specRevision: page.revision,
    promptHash: sha256(canonicalize({ campaign: "phase4", id, page: page.revision })),
    tool: "gen2prod-phase4-qualification",
    providerRunRef: `qualification://runs/${id}`,
    viewport: { width: 1280, height: 1000, deviceScaleFactor: 1 },
    authority: { content: "none", visual: "advisory" },
    sourceFiles: sourceFile ? [await fileArtifact(`${id}-source`, sourceFile, "text/html")] : [],
    screenshots: [await fileArtifact(`${id}-screenshot`, screenshot, "image/png")],
    generatedAt: "2026-07-20T00:00:00.000Z",
    regions: [{ id: "hero", subjectRef: "sitespec://northstar/pages/home/sections/hero.1", authority: { content: "none", visual: "advisory" } }],
  };
}

async function lighthouse(id: string, runDirectory: string): Promise<string> {
  const reportPath = join(root, "lighthouse", `${id}.json`);
  await mkdir(resolve(reportPath, ".."), { recursive: true });
  const port = 44000 + records.length;
  const server = Bun.spawn(["python3", "-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: runDirectory, stdout: "pipe", stderr: "pipe" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { const response = await fetch(`http://127.0.0.1:${port}/page.html`); if (response.ok) { ready = true; break; } } catch { /* retry bounded local readiness */ }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error(`Local Lighthouse server did not become ready on ${port}`);
    await run(`lighthouse-${id}`, ["npx", "--yes", `lighthouse@${LIGHTHOUSE_VERSION}`, `http://127.0.0.1:${port}/page.html`, "--output=json", `--output-path=${reportPath}`, "--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage", "--quiet"]);
  } finally {
    server.kill();
    await server.exited;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as { categories: { performance: { score: number } } };
  if (report.categories.performance.score * 100 < 90) throw new Error(`${id} Lighthouse performance ${report.categories.performance.score * 100} is below 90`);
  return reportPath;
}

await mkdir(root, { recursive: true });
const freeAtStart = await freeBytes();
if (freeAtStart < RESERVE_BYTES) throw new Error(`Disk reserve preflight failed: ${freeAtStart} < ${RESERVE_BYTES}`);
const repositoryStatusBefore = await Bun.$`git status --porcelain=v1`.cwd(resolve(import.meta.dir, "..")).text();
const repositoryHead = (await Bun.$`git rev-parse HEAD`.cwd(resolve(import.meta.dir, "..")).text()).trim();

const referencePath = new URL(import.meta.resolve("@website-ontology/contracts/fixtures/valid/reference-canonical-graph.json"));
const reference = await Bun.file(referencePath).json() as CanonicalGraphRuntime;
const qualificationAsset = join(root, "inputs", "approved-hero.png");
await mkdir(resolve(qualificationAsset, ".."), { recursive: true });
await Bun.write(qualificationAsset, Bun.file(resolve(import.meta.dir, "..", "fixtures/generated/hero-cta/visual/gold/capture-1280-light-default.png")));
const graph = rebuild(reference, (entity) => {
  if (entity.uid === "sitespec://northstar/actions/assessment-form") { entity.authority = { ...entity.authority, state: "approved", assertedBy: "qualification-owner", scope: "semantic-content" }; entity.data = { ...entity.data, destinationRef: "sitespec://northstar/pages/contact" }; delete entity.data.unresolvedBehavior; }
  if (entity.uid === "sitespec://northstar/assets/hero-home") entity.data = { ...entity.data, source: pathToFileURL(qualificationAsset).href, mediaType: "image/png" };
});
const specPath = join(root, "inputs", "approved-site.json");
await writeJson(specPath, artifact(graph));

const bootstrapCandidatePath = join(root, "inputs", "bootstrap-candidate.json");
await writeJson(bootstrapCandidatePath, await candidate("home-bootstrap", graph, qualificationAsset));
await cli("bootstrap-import", ["design", "import-candidate", bootstrapCandidatePath, "--spec", specPath, "--output", join(root, "bootstrap", "verification.json")]);
const bootstrapTargetPath = join(root, "bootstrap", "visual-target.json");
await cli("bootstrap-approve", ["design", "approve-target", bootstrapCandidatePath, "--spec", specPath, "--approval", "qualification://approvals/bootstrap-visual", "--output", bootstrapTargetPath]);
const bootstrapSystemRoot = join(root, "bootstrap", "design-system");
const bootstrapProposal = await cli("bootstrap-propose", ["design-system", "propose", "--spec", specPath, "--visual-target", bootstrapTargetPath, "--release-version", "2.0.0-bootstrap.1", "--output", bootstrapSystemRoot]);
const bootstrapReleasePath = String((bootstrapProposal.data as Record<string, unknown>).releasePath);
const bootstrapBuild = await cli("bootstrap-anchor-build", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/home", "--design-system", bootstrapReleasePath, "--release-validation", "--output", join(root, "bootstrap", "production")], [3]);
const bootstrapRun = String((bootstrapBuild.data as Record<string, unknown>).runDirectory);
const bootstrapCapture = await cli("bootstrap-anchor-capture", ["evidence", "capture", bootstrapRun, "--spec", specPath, "--visual-target", bootstrapTargetPath, "--viewport", "1280", "--height", "1000", "--threshold", "1", "--output", join(bootstrapRun, "bootstrap-browser-results.json")], [3]);
const refinedScreenshot = String((bootstrapCapture.data as Record<string, unknown>).screenshotPath);

const finalCandidatePath = join(root, "inputs", "refined-candidate.json");
await writeJson(finalCandidatePath, await candidate("home-refined", graph, refinedScreenshot, join(bootstrapRun, "page.html")));
await cli("refined-import", ["design", "import-candidate", finalCandidatePath, "--spec", specPath, "--output", join(root, "final", "candidate-verification.json")]);
const finalTargetPath = join(root, "final", "visual-target.json");
await cli("refined-approve", ["design", "approve-target", finalCandidatePath, "--spec", specPath, "--approval", "qualification://approvals/refined-anchor-visual", "--output", finalTargetPath]);
const designSystemRoot = join(root, "final", "design-system");
const proposed = await cli("final-propose", ["design-system", "propose", "--spec", specPath, "--visual-target", finalTargetPath, "--release-version", "2.0.0-rc.1", "--output", designSystemRoot]);
const proposalPath = String((proposed.data as Record<string, unknown>).releasePath);

const validationBuild = await cli("validation-build", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/assessment", "--design-system", proposalPath, "--release-validation", "--output", join(root, "final", "production")], [3]);
const validationRun = String((validationBuild.data as Record<string, unknown>).runDirectory);
const validationLighthouse = await lighthouse("validation", validationRun);
const validationResultsPath = join(validationRun, "accepted-results.json");
await cli("validation-evidence", ["evidence", "record", validationRun, "--spec", specPath, "--lighthouse", validationLighthouse, "--visual-waiver", "qualification://approvals/validation-page-no-visual-target", "--output", validationResultsPath]);
const approved = await cli("release-approval", ["design-system", "validate", "--spec", specPath, "--proposal", proposalPath, "--page", "sitespec://northstar/pages/assessment", "--results", validationResultsPath, "--approval", "qualification://approvals/design-system-2.0.0", "--release-version", "2.0.0", "--output", designSystemRoot]);
const approvedReleasePath = String((approved.data as Record<string, unknown>).releasePath);

const anchorBuild = await cli("anchor-build", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/home", "--design-system", approvedReleasePath, "--output", join(root, "final", "production")], [3]);
const anchorRun = String((anchorBuild.data as Record<string, unknown>).runDirectory);
const anchorBrowserResults = join(anchorRun, "browser-results.json");
await cli("anchor-browser-evidence", ["evidence", "capture", anchorRun, "--spec", specPath, "--visual-target", finalTargetPath, "--viewport", "1280", "--height", "1000", "--threshold", "0.001", "--output", anchorBrowserResults]);
const anchorLighthouse = await lighthouse("anchor", anchorRun);
const anchorAcceptedResults = join(anchorRun, "accepted-results.json");
await cli("anchor-performance-evidence", ["evidence", "record", anchorRun, "--spec", specPath, "--results", anchorBrowserResults, "--lighthouse", anchorLighthouse, "--output", anchorAcceptedResults]);

const contactBuild = await cli("contact-build", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/contact", "--design-system", approvedReleasePath, "--output", join(root, "final", "production")], [3]);
const contactRun = String((contactBuild.data as Record<string, unknown>).runDirectory);
const contactLighthouse = await lighthouse("contact", contactRun);
const contactAcceptedResults = join(contactRun, "accepted-results.json");
await cli("contact-evidence", ["evidence", "record", contactRun, "--spec", specPath, "--lighthouse", contactLighthouse, "--visual-waiver", "qualification://approvals/contact-page-no-visual-target", "--output", contactAcceptedResults]);

const rollout = await cli("site-rollout", ["rollout", "--spec", specPath, "--design-system", approvedReleasePath, "--output", join(root, "final", "rollout")], [3]);
const repeatBuild = await cli("anchor-repeat", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/home", "--design-system", approvedReleasePath, "--output", join(root, "final", "production")], [3]);
if ((repeatBuild.data as Record<string, unknown>).runId !== (anchorBuild.data as Record<string, unknown>).runId) throw new Error("Unchanged anchor build was not idempotent");

const staleGraph = rebuild(graph, (entity) => { if (entity.uid === "sitespec://northstar/pages/home/sections/hero.1/slots/heading") entity.data.content = { kind: "heading", text: "Changed current heading", level: 1 }; });
const staleSpecPath = join(root, "negative", "stale-site.json");
await writeJson(staleSpecPath, artifact(staleGraph));
await cli("reject-stale-target", ["design-system", "propose", "--spec", staleSpecPath, "--visual-target", finalTargetPath, "--release-version", "2.0.1-rc.1", "--output", join(root, "negative", "stale-system")], [1]);
const unsupportedPath = join(root, "negative", "unsupported-site.json");
await writeJson(unsupportedPath, { ...artifact(graph), schemaVersion: "website-ontology/1.0" });
await cli("reject-unsupported-contract", ["build", "--spec", unsupportedPath, "--page", "sitespec://northstar/pages/home", "--design-system", approvedReleasePath, "--output", join(root, "negative", "unsupported")], [1]);

const unavailableAsset = `${qualificationAsset}.unavailable`;
await rename(qualificationAsset, unavailableAsset);
try { await cli("reject-broken-asset", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/home", "--design-system", approvedReleasePath, "--output", join(root, "negative", "broken-asset")], [1]); }
finally { await rename(unavailableAsset, qualificationAsset); }

const corruptRoot = join(root, "negative", "corrupt-design-system");
await mkdir(join(corruptRoot, "objects"), { recursive: true });
const approvedRelease = JSON.parse(await readFile(approvedReleasePath, "utf8")) as { componentContracts: { hash: string }; [key: string]: unknown };
for (const file of await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: join(designSystemRoot, "objects"), absolute: true }))) await Bun.write(join(corruptRoot, "objects", basename(file)), Bun.file(file));
await Bun.write(join(corruptRoot, "objects", `${approvedRelease.componentContracts.hash}.json`), "{}\n");
await cli("reject-conflicting-implementation", ["build", "--spec", specPath, "--page", "sitespec://northstar/pages/home", "--design-system", approvedReleasePath, "--design-system-root", corruptRoot, "--output", join(root, "negative", "corrupt-output")], [1]);

const changedGraph = rebuild(graph, (entity) => { if (entity.uid === "sitespec://northstar/pages/contact/sections/form.1/slots/body") entity.data.content = { kind: "plain-text", value: "Precisely changed approved contact copy." }; });
const changedSpecPath = join(root, "bounded", "changed-site.json");
await writeJson(changedSpecPath, artifact(changedGraph));
const changedContact = await cli("bounded-contact-build", ["build", "--spec", changedSpecPath, "--page", "sitespec://northstar/pages/contact", "--design-system", approvedReleasePath, "--output", join(root, "bounded", "production")], [3]);
if ((changedContact.data as Record<string, unknown>).runId === (contactBuild.data as Record<string, unknown>).runId) throw new Error("Changed contact slot did not produce a distinct bounded run");

const repositoryStatusAfter = await Bun.$`git status --porcelain=v1`.cwd(resolve(import.meta.dir, "..")).text();
if (repositoryStatusAfter !== repositoryStatusBefore) throw new Error("Qualification campaign mutated the Gen2Prod repository worktree");
const freeAtEnd = await freeBytes();
if (freeAtEnd < RESERVE_BYTES) throw new Error(`Disk reserve postflight failed: ${freeAtEnd} < ${RESERVE_BYTES}`);
const manifest = {
  schemaVersion: "g2p-dogfood-campaign/2.0",
  phase: "phase4-sitespec-design-system-production",
  startedFrom: { repositoryHead, repositoryStatus: repositoryStatusBefore.split("\n").filter(Boolean), freeBytes: freeAtStart },
  completedAt: new Date().toISOString(),
  postflight: { repositoryStatus: repositoryStatusAfter.split("\n").filter(Boolean), freeBytes: freeAtEnd, reserveBytes: RESERVE_BYTES },
  toolchain: { bun: Bun.version, lighthouse: LIGHTHOUSE_VERSION },
  commands: records.map((record) => ({ id: record.id, exitCode: record.exitCode, evidence: `commands/${String(records.indexOf(record) + 1).padStart(2, "0")}-${record.id}.json` })),
  accepted: { spec: specPath, visualTarget: finalTargetPath, designSystem: approvedReleasePath, validationRun, validationResults: validationResultsPath, anchorRun, anchorResults: anchorAcceptedResults, contactRun, contactResults: contactAcceptedResults, rolloutAudit: (rollout.data as Record<string, unknown>).auditPath },
  negativeControls: records.filter((record) => record.id.startsWith("reject-")).map((record) => ({ id: record.id, exitCode: record.exitCode })),
  idempotence: { anchorRunId: (anchorBuild.data as Record<string, unknown>).runId, repeatedRunId: (repeatBuild.data as Record<string, unknown>).runId },
  boundedChange: { originalContactRunId: (contactBuild.data as Record<string, unknown>).runId, changedContactRunId: (changedContact.data as Record<string, unknown>).runId, changedSubject: "sitespec://northstar/pages/contact/sections/form.1/slots/body" },
};
await writeJson(join(root, "manifest.json"), manifest);
console.log(JSON.stringify({ ok: true, manifest: join(root, "manifest.json"), commands: records.length, freeBytes: freeAtEnd }));
