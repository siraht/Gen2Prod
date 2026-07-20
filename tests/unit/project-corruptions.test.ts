import { describe, expect, test } from "bun:test";
import { applyProjectCorruptions, cleanProjectCorruptionSpecimen, PROJECT_CORRUPTION_GRAMMAR } from "../../src/project-adapters/corruptions.ts";
import { ProjectCorruptionGrammarReportSchema } from "../../src/schemas/project-adapters.ts";

describe("project corruption grammar", () => {
  test("composes every source/runtime/CMS/replay corruption with exact lineage", () => {
    const { specimen, report } = applyProjectCorruptions("all-controls");
    expect(report.operations).toHaveLength(24);
    expect(new Set(report.operations.map((item) => item.kind)).size).toBe(24);
    expect(new Set(report.operations.map((item) => item.changedField)).size).toBe(24);
    expect(report.operations.every((item) => item.detected && item.beforeHash !== item.afterHash)).toBeTrue();
    expect(report.cleanHash).not.toBe(report.corruptedHash);
    expect(specimen).not.toEqual(cleanProjectCorruptionSpecimen());
  });

  test("selects one failure class without changing unrelated fields", () => {
    const clean = cleanProjectCorruptionSpecimen();
    const { specimen, report } = applyProjectCorruptions("handler-only", ["handler-binding-loss"]);
    expect(report.operations.map((item) => item.changedField)).toEqual(["handlerBinding"]);
    expect(specimen.handlerBinding).toBe("");
    expect({ ...specimen, handlerBinding: clean.handlerBinding }).toEqual(clean);
  });

  test("rejects ineffective and overlapping lineage claims", () => {
    const report = applyProjectCorruptions("tamper").report;
    expect(() => ProjectCorruptionGrammarReportSchema.parse({ ...report, operations: [...report.operations, { ...report.operations[0], id: "duplicate-field" }] })).toThrow();
    expect(PROJECT_CORRUPTION_GRAMMAR.map((item) => item.detector).every(Boolean)).toBeTrue();
  });
});
