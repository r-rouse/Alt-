/**
 * Semantic DOM parser for PageGuide.
 *
 * Converts the live DOM into a compact semantic text representation for the LLM.
 * Interactive elements receive stable PageGuide IDs via the element registry.
 *
 * Privacy:
 * - Never extract password input values.
 * - Never send cookies, localStorage, sessionStorage, or auth tokens.
 * - Skip hidden fields and non-visible content.
 * - Only runs after the user activates PageGuide (message-driven).
 */

import {
  elementRegistry,
  type ElementType,
  type PageGuideElement,
} from "./elementRegistry";
import type { PageStructureResult } from "../shared/types";

const MAX_CHARS = 14_000;
const MAX_TEXT_LEN = 180;
const MAX_INTERACTIVE = 180;

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "SVG",
  "PATH",
  "TEMPLATE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "LINK",
  "META",
]);

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && !el.getAttribute("aria-label")) {
    return false;
  }
  return true;
}

function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LEN);
}

/**
 * Derive clean human-readable name from href slug when no other label is available.
 * E.g., "/pricing" -> "Pricing", "#collision-report" -> "Collision Report",
 * "mailto:help@city.gov" -> "Email help", "tel:5035550100" -> "Call phone"
 */
function deriveHrefContext(el: HTMLAnchorElement): string {
  const href = el.getAttribute("href");
  if (!href || href === "#" || href.startsWith("javascript:")) return "";

  if (href.startsWith("mailto:")) {
    const email = href.replace("mailto:", "").split("?")[0].trim();
    return email ? `Email ${email}` : "Email link";
  }
  if (href.startsWith("tel:")) {
    const tel = href.replace("tel:", "").trim();
    return tel ? `Call ${tel}` : "Phone link";
  }

  try {
    const u = new URL(href, location.origin);
    if (u.hash && u.hash.length > 1) {
      const slug = u.hash.slice(1).replace(/[-_]/g, " ").trim();
      if (slug) return slug.charAt(0).toUpperCase() + slug.slice(1);
    }
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1].replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").trim();
      if (last && last.length > 1) {
        return last.charAt(0).toUpperCase() + last.slice(1);
      }
    }
  } catch {}

  return "";
}

/**
 * Deterministic accessible name derivation following AccName 1.2 order of precedence:
 * 1. aria-labelledby
 * 2. aria-label
 * 3. Associated label (<label for="..."> or enclosing <label>)
 * 4. Visible text (innerText / textContent)
 * 5. Accessible child text (child svg <title>, img [alt], [aria-label])
 * 6. title attribute
 * 7. placeholder
 * 8. href context (for anchor links)
 */
export function deriveAccessibleName(el: HTMLElement): string {
  // 1. aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (parts) return cleanText(parts);
  }

  // 2. aria-label
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return cleanText(aria);

  // 3. Form input label
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return cleanText(label.textContent);
  }
  const wrapping = el.closest("label");
  if (wrapping?.textContent?.trim()) return cleanText(wrapping.textContent);

  // 4. Visible direct text
  const directText = cleanText(el.innerText || el.textContent);
  if (directText) return directText;

  // 5. Accessible child text (SVG title, img alt, child aria-label)
  const svgTitle = el.querySelector("svg title")?.textContent?.trim();
  if (svgTitle) return cleanText(svgTitle);

  const svgAria = el.querySelector("svg[aria-label]")?.getAttribute("aria-label")?.trim();
  if (svgAria) return cleanText(svgAria);

  const imgAlt = el.querySelector("img")?.getAttribute("alt")?.trim();
  if (imgAlt) return cleanText(imgAlt);

  const imgTitle = el.querySelector("img")?.getAttribute("title")?.trim();
  if (imgTitle) return cleanText(imgTitle);

  const childAria = el.querySelector("[aria-label]")?.getAttribute("aria-label")?.trim();
  if (childAria) return cleanText(childAria);

  // 6. Title attribute
  if (el.title?.trim()) return cleanText(el.title);

  // 7. Placeholder for form controls
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.placeholder?.trim()
  ) {
    return cleanText(el.placeholder);
  }

  // 8. Href context fallback for icon or unlabeled links
  if (el instanceof HTMLAnchorElement) {
    const hrefSlug = deriveHrefContext(el);
    if (hrefSlug) return cleanText(hrefSlug);
  }

  return "";
}

