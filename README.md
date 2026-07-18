# Gen2Prod

Gen2Prod is a measured website transformation compiler and self-improving policy laboratory. It converts uncertain website artifacts into a canonical semantic/component/BEM/token normal form, deterministically emits production code, validates the result, and learns better evidence and pass-selection policies from frozen synthetic benchmarks.

The implementation is currently being built against [the compiler plan](./docs/Gen2Prod_plan_v2_3_4_revised.md) and [the Karpathy-style loop design](./docs/karpathyloop.md). The CLI contract is documented in [docs/cli-contract.md](./docs/cli-contract.md).

```bash
pnpm install
bun run cli --help
bun run verify
```
