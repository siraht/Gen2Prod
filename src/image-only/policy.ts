import type { ImageOnlyPolicy } from "../schemas/image-only.ts";

export const defaultImageOnlyPolicy: ImageOnlyPolicy = {
  schemaVersion: "0.1.0",
  name: "image-production-v1",
  layoutStrategy: "geometry-aware",
  preserveTargetRegionHeights: true,
  typographyScale: 1,
  raster: { enabled: true, maximumCoverage: 0.28, imageDominanceThreshold: 0.25, maximumTextLines: 1 },
};

export const conservativeImageOnlyPolicy: ImageOnlyPolicy = {
  schemaVersion: "0.1.0",
  name: "image-conservative-v1",
  layoutStrategy: "flow",
  preserveTargetRegionHeights: false,
  typographyScale: 1,
  raster: { enabled: true, maximumCoverage: 0.12, imageDominanceThreshold: 0.65, maximumTextLines: 0 },
};