function roleOf(el: HTMLElement): string {
  return el.getAttribute("role") || "";
}

export function deriveElementType(el: HTMLElement): ElementType {
  const tag = el.tagName;
  const role = roleOf(el);

  if (tag === "A" && (el as HTMLAnchorElement).href) return "link";
  if (tag === "BUTTON" || role === "button" || tag === "SUMMARY") return "button";
  if (role === "link") return "link";
  if (role === "tab" || role === "menuitem") return "button";

  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "image") return "button";
    return "input";
  }

  if (tag === "SELECT" || role === "combobox") return "select";
  if (tag === "TEXTAREA" || role === "textbox") return "input";
  if (tag === "IMG") return "image";
  if (/^H[1-6]$/.test(tag)) return "heading";
  if (tag === "SECTION" || tag === "ARTICLE") return "section";

  return "other";
}

function isInteractive(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === "A" && (el as HTMLAnchorElement).href) return true;
  if (tag === "BUTTON") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type.toLowerCase();
    return type !== "hidden";
  }
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "SUMMARY") return true;
  const role = roleOf(el);
  if (
    [
      "button",
      "link",
      "menuitem",
      "tab",
      "checkbox",
      "radio",
      "switch",
      "textbox",
      "combobox",
      "searchbox",
      "option",
    ].includes(role)
  ) {
    return true;
  }
  if (
    el.tabIndex >= 0 &&
    (role || el.getAttribute("onclick") || el.getAttribute("contenteditable") === "true")
  ) {
    return true;
  }
  return false;
}

/**
 * Extract context for an element (containing landmark + nearest preceding heading).
 * Crucial for disambiguating identical links (e.g. multiple "Learn more" or "Pricing").
 */
export function deriveNearbyContext(el: HTMLElement): string {
  const parts: string[] = [];

  // 1. Containing Landmark / Section
  const container = el.closest(
    "nav, header, footer, main, aside, section, article, form, [role='navigation'], [role='banner'], [role='contentinfo'], [role='main']"
  );
  if (container instanceof HTMLElement) {
    const tag = container.tagName;
    const aria = container.getAttribute("aria-label");
    if (tag === "NAV" || container.getAttribute("role") === "navigation") {
      parts.push(aria ? `${aria} (NAV)` : "Main navigation (NAV)");
    } else if (tag === "HEADER" || container.getAttribute("role") === "banner") {
      parts.push("Header");
    } else if (tag === "FOOTER" || container.getAttribute("role") === "contentinfo") {
      parts.push("Footer");
    } else if (tag === "FORM") {
      const formName =
        aria ||
        container.getAttribute("name") ||
        cleanText(container.querySelector("h1,h2,h3,legend")?.textContent);
      parts.push(formName ? `Form (${formName})` : "Form");
    } else if (tag === "SECTION" || tag === "ARTICLE") {
      const secHeading = cleanText(container.querySelector("h1,h2,h3,h4")?.textContent);
      if (secHeading) parts.push(`${secHeading} (${tag})`);
      else if (aria) parts.push(`${aria} (${tag})`);
    }
  }

  // 2. Preceding Heading if not already captured
  if (parts.length === 0 || parts[0].includes("NAV") || parts[0] === "Header" || parts[0] === "Footer") {
    const allHeadings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    let closestHeading: HTMLElement | null = null;
    for (const h of allHeadings) {
      if (h instanceof HTMLElement && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        closestHeading = h;
      } else {
        break;
      }
    }
    if (closestHeading) {
      const headingText = cleanText(closestHeading.textContent);
      if (headingText && !parts.some((p) => p.includes(headingText))) {
        parts.push(headingText);
      }
    }
  }

  return parts.join(" — ");
}

