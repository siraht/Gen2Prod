import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { prepareAutomaticCss } from "../../src/acss/adapter.ts";

describe("Automatic.css release adapter", () => {
  test("compiles a plugin ZIP into a governed registry, catalog, and provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "g2p-acss-adapter-"));
    const sourcePath = join(directory, "automatic.css-test.zip");
    const files = {
      "automaticcss/automaticcss-plugin.php": strToU8("/* Plugin Name: Automatic.css\nVersion: 4.0.0-test\n*/"),
      "automaticcss/readme.txt": strToU8("License: GPLv2 or later\nLicense URI: https://www.gnu.org/licenses/gpl-2.0.html\n"),
      "automaticcss/assets/scss/automatic.scss": strToU8(":root { --space-m: 1rem; --primary: #123456; --content-width: 80rem; }"),
      "automaticcss/config/framework.json": strToU8(JSON.stringify({ vars: { "space-m": {}, primary: {} }, classes: { "grid--3": {} } })),
      "automaticcss/config/classes.json": strToU8(JSON.stringify({ classes: ["bg--primary", "text--m"] })),
      "automaticcss/config/ui/general.json": strToU8(JSON.stringify([{ id: "option-spacing", default: "m" }])),
    };
    await Bun.write(sourcePath, zipSync(files));
    const outputDirectory = join(directory, "adapter");
    const bundle = await prepareAutomaticCss({ sourcePath, outputDirectory });
    expect(bundle.provenance.version).toBe("4.0.0-test");
    expect(bundle.provenance.sourceHash).toHaveLength(64);
    expect(bundle.catalog.license.name).toBe("GPLv2 or later");
    expect(bundle.catalog.utilityClasses).toEqual(["bg--primary", "grid--3", "text--m"]);
    expect(bundle.catalog.settingsDefaults["option-spacing"]).toBe("m");
    expect(bundle.registry.tokens.find((token) => token.runtimeVariable === "--space-m")?.source).toContain("compiled-release-default");
    expect(await Bun.file(bundle.files.compiledCss).text()).toContain("--primary: #123456");
    const cached = await prepareAutomaticCss({ sourcePath, outputDirectory });
    expect(cached.provenance.registryHash).toBe(bundle.provenance.registryHash);
  });
});
