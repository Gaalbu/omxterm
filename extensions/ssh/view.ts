import { mountSshPage, type SshBridge } from "./page.js";
mountSshPage(
  document,
  (window as unknown as { omxHostedContent: SshBridge }).omxHostedContent,
);
