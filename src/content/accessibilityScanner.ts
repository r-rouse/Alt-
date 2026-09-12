/**
 * Deterministic accessibility scanner.
 * Finds issues with normal code BEFORE involving AI.
 */

import { elementRegistry } from "./elementRegistry";
import type {
  AccessibilityIssue,
  AccessibilityIssueType,
  IssueSeverity,
  SemanticElement,
  SemanticSource,
} from "../shared/accessibility";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "LINK",
  "META",
  "HEAD",
]);

function clean(raw: string | null | undefined, max = 120): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && !el.getAttribute("aria-label")) {
    return false;
  }
  return true;
}

function roleOf(el: HTMLElement): string | null {
  return el.getAttribute("role");
}

function hasClickHandler(el: HTMLElement): boolean {
  if (el.hasAttribute("onclick")) return true;
  if (el.getAttribute("role") === "button" || el.getAttribute("role") === "link") {
    return true;
  }
  // Heuristic: cursor pointer + common interactive classes/attrs
  const style = window.getComputedStyle(el);
  if (style.cursor === "pointer" && (el.getAttribute("data-action") || el.classList.contains("btn") || el.classList.contains("button") || el.classList.contains("clickable"))) {
    return true;
  }
  return false;
}

function isNativelyInteractive(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === "A" && (el as HTMLAnchorElement).href) return true;
  if (tag === "BUTTON" || tag === "SUMMARY") return true;
  if (tag === "INPUT") {
    return (el as HTMLInputElement).type.toLowerCase() !== "hidden";
  }
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  const role = roleOf(el);
  if (
    role &&
    ["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "textbox", "combobox", "searchbox"].includes(role)
  ) {
    return true;
  }
  return false;
}

function isKeyboardAccessible(el: HTMLElement): boolean {
  if (el.tabIndex >= 0) return true;
  if (el.matches("a[href], button, input, select, textarea, summary, [contenteditable=true]")) {
    return !(el as HTMLButtonElement).disabled;
  }
  return false;
}

/**
 * Accessible name for scanning — does NOT treat placeholder alone as a sufficient form label
 * (placeholder-only is still an issue; AI/heuristic may repair it).
 */
function computeAccessibleName(el: HTMLElement): {
  name: string | null;
  source: SemanticSource;
} {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return { name: clean(aria), source: "native" };

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent)
      .filter(Boolean)
      .join(" ");
    if (parts.trim()) return { name: clean(parts), source: "native" };
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = clean(label?.textContent);
      if (t) return { name: t, source: "native" };
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const clone = wrapping.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,textarea,select").forEach((n) => n.remove());
      const t = clean(clone.textContent);
      if (t) return { name: t, source: "native" };
    }
    if (el.title?.trim()) return { name: clean(el.title), source: "native" };
  }

  if (el instanceof HTMLImageElement) {
    if (el.alt != null && el.alt !== "") return { name: clean(el.alt), source: "native" };
    if (el.alt === "") return { name: "", source: "native" }; // decorative
    return { name: null, source: "native" };
  }

  // Own text excluding nested scripts
  const own = clean(el.innerText || el.textContent);
  if (own) return { name: own, source: "native" };

  if (el.title?.trim()) return { name: clean(el.title), source: "native" };

  return { name: null, source: "native" };
}

function nearbyText(el: HTMLElement): string {
  const parent = el.parentElement;
  if (!parent) return "";
  const clone = parent.cloneNode(true) as HTMLElement;
  // Remove the element itself from clone text bias
  const bits: string[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node === el) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clean(node.textContent, 80);
      if (t) bits.push(t);
    } else if (node instanceof HTMLElement && node !== el) {
      const t = clean(node.innerText, 80);
      if (t && !node.contains(el)) bits.push(t);
    }
  }
  return bits.join(" | ").slice(0, 160);
}

function nearbyHeading(el: HTMLElement): string | null {
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 8 && cur; i++) {
    const prev = cur.previousElementSibling;
    if (prev instanceof HTMLElement) {
      const h = prev.matches("h1,h2,h3,h4,h5,h6")
        ? prev
        : prev.querySelector("h1,h2,h3,h4,h5,h6");
      if (h) return clean(h.textContent);
    }
    cur = cur.parentElement;
  }
  const region = el.closest("section, article, form, [role='region'], main");
  const h = region?.querySelector("h1,h2,h3,h4,h5,h6");
  return h ? clean(h.textContent) : null;
}

