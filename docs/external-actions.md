# Human and external actions for real projects

The local synthetic, research, and distillation loops require no human intervention. A production project may produce the following non-blocking or scoped blocking actions; Gen2Prod records them in `manifest.json.requiredActions` and continues unrelated work.

## Optional model and naturalistic-data authority

No external model is required. To benchmark one, the project owner must choose the provider/model, supply credentials outside the repository, approve a prompt/schema version and cost ceiling, and record the generator family exactly. Export the implementation as HTML/CSS and import it into a non-training split first:

```bash
gen2prod synth import canonical-spec.json generated.html \
  --css generated.css --family provider-model-prompt-version --split holdout
```

Do not promote a family on the procedural suite alone. Review licenses and data-handling terms before sending proprietary source or content to an external endpoint.

## Token authority

If compiled CSS does not expose the project’s ACSS/custom-property registry, provide a versioned token adapter with portable values, runtime bindings, allowed properties, modes/themes, and provenance:

```bash
gen2prod run page.html --css app.css --tokens acss.registry.json
```

Until supplied, governed values remain explicit, expiring exceptions. Do not approve a new token based on frequency alone; confirm that occurrences share a stable semantic role.

## Content and behavior authority

Provide exact values for anything the source cannot prove:

- missing navigation or CTA destination URLs;
- form actions, privacy notices, retention behavior, and processors;
- meaningful image alternative text when the asset/content brief is insufficient;
- approved copy for generated form labels or error messages;
- CMS enum values and sanitization constraints.

Gen2Prod will not infer these from pixels.

## Visual/design authority

For redesign or mockup convergence, provide:

- the approved, hashed image and target viewport/device-scale/font/color assumptions;
- locked and editable regions;
- authority for text/assets separate from visual authority;
- approval for any new token, component variant, or intentional visual delta.

When the convergence report says the next fix requires a design decision, specify the intended token/asset/content change and rerun with the same target hash.

## Accessibility review

Automation covers static rules, the computed accessibility tree, axe-style checks, keyboard flow, focus visibility, and declared interaction smoke tests. A qualified reviewer must still check:

- screen-reader reading order and announcements;
- alternative-text quality;
- cognitive clarity and error recovery;
- complex widgets against their full interaction contract;
- conformance claims for the project’s actual WCAG scope.

Record accepted findings or waivers with owner, risk, rationale, expiry, and repair action.

## Field performance and production integrations

Before claiming production outcomes, connect or supply:

- mobile/desktop-segmented field Core Web Vitals when sample size is sufficient;
- authenticated/data fixtures and stable network mocks for relevant states;
- third-party script inventory and ownership;
- CSP nonce/hash policy for approved inline JSON-LD or scripts;
- real form endpoints and privacy/data-handling review;
- browser/OS release matrix if the site requires more than the default Chrome capture.
