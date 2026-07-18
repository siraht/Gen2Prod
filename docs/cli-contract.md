# Gen2Prod CLI contract

Gen2Prod serves humans and automation. Primary results are written to stdout, diagnostics to stderr, and every result-producing command supports `--json`. Prompts are never required; `--no-input` makes this explicit for CI.

## Command tree

```text
gen2prod init [directory]
gen2prod synth prepare [--seed N] [--count N] [--force]
gen2prod evaluate [--split validation|holdout|all] [--policy path]
gen2prod run <input> [--mode MODE] [--profile PROFILE] [--visual-target path]
gen2prod validate <run-or-output>
gen2prod research [--track policy|pass|verifier] [--budget N]
gen2prod distill [--target selector|verifier|planner|all]
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
