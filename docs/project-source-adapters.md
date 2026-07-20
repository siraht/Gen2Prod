# Framework/CMS source adapters

The project-adapter path integrates accepted canonical Gen2Prod output into an existing React/Next, Vue/Nuxt, Svelte/SvelteKit, Astro, WordPress block-theme export, or Bricks export while preserving dynamic source. It is separate from the native-output adapters, which generate a new bundle from G2P-NF.

## Lifecycle and write boundary

```text
inspect (read destination) → plan (read destination) → run (copied sandbox)
→ accepted validation → apply (explicit destination write) → optional rollback
```

`inspect`, `plan`, and `run` never write the destination. `run` builds, previews, captures full-page route/state images, compares baseline/candidate/optional target pixels, checks source/behavior/semantic/style preservation, rolls back and reapplies in the sandbox, and proves the second plan is empty. `apply` is the only destination mutation operation.

```bash
gen2prod project inspect ./site --output .gen2prod/projects/site/inspect
gen2prod project plan ./site request.json --output .gen2prod/projects/site/plan.json
gen2prod project run ./site request.json --output .gen2prod/projects/site/runs
```

Add `--json` before `project` for the stable result envelope. A local copied-sandbox run intentionally remains unaccepted until hardened isolation and the frozen project mutation suite both provide real evidence.

## Run request

`project-adapter-run-request.schema.json` is exported by `gen2prod init`. It binds the canonical surface and the destination correspondence instead of allowing target-specific CLI fragments:

```json
{
  "schemaVersion": "0.1.0",
  "correspondence": {
    "schemaVersion": "0.1.0",
    "projectId": "shop-app",
    "sourceProjectHash": "<64-hex-source-hash>",
    "captureHash": "<64-hex-capture-hash>",
    "mappings": [{
      "mappingId": "home-root",
      "sourceNodeId": "<Source-Project-IR-node-id>",
      "kind": "one-to-one",
      "instances": [{ "stateId": "/:default", "renderedNodeId": "main", "score": 0.96 }],
      "confidence": 0.96,
      "evidence": ["tag", "accessible-name", "layout-visible"],
      "destructiveAuthorized": true
    }],
    "unresolved": []
  },
  "canonical": {
    "target": "react",
    "root": {
      "nodeId": "canonical-main",
      "originalTag": "div",
      "tag": "main",
      "role": "main",
      "block": "page",
      "classes": ["page"],
      "oldClasses": [],
      "attributes": {},
      "text": "",
      "children": []
    },
    "scss": ".page { display: grid; gap: var(--space-m); }",
    "css": "",
    "outputHash": "<64-hex-canonical-hash>",
    "registeredVariables": ["--space-m"]
  },
  "policyHash": "<64-hex-policy-hash>",
  "mode": "legacy-conversion",
  "profile": "refactor",
  "previewUrl": "http://127.0.0.1:4173/"
}
```

The canonical tree must already satisfy the semantic BEM contract. Styling is shared nested SCSS, selectors target BEM classes only, and values use registered ACSS/project variables. The destination target must match `canonical.target`; correspondence must match the current project/source hashes.

## State fixtures and images

Discovery records route fixtures in the project contract. Each fixture declares route, viewport, theme, expected branches/interactions, and safe actions:

```json
{
  "id": "/checkout:error",
  "route": "/checkout",
  "viewport": 1280,
  "theme": "light",
  "actions": [
    { "kind": "goto", "path": "/checkout" },
    { "kind": "fill", "locator": "#email", "value": "invalid", "sideEffectAuthorized": false },
    { "kind": "press", "locator": "#email", "key": "Tab", "sideEffectAuthorized": false }
  ],
  "expectedBranches": ["email-error"],
  "expectedInteractions": ["email-blur"]
}
```

Network fixtures are hash-bound payloads in the run request. Navigation, disclosure, keyboard, fill, and wait operations are non-activating by default; side-effecting clicks require explicit authority. The validator retains baseline, candidate, target, baseline-diff, and target-diff PNGs for every captured condition. Still images never authorize handlers, routes, branches, animation mechanisms, or server/client boundaries.

## Accepted apply and rollback

Use the exact artifacts from an accepted run:

```bash
gen2prod project apply ./site \
  --contract project-contract.json \
  --source source-project.json \
  --plan project-patch-plan.json \
  --validation project-validation-report.json \
  --artifacts .gen2prod/projects/site/rollback

gen2prod project rollback ./site \
  .gen2prod/projects/site/rollback/<plan-id>-rollback.json
```

Apply re-discovers the destination and verifies root, framework/profile/version, lockfile, allowed paths, operation graph, file/span/AST preimages, CMS revision, and owned-file absence before writing. The exact-original rollback bundle is persisted first. Writes use staged atomic renames; an observed postimage race triggers automatic rollback. A second apply against the changed root is rejected.

## Configuration and doctor

```yaml
projectAdapters:
  artifacts: .gen2prod/projects
  profile: react-vite       # optional exact override
  includeInstall: false     # frozen install authority
  previewUrl: http://127.0.0.1:4173/
  previewEnvironmentKeys: [PUBLIC_API_ORIGIN]
  sandbox: copy-audit       # development evidence only
```

Production acceptance requires `sandbox: container` and `containerImage: name@sha256:<digest>`. Configuration contains environment names only; values stay process-local and must also be authorized by the discovered contract. `gen2prod --json doctor` reports parser versions, all supported profiles/capabilities, browser/PHP/Docker status, immutable-image presence, and project acceptance readiness.

## CMS boundary

WordPress and Bricks work from revisioned offline exports. Planners retain unknown/plugin/private fields, dynamic/query/condition/interaction regions, IDs, parentage, and exact original bytes. They emit an import package and rollback export; direct database writes and automatic production publication are prohibited.

Authenticated staging remains a separate authority boundary. Until a connector is configured and proven, the report requests exact staging URL, site/plugin/theme versions, content IDs, revision/ETag, permission scope, sanitization policy, credentials, before/after captures, and rollback destination. Static/offline work continues without inventing those values.

## Troubleshooting

- **Ambiguous framework:** pass `--profile` only after verifying the intended exact profile. Detection refuses conflicting framework signals.
- **Stale source/correspondence:** rerun `inspect`, recapture declared states, and regenerate correspondence; do not edit hashes.
- **Build command failure:** fix the destination's declared native command or lockfile. Inspection never installs; frozen install requires config and contract authority.
- **Incomplete state coverage:** add fixtures for every branch/interaction and provide hash-matching network payloads.
- **Copied sandbox rejected:** expected. It detects source drift but cannot prevent absolute-path escape; configure and provision the pinned container backend.
- **Mutation recall below 100%:** repair the verifier or fixture coverage. This hard gate cannot be waived by image improvement.
- **Generated-file collision:** resolve or move the user-owned file. The planner will not overwrite it.
- **CMS revision mismatch:** export the current revision and replan. Never force an old node patch.

Current executable scope and remaining staging/research boundaries are tracked in [the implementation matrix](implementation-matrix.md) and [the source-adapter plan](framework-source-adapter-implementation-plan.md).