function parentLandmark(el: HTMLElement): string | null {
  const land = el.closest(
    "main,nav,header,footer,aside,form,article,section,[role='main'],[role='navigation'],[role='banner'],[role='contentinfo'],[role='search']"
  );
  if (!land || !(land instanceof HTMLElement)) return null;
  const role = land.getAttribute("role") || land.tagName.toLowerCase();
  const name =
    land.getAttribute("aria-label") ||
    clean(land.querySelector("h1,h2,h3")?.textContent) ||
    "";
  return name ? `${role}: ${name}` : role;
}

function parentFormName(el: HTMLElement): string | null {
  const form = el.closest("form");
  if (!form) return null;
  return (
    form.getAttribute("aria-label") ||
    form.getAttribute("name") ||
    clean(form.querySelector("h1,h2,h3,legend")?.textContent) ||
    "form"
  );
}

function childSummary(el: HTMLElement): string | null {
  const parts: string[] = [];
  if (el.querySelector("svg")) parts.push("SVG icon");
  if (el.querySelector("img")) {
    const img = el.querySelector("img");
    parts.push(img?.alt ? `img:"${clean(img.alt, 40)}"` : "img without alt");
  }
  const t = clean(el.innerText, 60);
  if (t) parts.push(`text:"${t}"`);
  return parts.length ? parts.join(", ") : null;
}

function siblingText(el: HTMLElement, dir: "prev" | "next"): string | null {
  let sib = dir === "prev" ? el.previousElementSibling : el.nextElementSibling;
  let hops = 0;
  while (sib && hops < 3) {
    if (sib instanceof HTMLElement) {
      const t = clean(sib.innerText, 100);
      if (t) return t;
    }
    sib = dir === "prev" ? sib.previousElementSibling : sib.nextElementSibling;
    hops++;
  }
  return null;
}

function buildContext(el: HTMLElement, elementId: string): SemanticElement {
  const { name, source } = computeAccessibleName(el);
  const clickable = isNativelyInteractive(el) || hasClickHandler(el);
  const inputType =
    el instanceof HTMLInputElement ? el.type.toLowerCase() : el instanceof HTMLTextAreaElement ? "textarea" : el instanceof HTMLSelectElement ? "select" : null;

  return {
    elementId,
    tagName: el.tagName.toLowerCase(),
    role: roleOf(el),
    accessibleName: name,
    visibleText: clean(el.innerText, 100) || null,
    alt: el instanceof HTMLImageElement ? el.getAttribute("alt") : null,
    placeholder:
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.placeholder || null
        : null,
    inputType,
    title: el.title || null,
    disabled: Boolean((el as HTMLButtonElement).disabled),
    checked: el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : null,
    tabindex: el.tabIndex,
    clickable,
    keyboardAccessible: isKeyboardAccessible(el),
    nearbyText: nearbyText(el) || null,
    nearbyHeading: nearbyHeading(el),
    parentLandmark: parentLandmark(el),
    parentForm: parentFormName(el),
    childSummary: childSummary(el),
    precedingText: siblingText(el, "prev"),
    followingText: siblingText(el, "next"),
    nameSource: source,
  };
}

function issue(
  type: AccessibilityIssueType,
  severity: IssueSeverity,
  context: SemanticElement,
  evidence: string[],
  summary: string,
  seq: number
): AccessibilityIssue {
  return {
    id: `issue-${seq}`,
    elementId: context.elementId,
    type,
    severity,
    context,
    deterministicEvidence: evidence,
    summary,
  };
}

let issueSeq = 0;

/**
 * Scan the document for accessibility issues.
 * Registers elements in the element registry as a side effect.
 */
