import { join } from "node:path";
import { sha256 } from "../../core/hash.ts";
import type { ProjectContract, ProjectPatchOperation } from "../../schemas/project-adapters.ts";

export function planOwnedFile(contract: ProjectContract, operationId: string, relativeName: string, contents: string, dependencies: string[] = []): ProjectPatchOperation {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relativeName) || relativeName.split("/").includes("..")) throw new Error(`Unsafe generated file name: ${relativeName}`);
  const path = join(contract.integration.generatedDirectory, relativeName).replaceAll("\\", "/");
  if (!contract.authority.allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) throw new Error(`Generated directory is outside destination authority: ${path}`);
  return { kind: "write-owned-file", operationId, dependencies, path, authorities: ["destination-path-ownership"], preservedRegionHashes: [], blastRadius: "component", expectedPostimageHash: sha256(contents), validationObligations: ["native-typecheck", "generated-source-contract"], skippable: false, contents, mustNotExist: true };
}
