export const readReloadEvidence = {
  hostReady: false,
  mounts: [] as Array<{
    family: string | undefined;
    lineHeight: number | undefined;
    status: "pending" | "mounted" | "failed";
    cancelled: boolean;
    fontName?: string | undefined;
  }>,
};
Object.assign(globalThis, { readReloadEvidence });
