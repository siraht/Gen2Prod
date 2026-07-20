import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/hash.ts";
import { capturePage } from "../../src/evidence/capture.ts";
import { discoverProject } from "../../src/project-adapters/discovery.ts";
import { parseProjectSource } from "../../src/project-adapters/registry.ts";
import { assertEquivalentFixtureInputs, captureProjectStates } from "../../src/project-adapters/state-fixtures.ts";
import { ProjectContractSchema, type StateFixture } from "../../src/schemas/project-adapters.ts";

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  if (new URL(request.url).pathname === "/") return new Response('<!doctype html><html><body><details><summary data-g2p-safe-probe data-g2p-interaction="toggle">More</summary><div data-g2p-branch="open">Open</div></details><button id="unsafe">Send</button><div id="loaded"></div><script>fetch("/api").then(r=>r.text()).then(v=>document.querySelector("#loaded").textContent=v)</script></body></html>', { headers: { "content-type": "text/html" } });
  return new Response("unmocked", { status: 500 });
} });
afterAll(() => server.stop(true));

describe("project route/state fixtures", () => {
  test("captures declarative mocked states and reports branch/interaction coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "g2p-states-project-"));
    await Bun.write(join(root, "package.json"), JSON.stringify({ name: "states", scripts: { build: "vite build" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }));
    await Bun.write(join(root, "bun.lock"), "lock");
    await Bun.write(join(root, "src", "App.tsx"), "export function App(){return <main>Hi</main>}\n");
    const discovery = await discoverProject(root);
    const project = await parseProjectSource(root, discovery);
    const body = "fixture-response";
    const state: StateFixture = { id: "open-mocked", route: "/", viewport: 800, theme: "light", actions: [{ kind: "fixture", name: "**/api", valueHash: sha256(body) }, { kind: "goto", path: "/" }, { kind: "wait-for", locator: "#loaded", state: "visible" }, { kind: "click", locator: "summary", sideEffectAuthorized: false }], expectedBranches: ["open"], expectedInteractions: ["toggle"] };
    const contract = ProjectContractSchema.parse({ ...discovery.contract, states: [state], integration: { ...discovery.contract.integration, routeEntries: discovery.contract.integration.routeEntries.map((route) => ({ ...route, states: [state.id] })) } });
    const output = await mkdtemp(join(tmpdir(), "g2p-states-capture-"));
    const capture = await captureProjectStates({ baseUrl: `http://${server.hostname}:${server.port}/`, outputDirectory: output, contract, project, fixturePayloads: { [sha256(body)]: { body, contentType: "text/plain" } } });
    expect(capture.coverage).toEqual({ declared: 1, captured: 1, branchesExpected: 1, branchesObserved: 1, interactionsExpected: 1, interactionsObserved: 1 });
    expect(capture.requiredActions).toEqual([]);
    assertEquivalentFixtureInputs(capture, structuredClone(capture));
    expect(() => assertEquivalentFixtureInputs(capture, { ...capture, fixtureHash: sha256("changed") })).toThrow("fixture inputs differ");
  }, 20_000);

  test("refuses undeclared activating probes", async () => {
    const output = await mkdtemp(join(tmpdir(), "g2p-states-unsafe-"));
    const state: StateFixture = { id: "unsafe", route: "/", viewport: 800, theme: "light", actions: [{ kind: "goto", path: "/" }, { kind: "click", locator: "#unsafe", sideEffectAuthorized: false }], expectedBranches: [], expectedInteractions: [] };
    expect(capturePage({ url: `http://${server.hostname}:${server.port}/`, outputDirectory: output, viewports: [800], themes: ["light"], states: [state.id], stateFixtures: [state] })).rejects.toThrow("requires side-effect authority");
  }, 20_000);
});
