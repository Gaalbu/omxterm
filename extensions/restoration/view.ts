import { mountRestorationPage, type RestorationBridge } from "./page.js";
mountRestorationPage(
  document,
  (window as unknown as { omxHostedContent: RestorationBridge })
    .omxHostedContent,
);
