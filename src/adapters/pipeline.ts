import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CompiledPage } from "../compiler/types.ts";
import { ensureDirectory, writeJsonAtomic, writeTextAtomic } from "../core/fs.ts";
import { openCaptureSession } from "../evidence/capture.ts";
import { FrameworkAdapterSuiteSchema, type FrameworkAdapterPolicy, type FrameworkAdapterSuite, type FrameworkAdapterTarget } from "../schemas/adapters.ts";
import { emitFrameworkAdapter } from "./emit.ts";
import { validateFrameworkAdapter } from "./validate.ts";

export const ALL_FRAMEWORK_ADAPTER_TARGETS: FrameworkAdapterTarget[] = ["react", "vue", "svelte", "astro", "wordpress", "bricks"];

export type RunFrameworkAdapterSuiteOptions = {
  compiled: CompiledPage;
  outputDirectory: string;
  targets: FrameworkAdapterTarget[];
  policy: FrameworkAdapterPolicy;
  capture?: { viewport: number; browserExecutable?: string | undefined } | undefined;
};

export async function runFrameworkAdapterSuite(options: RunFrameworkAdapterSuiteOptions): Promise<FrameworkAdapterSuite> {
  const root = resolve(options.outputDirectory);
  await ensureDirectory(root);
  let session: Awaited<ReturnType<typeof openCaptureSession>> | undefined;
  let canonicalScreenshot: string | undefined;
  try {
    if (options.capture) {
      const canonicalDirectory = join(root, "canonical");
      await Promise.all([
        writeTextAtomic(join(canonicalDirectory, "page.html"), options.compiled.html),
        writeTextAtomic(join(canonicalDirectory, "page.css"), options.compiled.css),
      ]);
      session = await openCaptureSession(options.capture.browserExecutable);
      const canonical = await session.capture({
        url: pathToFileURL(join(canonicalDirectory, "page.html")).href,
        outputDirectory: join(canonicalDirectory, "capture"),
        viewports: [options.capture.viewport],
        states: ["default"],
        themes: ["light"],
        materializeScrollStates: false,
      });
      canonicalScreenshot = canonical.captures[0]?.screenshot;
      if (!canonicalScreenshot) throw new Error("Canonical framework-adapter capture produced no screenshot");
    }
    const manifests = [];
    const validations = [];
    let totalSourceBytes = 0;
    let componentCount = 0;
    for (const target of options.targets) {
      const directory = join(root, target);
      const manifest = await emitFrameworkAdapter({ compiled: options.compiled, target, outputDirectory: directory, policy: options.policy });
      const validation = await validateFrameworkAdapter({
        compiled: options.compiled,
        directory,
        manifest,
        ...(session && canonicalScreenshot && options.capture ? { capture: { session, canonicalScreenshot, viewport: options.capture.viewport } } : {}),
      });
      manifests.push({ target, directory, manifestPath: join(directory, "adapter-manifest.json"), adapterSourceHash: manifest.adapterSourceHash });
      validations.push(validation);
      componentCount += manifest.componentCount;
      for (const file of manifest.files) totalSourceBytes += (await Bun.file(join(directory, file.path)).arrayBuffer()).byteLength;
    }
    const visual = validations.flatMap((validation) => validation.visualPixelDifferenceRatio === undefined ? [] : [validation.visualPixelDifferenceRatio]);
    const suite = FrameworkAdapterSuiteSchema.parse({
      schemaVersion: "0.1.0",
      suiteId: `adapter-suite-${crypto.randomUUID()}`,
      policy: options.policy,
      targets: options.targets,
      manifests,
      validations,
      aggregate: {
        passed: validations.filter((validation) => validation.passed).length,
        failed: validations.filter((validation) => !validation.passed).length,
        nativeCompileRate: validations.filter((validation) => validation.nativeCompilePassed).length / Math.max(validations.length, 1),
        nativeRenderRate: validations.filter((validation) => validation.nativeRenderPassed).length / Math.max(validations.length, 1),
        meanStructuralEquivalence: validations.reduce((sum, validation) => sum + validation.structuralEquivalence, 0) / Math.max(validations.length, 1),
        ...(visual.length ? { meanVisualPixelDifferenceRatio: visual.reduce((sum, value) => sum + value, 0) / visual.length } : {}),
        totalSourceBytes,
        componentCount,
      },
      ...(canonicalScreenshot ? { canonicalCapture: canonicalScreenshot } : {}),
      passed: validations.length === options.targets.length && validations.every((validation) => validation.passed),
    });
    await writeJsonAtomic(join(root, "adapter-suite.json"), suite);
    return suite;
  } finally {
    await session?.close();
  }
}
