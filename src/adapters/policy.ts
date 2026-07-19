import { FrameworkAdapterPolicySchema, type FrameworkAdapterPolicy } from "../schemas/adapters.ts";

export const defaultFrameworkAdapterPolicy: FrameworkAdapterPolicy = FrameworkAdapterPolicySchema.parse({
  schemaVersion: "0.1.0",
  name: "framework-bem-components-v1",
  componentization: "bem-blocks",
  interactionMode: "verified-contracts",
  metadataMode: "framework-native",
  preserveCanonicalAttributes: true,
  classMode: "bem-only",
  styleMode: "shared-token-css",
});

export const baselineFrameworkAdapterPolicy: FrameworkAdapterPolicy = FrameworkAdapterPolicySchema.parse({
  ...defaultFrameworkAdapterPolicy,
  name: "framework-page-baseline-v1",
  componentization: "page",
  interactionMode: "verified-contracts",
  metadataMode: "document",
});
