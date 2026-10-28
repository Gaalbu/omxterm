import type { CatalogRelease } from "../src/main/extension-catalog";
export function createFilesCatalog(
  archive: string,
  output: string,
): Promise<{ schemaVersion: number; entries: CatalogRelease[] }>;