function describeInteractive(
  el: HTMLElement,
  id: string,
  record: PageGuideElement
): string {
  const lines: string[] = [];

  lines.push(`[${record.type} #${id}]`);
  lines.push(`Name: ${record.accessibleName || "(unnamed)"}`);

  if (record.nearbyHeading) {
    lines.push(`Context: ${record.nearbyHeading}`);
  }

  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    lines.push(`InputType: ${type}`);
    if (type === "password") {
      lines.push("Value: [password — not shared]");
    } else if (type === "checkbox" || type === "radio") {
      lines.push(`Checked: ${el.checked}`);
    } else if (el.value && type !== "hidden") {
      const shown = el.value.length > 40 ? `${el.value.slice(0, 40)}…` : el.value;
      lines.push(`Value: ${cleanText(shown)}`);
    }
    if (el.required) lines.push("Required: true");
    if (el.disabled) lines.push("Disabled: true");
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value) lines.push(`Value: ${cleanText(el.value.slice(0, 40))}`);
    if (el.required) lines.push("Required: true");
    if (el.disabled) lines.push("Disabled: true");
  } else if (el instanceof HTMLSelectElement) {
    const selected = el.selectedOptions[0]?.textContent;
    if (selected) lines.push(`Selected: ${cleanText(selected)}`);
    if (el.disabled) lines.push("Disabled: true");
  } else if (record.href) {
    lines.push(`Href: ${record.href}`);
  }

  if ((el as HTMLButtonElement).disabled) lines.push("Disabled: true");

  const pressed = el.getAttribute("aria-pressed");
  if (pressed != null) lines.push(`Pressed: ${pressed}`);
  const expanded = el.getAttribute("aria-expanded");
  if (expanded != null) lines.push(`Expanded: ${expanded}`);

  return lines.join("\n");
}

function landmarkLabel(el: HTMLElement): string | null {
  const tag = el.tagName;
  const role = roleOf(el);
  if (tag === "MAIN" || role === "main") return "MAIN";
  if (tag === "NAV" || role === "navigation") return "NAVIGATION";
  if (tag === "HEADER" || role === "banner") return "HEADER";
  if (tag === "FOOTER" || role === "contentinfo") return "FOOTER";
  if (tag === "ASIDE" || role === "complementary") return "ASIDE";
  if (role === "search") return "SEARCH";
  if (tag === "FORM" || role === "form") {
    const name = deriveAccessibleName(el) || el.getAttribute("name") || "";
    return name ? `FORM (${cleanText(name)})` : "FORM";
  }
  if (tag === "ARTICLE" || role === "article") return "ARTICLE";
  if (role === "region") {
    const name = deriveAccessibleName(el);
    return name ? `REGION (${name})` : "REGION";
  }
  return null;
}

function headingLine(el: HTMLElement): string | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (!m) return null;
  const text = cleanText(el.textContent);
  if (!text) return null;
  return `[h${m[1]}] ${text}`;
}

function listSummary(el: HTMLElement): string | null {
  if (el.tagName !== "UL" && el.tagName !== "OL") return null;
  const items = Array.from(el.children).filter((c) => c.tagName === "LI");
  if (items.length === 0) return null;
  const preview = items
    .slice(0, 5)
    .map((li) => cleanText(li.textContent).slice(0, 60))
    .filter(Boolean);
  return `[list] ${items.length} items: ${preview.join(" | ")}${items.length > 5 ? " …" : ""}`;
}

function tableSummary(el: HTMLElement): string | null {
  if (el.tagName !== "TABLE") return null;
  const caption = cleanText(el.querySelector("caption")?.textContent);
  const rows = el.querySelectorAll("tr").length;
  const headers = Array.from(el.querySelectorAll("th"))
    .slice(0, 6)
    .map((th) => cleanText(th.textContent))
    .filter(Boolean);
  const parts = [`[table] ${rows} rows`];
  if (caption) parts.push(`Caption: ${caption}`);
  if (headers.length) parts.push(`Headers: ${headers.join(", ")}`);
  return parts.join(" — ");
}

/**
 * Build a compact semantic page representation and populate/refresh the element registry.
 * Guarantees stable IDs across re-parses.
 */
