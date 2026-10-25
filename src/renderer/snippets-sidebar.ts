import type {
  TerminalSnippet,
  TerminalSnippetsResponse,
} from "../shared/terminal-snippets";
import type { AuxiliaryView } from "./auxiliary-panel";

// Content/query/scroll belong to this view; visibility, focus transitions and
// resize belong to the window's auxiliary host. Reread YAML on every activation.
export function createSnippetsView(
  document: Document,
  options: {
    readonly loadSnippets: () => Promise<TerminalSnippetsResponse>;
    readonly inject: (snippet: TerminalSnippet) => void;
    // returnFocus reports whether the view could take focus back on cancel.
    readonly preview: (
      snippet: TerminalSnippet,
      returnFocus: () => boolean,
    ) => void;
    readonly isInteractive: () => boolean;
  },
): AuxiliaryView {
  const root = document.createElement("div");
  root.className = "snippets-view";
  let disposed = false;
  let active = false;
  let generation = 0;
  let renderGeneration = 0;
  let snippets: readonly TerminalSnippet[] = [];
  let loading = false;
  let retainedScroll = 0;
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search snippets";
  search.setAttribute("aria-label", "Search Snippets");
  const results = document.createElement("div");
  results.className = "snippets-results";
  const list = document.createElement("ul");
  const status = document.createElement("p");
  status.className = "snippets-empty";
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.className = "snippets-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  results.append(error, status, list);
  root.append(search, results);

  const render = () => {
    const rendering = ++renderGeneration;
    const query = search.value.trim().toLowerCase();
    const visible = snippets.filter((snippet) =>
      `${snippet.name}\n${snippet.description ?? ""}`
        .toLowerCase()
        .includes(query),
    );
    const usable = () =>
      active &&
      !disposed &&
      !loading &&
      rendering === renderGeneration &&
      options.isInteractive();
    list.replaceChildren(
      ...visible.map((snippet) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "snippet-activate";
        const name = document.createElement("span");
        name.className = "snippet-name";
        name.textContent = snippet.name;
        button.append(name);
        if (snippet.description) {
          const description = document.createElement("span");
          description.className = "snippet-description";
          description.textContent = snippet.description;
          button.append(description);
        }
        // The default action is visible before activation: Run adds Enter.
        const intent = document.createElement("span");
        intent.className = "snippet-intent";
        intent.textContent = snippet.execute ? "Run · adds Enter" : "Insert";
        button.append(intent);
        button.addEventListener("click", () => {
          if (usable()) options.inject(snippet);
        });
        const preview = document.createElement("button");
        preview.type = "button";
        preview.className = "snippet-preview-open";
        preview.textContent = "Preview";
        preview.setAttribute("aria-label", `Preview ${snippet.name}`);
        const returnFocus = () => {
          if (!active || disposed || !options.isInteractive()) return false;
          const control =
            preview.isConnected && !preview.disabled ? preview : search;
          control.focus();
          return document.activeElement === control;
        };
        preview.addEventListener("click", () => {
          if (usable()) options.preview(snippet, returnFocus);
        });
        item.append(button, preview);
        return item;
      }),
    );
    status.hidden = !error.hidden || visible.length > 0;
    status.textContent = loading
      ? "Loading snippets…"
      : snippets.length === 0
        ? "No snippets. Create snippets.yaml next to config.json."
        : "No snippets match the search.";
  };
  const restoreScroll = () => {
    results.scrollTop = Math.min(
      retainedScroll,
      Math.max(0, results.scrollHeight - results.clientHeight),
    );
    retainedScroll = results.scrollTop;
  };
  const onInput = () => {
    if (!active || !options.isInteractive()) return;
    retainedScroll = 0;
    render();
    restoreScroll();
  };
  search.addEventListener("input", onInput);

  return {
    element: root,
    activate() {
      if (disposed) return;
      active = true;
      const activation = ++generation;
      loading = true;
      snippets = [];
      error.hidden = true;
      error.textContent = "";
      render();
      const settle = (response: TerminalSnippetsResponse) => {
        if (disposed || !active || activation !== generation) return;
        loading = false;
        snippets = response.error ? [] : response.snippets;
        error.hidden = response.error === undefined;
        error.textContent = response.error ?? "";
        render();
        restoreScroll();
      };
      // Also contain a synchronous loader failure; never render raw rejection text.
      void Promise.resolve()
        .then(options.loadSnippets)
        .then(settle, () =>
          settle({
            snippets: [],
            error:
              "Could not load snippets. Close and reopen Snippets to retry.",
          }),
        );
    },
    deactivate() {
      if (!active) return;
      if (!loading) retainedScroll = results.scrollTop;
      active = false;
      generation += 1;
      renderGeneration += 1;
    },
    focus() {
      if (active && options.isInteractive()) search.focus();
    },
    dispose() {
      if (disposed) return;
      active = false;
      disposed = true;
      generation += 1;
      renderGeneration += 1;
      search.removeEventListener("input", onInput);
      root.replaceChildren();
    },
  };
}
