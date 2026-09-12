/**
 * Debounced MutationObserver for dynamic pages.
 * Invalidates / notifies when meaningful DOM changes occur.
 */

type ChangeHandler = () => void;

let observer: MutationObserver | null = null;
let timer: number | null = null;
let paused = false;

const DEBOUNCE_MS = 800;

export function startMutationWatcher(onMeaningfulChange: ChangeHandler): void {
  stopMutationWatcher();
  observer = new MutationObserver((mutations) => {
    if (paused) return;
    const meaningful = mutations.some((m) => {
      if (m.type === "characterData") return false;
      // Ignore PageGuide's own attribute repairs
      if (m.type === "attributes") {
        const attr = m.attributeName || "";
        if (attr.startsWith("data-pageguide") || attr === "aria-label" || attr === "role" || attr === "tabindex" || attr === "alt") {
          return false;
        }
      }
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement && !node.closest("[data-pageguide-ui]")) return true;
      }
      for (const node of Array.from(m.removedNodes)) {
        if (node instanceof HTMLElement) return true;
      }
      return false;
    });
    if (!meaningful) return;
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      onMeaningfulChange();
    }, DEBOUNCE_MS);
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-hidden", "disabled", "style"],
    });
  }
}

export function stopMutationWatcher(): void {
  observer?.disconnect();
  observer = null;
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

export function pauseMutationWatcher(value: boolean): void {
  paused = value;
}
