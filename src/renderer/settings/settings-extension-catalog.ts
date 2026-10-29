import type {
  CatalogSnapshot,
  ExtensionsBridge,
  ExtensionsRequest,
} from "../../shared/extensions";
import { createPageButton, setPageNotice } from "../application-page";
import { englishLanguage, type Translate } from "../renderer-language";

/** Independent acquisition state leaves local/installed management usable offline. */
export function renderExtensionCatalog(
  document: Document,
  bridge: ExtensionsBridge,
  live: () => boolean,
  install: (request: ExtensionsRequest) => void,
  labels: ((t: Translate) => void)[],
  disposers: (() => void)[],
) {
  let t = englishLanguage.t;
  let snapshot: CatalogSnapshot = { loaded: false, stale: false, entries: [] };
  let token: string | undefined;
  let failed = false;
  let managementBusy = false;
  const section = document.createElement("section");
  section.className = "extension-catalog";
  const heading = document.createElement("h3");
  const explanation = document.createElement("p");
  const actions = document.createElement("div");
  actions.className = "application-page-actions";
  const browse = createPageButton(document);
  const cancel = createPageButton(document);
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "extension-catalog-list";
  const bindings: (() => void)[] = [];
  const buttons: { button: HTMLButtonElement; compatible: boolean }[] = [];
  const cancelLoad = () => {
    if (token)
      void bridge
        .request({ operation: "cancel-install", token })
        .catch(() => {});
  };
  cancel.addEventListener("click", cancelLoad);
  disposers.push(cancelLoad);
  function relabel() {
    heading.textContent = t("extensions.catalogHeading");
    explanation.textContent = t("extensions.catalogTrust");
    browse.textContent = t(
      failed
        ? "extensions.catalogRetry"
        : snapshot.loaded
          ? "extensions.catalogRefresh"
          : "extensions.catalogBrowse",
    );
    browse.disabled = !!token;
    cancel.hidden = !token;
    cancel.textContent = t("common.cancel");
    setPageNotice(notice, {
      text: t(
        token
          ? "extensions.catalogLoading"
          : failed || snapshot.stale
            ? snapshot.loaded
              ? "extensions.catalogStale"
              : "extensions.catalogUnavailable"
            : !snapshot.loaded
              ? "extensions.catalogIdle"
              : snapshot.entries.length
                ? "extensions.catalogLoaded"
                : "extensions.catalogEmpty",
      ),
      severity: failed || snapshot.stale ? "warning" : "info",
    });
    for (const apply of bindings) apply();
    for (const item of buttons)
      item.button.disabled = managementBusy || !item.compatible;
  }
  function update(next: CatalogSnapshot) {
    snapshot = next;
    if (next.loaded && !next.stale) failed = false;
    bindings.length = 0;
    buttons.length = 0;
    list.replaceChildren();
    for (const entry of snapshot.entries) {
      const card = document.createElement("section");
      card.className = "extension-catalog-card";
      const title = document.createElement("h4");
      title.textContent = `${entry.name} · ${entry.version}`;
      const description = document.createElement("p");
      description.textContent = entry.description;
      const status = document.createElement("p");
      const button = createPageButton(document);
      bindings.push(() => {
        status.textContent = entry.compatible
          ? entry.installedVersion
            ? t("extensions.catalogInstalled", {
                version: entry.installedVersion,
              })
            : t("extensions.catalogNotInstalled")
          : t("extensions.incompatible");
        button.textContent = t(
          entry.action === "install"
            ? "extensions.catalogInstall"
            : entry.action === "update"
              ? "extensions.catalogUpdate"
              : entry.action === "reinstall"
                ? "extensions.catalogReinstall"
                : "extensions.catalogReplace",
        );
      });
      button.addEventListener("click", () =>
        install({
          operation: "catalog-install",
          selection: entry.selection,
          token: crypto.randomUUID(),
        }),
      );
      buttons.push({ button, compatible: entry.compatible });
      card.append(title, description, status);
      if (entry.action === "replace") {
        const warning = document.createElement("p");
        bindings.push(() =>
          setPageNotice(warning, {
            text: t("extensions.catalogReplaceWarning"),
            severity: "warning",
          }),
        );
        card.append(warning);
      }
      card.append(button);
      list.append(card);
    }
    relabel();
  }
  browse.addEventListener("click", () => {
    if (token || !live()) return;
    token = crypto.randomUUID();
    failed = false;
    relabel();
    void bridge
      .request({ operation: "catalog-refresh", token })
      .then(
        (result) => {
          if (!live()) return;
          failed = !result.ok;
          if (result.catalog) update(result.catalog);
        },
        () => {
          failed = true;
        },
      )
      .finally(() => {
        token = undefined;
        if (live()) relabel();
      });
  });
  labels.push((next) => {
    t = next;
    relabel();
  });
  actions.append(browse, cancel);
  section.append(heading, explanation, actions, notice, list);
  relabel();
  return {
    element: section,
    update,
    busy(value: boolean) {
      managementBusy = value;
      relabel();
    },
  };
}
