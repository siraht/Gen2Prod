import { describe, expect, test } from "bun:test";
import { protocolRequiredAction, result } from "../../src/core/result.ts";

describe("machine-readable result envelopes", () => {
  test("maps protocol evidence actions without hiding blocking work", () => {
    const envelope = result("build", { runId: "home-current" });
    envelope.requiredActions.push(protocolRequiredAction({
      actionType: "rerun",
      id: "home-visual-evidence",
      reason: "Record current rendered screenshot evidence.",
      requiredAuthority: "visual-reviewer",
      severity: "blocking",
      subjectRef: "sitespec://example/pages/home",
    }));
    envelope.ok = !envelope.requiredActions.some((action) => action.blocking);

    expect(envelope).toMatchObject({
      ok: false,
      requiredActions: [{
        id: "home-visual-evidence",
        summary: "Record current rendered screenshot evidence.",
        detail: "Subject: sitespec://example/pages/home; authority: visual-reviewer; next action: rerun.",
        blocking: true,
      }],
    });
  });
});
