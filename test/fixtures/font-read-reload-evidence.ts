export const readReloadEvidence = {
  hostReady: false,
  sessionIds: [] as Array<string | undefined>,
  mounts: [] as Array<{
    family: string | undefined;
    lineHeight: number | undefined;
    status: "pending" | "mounted" | "failed";
    cancelled: boolean;
    fontName?: string | undefined;
  }>,
};
Object.assign(globalThis, { readReloadEvidence });