export function parsePage(): PageStructureResult {
  elementRegistry.clear();

  const lines: string[] = [];
  lines.push("PAGE");
  lines.push(`Title: ${document.title || "(untitled)"}`);
  lines.push(`URL: ${location.href}`);
  lines.push("");

  let interactiveCount = 0;
  let truncated = false;
  const seenLandmarks = new Set<HTMLElement>();
  const emittedInteractives = new Set<HTMLElement>();

  const root = document.body;
  if (!root) {
    return {
      text: lines.join("\n") + "\n(empty document body)",
      meta: { title: document.title, url: location.href },
      interactiveCount: 0,
      truncated: false,
    };
  }

  function emitInteractive(el: HTMLElement): void {
    if (emittedInteractives.has(el)) return;
    if (!isVisible(el) || !isInteractive(el)) return;
    if (interactiveCount >= MAX_INTERACTIVE) {
      truncated = true;
      return;
    }
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === "hidden") return;

    const name = deriveAccessibleName(el);
    const type = deriveElementType(el);
    const context = deriveNearbyContext(el);
    let href: string | undefined;
    if (el instanceof HTMLAnchorElement && el.href) {
      try {
        const u = new URL(el.href);
        href = u.origin === location.origin ? `${u.pathname}${u.search}` : `${u.origin}${u.pathname}`;
      } catch {
        href = el.getAttribute("href") || undefined;
      }
    }

    const id = elementRegistry.register(el, {
      type,
      accessibleName: name,
      text: cleanText(el.innerText || el.textContent),
      href,
      role: roleOf(el),
      nearbyHeading: context,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      title: el.title || undefined,
      disabled: Boolean(
        (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true"
      ),
      visible: true,
    });

    const record = elementRegistry.getRecord(id);
    emittedInteractives.add(el);
    interactiveCount++;
    if (record) {
      lines.push(describeInteractive(el, id, record));
      lines.push("");
    }
  }

  function walk(el: HTMLElement, depth: number): void {
    if (truncated || lines.join("\n").length > MAX_CHARS) {
      truncated = true;
      return;
    }
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!isVisible(el) && !landmarkLabel(el)) return;

    const landmark = landmarkLabel(el);
    if (landmark && !seenLandmarks.has(el)) {
      seenLandmarks.add(el);
      lines.push(landmark);
      lines.push("");
    }

    const heading = headingLine(el);
    if (heading) {
      lines.push(heading);
      lines.push("");
    }

    const list = listSummary(el);
    if (list && depth < 8) {
      lines.push(list);
      lines.push("");
    }

    const table = tableSummary(el);
    if (table) {
      lines.push(table);
      lines.push("");
    }

    if (isInteractive(el)) {
      emitInteractive(el);
    }

    if (el.tagName === "SVG") return;

    const children = Array.from(el.children);
    for (const child of children) {
      if (child instanceof HTMLElement) walk(child, depth + 1);
      if (truncated) return;
    }
  }

  walk(root, 0);

  if (truncated) {
    lines.push("");
    lines.push(
      "(Page representation truncated for size. Use getSection or listInteractiveElements for details.)"
    );
  }

  if (interactiveCount === 0 && root.innerText.trim().length > 0) {
    const snippet = cleanText(root.innerText).slice(0, 500);
    lines.push("CONTENT SNIPPET");
    lines.push(snippet);
  }

  return {
    text: lines.join("\n").trim(),
    meta: { title: document.title || "(untitled)", url: location.href },
    interactiveCount,
    truncated,
  };
}

export function getSectionText(elementId: string): { success: boolean; message: string } {
  const el = elementRegistry.get(elementId);
  if (!el) {
    return {
      success: false,
      message:
        "That element is no longer available on the page. The page may have changed. I'll refresh my understanding of it.",
    };
  }
  const text = cleanText(el.innerText || el.textContent).slice(0, 2000);
  const name = deriveAccessibleName(el);
  return {
    success: true,
    message: `Section ${elementId}${name ? ` (${name})` : ""}:\n${text || "(no text content)"}`,
  };
}

export function listInteractiveSummary(): { success: boolean; message: string } {
  const entries = elementRegistry.entries();
  if (entries.length === 0) {
    parsePage();
  }
  const fresh = elementRegistry.entries();
  if (fresh.length === 0) {
    return { success: true, message: "No interactive elements were found on this page." };
  }
  const lines = fresh.slice(0, 100).map(([id, el]) => {
    const record = elementRegistry.getRecord(id);
    const tag = record?.type || roleOf(el) || el.tagName.toLowerCase();
    const name = record?.accessibleName || deriveAccessibleName(el) || "(unnamed)";
    const ctx = record?.nearbyHeading ? ` [${record.nearbyHeading}]` : "";
    return `- [${tag} #${id}] ${name}${ctx}`;
  });
  if (fresh.length > 100) lines.push(`… and ${fresh.length - 100} more`);
  return {
    success: true,
    message: `Interactive elements (${fresh.length}):\n${lines.join("\n")}`,
  };
}