export function scanAccessibility(): AccessibilityIssue[] {
  elementRegistry.clear();
  issueSeq = 0;
  const issues: AccessibilityIssue[] = [];
  const root = document.body;
  if (!root) return issues;

  const headingLevels: number[] = [];

  function consider(el: HTMLElement): void {
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.tagName === "SVG" || el.closest("svg")) {
      // Still allow walking past SVG roots but skip internals via SKIP... we skip children of svg below
    }
    if (!isVisible(el) && el.tagName !== "IMG") return;

    // Heading hierarchy tracking
    const hm = /^H([1-6])$/.exec(el.tagName);
    if (hm) {
      const level = Number(hm[1]);
      if (headingLevels.length > 0) {
        const prev = headingLevels[headingLevels.length - 1];
        if (level > prev + 1) {
          const id = elementRegistry.register(el);
          const ctx = buildContext(el, id);
          issues.push(
            issue(
              "heading-hierarchy",
              "low",
              ctx,
              [`Heading jumped from h${prev} to h${level}`],
              `Heading level skipped: h${prev} → h${level}`,
              ++issueSeq
            )
          );
        }
      }
      headingLevels.push(level);
    }

    const interactive = isNativelyInteractive(el) || hasClickHandler(el);
    const isImg = el instanceof HTMLImageElement;
    const isFormControl =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement;

    if (!interactive && !isImg && !hm) {
      return;
    }

    // Skip hidden inputs
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === "hidden") return;

    const id = elementRegistry.register(el);
    const ctx = buildContext(el, id);
    const nameOk = Boolean(ctx.accessibleName && ctx.accessibleName.trim());

    // Missing alt text
    if (isImg) {
      const img = el as HTMLImageElement;
      if (img.getAttribute("alt") == null) {
        issues.push(
          issue(
            "missing-alt-text",
            "high",
            ctx,
            ["img has no alt attribute"],
            "Image is missing alt text",
            ++issueSeq
          )
        );
      }
      return;
    }

    // Form controls missing labels (placeholder alone is NOT enough)
    if (isFormControl) {
      const hasLabel =
        Boolean(el.getAttribute("aria-label")?.trim()) ||
        Boolean(el.getAttribute("aria-labelledby")?.trim()) ||
        Boolean(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
        Boolean(el.closest("label"));
      if (!hasLabel) {
        issues.push(
          issue(
            "missing-form-label",
            "high",
            ctx,
            [
              "No <label>, aria-label, or aria-labelledby",
              ctx.placeholder ? `Placeholder only: "${ctx.placeholder}"` : "No placeholder",
            ],
            `Form field missing accessible label${ctx.placeholder ? ` (placeholder: ${ctx.placeholder})` : ""}`,
            ++issueSeq
          )
        );
      }
    }

    // Buttons / links / clickable without accessible name
    if (interactive && !isFormControl) {
      if (!nameOk) {
        issues.push(
          issue(
            "missing-accessible-name",
            "high",
            ctx,
            [
              "No visible text, aria-label, aria-labelledby, or title",
              ctx.childSummary ? `Children: ${ctx.childSummary}` : "No meaningful child text",
            ],
            "Interactive control has no accessible name",
            ++issueSeq
          )
        );
      }
    }

    // Non-semantic interactive (div/span with click, no role)
    if (
      !isNativelyInteractive(el) &&
      hasClickHandler(el) &&
      !roleOf(el)
    ) {
      issues.push(
        issue(
          "non-semantic-interactive",
          "high",
          ctx,
          ["Element is clickable but uses a non-semantic tag without an ARIA role"],
          `Clickable <${ctx.tagName}> lacks semantic role`,
          ++issueSeq
        )
      );
    }

    // Not keyboard accessible
    if (interactive && !isKeyboardAccessible(el) && !(el as HTMLButtonElement).disabled) {
      // Native disabled buttons are still "keyboard accessible" in a sense; skip
      if (!isNativelyInteractive(el) || el.tabIndex < 0) {
        if (!isKeyboardAccessible(el)) {
          issues.push(
            issue(
              "not-keyboard-accessible",
              "high",
              ctx,
              ["Interactive element cannot receive keyboard focus"],
              "Interactive element is not keyboard accessible",
              ++issueSeq
            )
          );
        }
      }
    }
  }

  function walk(el: HTMLElement): void {
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.tagName === "SVG") return;

    consider(el);

    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) walk(child);
    }
  }

  walk(root);

  // Deduplicate: same elementId + type → keep first
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.elementId}:${i.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
