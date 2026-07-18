# Gen2Prod CLI contract

Gen2Prod serves humans and automation. Primary results are written to stdout, diagnostics to stderr, and every result-producing command supports `--json`. Prompts are never required; `--no-input` makes this explicit for CI.

## Command tree

```text
gen2prod init [directory]
gen2prod synth prepare [--seed N] [--count N] [--force]
gen2prod synth import <canonical> <dirty-html> --css path --family name [--alignment exact|partial|non-1-to-1] [--dirty-image path] [--clean-image path] [--clean-html path] [--clean-css path] [--strategy path] [--change-manifest path]
gen2prod corpus prepare [--projects path] [--output path]
gen2prod corpus evaluate [--split train|validation|holdout|all] [--max-per-project N] [--viewport N] [--no-capture] [--no-live]
gen2prod image import <image> --target id --output path [--dirty-image path] [--strategy path] [--split train|validation|holdout]
gen2prod image synth-prepare [--fixtures path] [--output path]
gen2prod image synth-evaluate [--curriculum path] [--split train|validation|holdout|all]
gen2prod image capture <url> --target id [--capture-policy still|scroll-materialized|visual-probe-sequence]
gen2prod image analyze <manifest> [--no-ocr]
gen2prod image build <manifest> --output path [--policy path] [--max-raster-coverage ratio]
gen2prod image evaluate <manifest> --build path [--previous image] [--acceptance-pixel-ratio ratio]
gen2prod image audit <manifest> --build path
gen2prod image run <manifest> --output path [--no-ocr] [--policy path]
gen2prod image research [--catalog path] [--captures path] [--budget N]
gen2prod evaluate [--split validation|holdout|all] [--policy path]
gen2prod run <input> [--mode MODE] [--profile PROFILE] [--visual-target path]
gen2prod validate <run-or-output>
gen2prod research [--track policy|pass|verifier] [--budget N]
gen2prod distill [--trajectories path] [--naturalistic path] [--image path...] [--target selector|verifier|planner|all]
gen2prod report [run]
gen2prod doctor
```

Global flags are `--config <path>`, `--workspace <path>`, `--json`, `--no-input`, `--verbose`, `--help`, and `--version`. Configuration precedence is flags, `GEN2PROD_*` environment variables, project config, then built-in defaults.

## Safety and idempotency

- `init` and synthetic preparation refuse to overwrite user-owned artifacts unless `--force` is present.
- `run` writes only beneath the configured workspace unless an explicit output path is provided.
- Research evaluates candidates in isolated run directories and promotes only candidates that pass hard gates and improve the lexicographic fitness vector.
- Re-running deterministic compilation from the same artifact hashes must yield the same patch and output hashes.
- A command failure never weakens an evaluator or edits the frozen fixture manifest.
- Naturalistic evaluation writes a frozen evaluator hash, gate-level failures, candidate provenance, cross-page advisory metrics, and a project-split trajectory JSONL. `distill --naturalistic` blends that evidence with synthetic research trajectories while preserving the original project split labels.
- Image-only manifests declare exactly which hash-bound frames a builder may read. URLs, source/DOM/CSS, live extraction, and link records are quarantined; a post-build `image audit` cannot alter emitted files or policy inputs.
- Image research searches train projects, promotes only validation improvements without hard regressions, reveals holdout projects only for the final audit, and exports accepted and rejected trajectories. Multiple image JSONLs can be blended with `distill --image`.
- `image evaluate` separates visual-target acceptance from target quality. A large uniform/sparse capture region becomes an explicit recapture/review action even when the candidate accurately reproduces those pixels.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Completed and all required gates passed |
| 1 | Unexpected internal error |
| 2 | Invalid CLI usage or configuration |
| 3 | One or more validation gates failed |
| 4 | Required input, tool, or external authority is unavailable |
| 5 | Research candidate rejected; incumbent remains valid |

## Result envelope

Machine-readable output uses a stable envelope:

```json
{
  "ok": true,
  "command": "evaluate",
  "runId": "...",
  "data": {},
  "warnings": [],
  "requiredActions": []
}
```

`requiredActions` records human or external dependencies without blocking unrelated work.
