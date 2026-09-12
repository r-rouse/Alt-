/**
 * Constrained DOM actions. The model chooses WHAT; this code decides HOW safely.
 *
 * Deterministic browser execution for keyboard focus, robust activation, scrolling,
 * and form input.
 */

import { elementRegistry, type PageGuideElement } from "./elementRegistry";
import type { ToolResult } from "../shared/types";

const DESTRUCTIVE_PATTERNS =
  /\b(delete|remove account|deactivate|purchase|buy now|pay now|checkout|place order|confirm payment|transfer|unsubscribe|wipe|destroy)\b/i;

function resolve(
  elementId: string
): { el?: HTMLElement; record?: PageGuideElement; error?: ToolResult } {
  const normalized = elementId.startsWith("pg-") ? elementId : `pg-${elementId}`;
  let el = elementRegistry.get(normalized);
  let record = elementRegistry.getRecord(normalized);

  // Fallback: search DOM by dataset attribute if node was re-attached
  if (!el) {
    try {
      const found = document.querySelector<HTMLElement>(
        `[data-pageguide-id="${CSS.escape(normalized)}"]`
      );
      if (found && document.contains(found)) {
        el = found;
      }
    } catch {}
  }

  if (!el) {
    return {
      error: {
        success: false,
        message:
          "That control is no longer available on the page. The page may have changed. Ask me again after I refresh the page structure.",
      },
    };
  }

  return { el, record };
}

function ensureFocusable(el: HTMLElement): void {
  if (
    el.tabIndex < 0 &&
    !el.matches("a,button,input,select,textarea,summary,[contenteditable=true]")
  ) {
    el.tabIndex = -1;
  }
}

function highlightElement(el: HTMLElement): void {
  try {
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "3px solid #005fcc";
    el.style.outlineOffset = "2px";
    window.setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 2500);
  } catch {}
}

export function focusElement(elementId: string): ToolResult {
  const { el, record, error } = resolve(elementId);
  if (error || !el) return error!;

  // Target the interactive element or ancestor
  const target =
    el.closest<HTMLElement>(
      "a, button, input, select, textarea, summary, [tabindex], [role='button'], [role='link']"
    ) || el;

  try {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    ensureFocusable(target);
    target.focus({ preventScroll: true });
    highlightElement(target);

    const label =
      record?.accessibleName ||
      target.getAttribute("aria-label") ||
      target.textContent?.trim().slice(0, 80) ||
      target.tagName.toLowerCase();

    return {
      success: true,
      message: `Focused: ${label} (${elementId}). Keyboard focus is now on that control.`,
    };
  } catch {
    return {
      success: false,
      message: "I couldn't move focus to that control. It may not be focusable.",
    };
  }
}

export function scrollToElement(elementId: string): ToolResult {
  const { el, error } = resolve(elementId);
  if (error || !el) return error!;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  highlightElement(el);
  return {
    success: true,
    message: `Scrolled to ${elementId}. Keyboard focus remains where it was.`,
  };
}

/**
 * Robust activation of interactive elements:
 * - Dispatches full realistic pointerdown, mousedown, pointerup, mouseup, click events
 * - Handles anchor navigation (in-page hash jumping & hrefs)
 * - Toggles checkboxes, radio buttons, and <details>/<summary>
 * - Guards destructive actions with confirmation
 */
export function clickElement(elementId: string, confirmed = false): ToolResult {
  const { el, record, error } = resolve(elementId);
  if (error || !el) return error!;

  // Find the primary interactive element if this was a wrapper or child
  const interactiveAncestor = el.closest<HTMLElement>(
    "a[href], button, [role='button'], [role='link'], [role='tab'], [role='menuitem'], input, select, textarea, summary"
  );
  const target = interactiveAncestor || el;

  const label =
    record?.accessibleName ||
    target.getAttribute("aria-label") ||
    (target.textContent || "").trim().slice(0, 120) ||
    target.tagName.toLowerCase();

  // Confirmation guard for high-impact actions
  if (!confirmed && DESTRUCTIVE_PATTERNS.test(label)) {
    return {
      success: false,
      message: `I need your confirmation before clicking “${label}” because it may be a consequential action (purchase, delete, checkout, etc.). Reply “yes, click it” if you want me to proceed.`,
      data: { needsConfirmation: true, elementId, label },
    };
  }

  // Check disabled status
  const isDisabled =
    (target as HTMLButtonElement).disabled ||
    target.getAttribute("aria-disabled") === "true" ||
    target.classList.contains("disabled");

  if (isDisabled) {
    return { success: false, message: `“${label}” is disabled and cannot be activated.` };
  }

  try {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    ensureFocusable(target);
    target.focus({ preventScroll: true });
    highlightElement(target);

    // Realistic synthetic pointer and mouse event sequence for modern SPAs
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1,
      clientX,
      clientY,
    };

    if (typeof PointerEvent !== "undefined") {
      try {
        target.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, isPrimary: true }));
      } catch {}
    }
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));

    if (typeof PointerEvent !== "undefined") {
      try {
        target.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, isPrimary: true }));
      } catch {}
    }
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));

    // Native click
    target.click();

    // In-page anchor navigation support
    if (target instanceof HTMLAnchorElement && target.hash) {
      const hash = target.hash;
      const anchorTarget = document.querySelector(hash) || document.getElementById(hash.slice(1));
      if (anchorTarget instanceof HTMLElement) {
        anchorTarget.scrollIntoView({ behavior: "smooth", block: "start" });
        ensureFocusable(anchorTarget);
        anchorTarget.focus({ preventScroll: true });
      } else {
        location.hash = hash;
      }
    }

    // Toggle details/summary disclosure
    const details = target.closest("details");
    if (target.tagName === "SUMMARY" && details) {
      details.open = !details.open;
    }

    // Checkbox and radio toggle
    if (target instanceof HTMLInputElement) {
      if (target.type === "checkbox") {
        target.checked = !target.checked;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (target.type === "radio") {
        target.checked = true;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    return { success: true, message: `Activated: ${label} (${elementId}).` };
  } catch {
    return { success: false, message: `I couldn't activate “${label}”.` };
  }
}

export function getElementText(elementId: string): ToolResult {
  const { el, error } = resolve(elementId);
  if (error || !el) return error!;
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  return {
    success: true,
    message: text || "(no visible text)",
  };
}

export function fillInput(elementId: string, value: string): ToolResult {
  const { el, error } = resolve(elementId);
  if (error || !el) return error!;

  if (el instanceof HTMLInputElement && el.type.toLowerCase() === "password") {
    return {
      success: false,
      message:
        "For your privacy and security, PageGuide does not fill password fields. Please enter the password yourself once focus is on the field.",
    };
  }

  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLSelectElement) &&
    el.getAttribute("contenteditable") !== "true"
  ) {
    return {
      success: false,
      message: "That element is not a text input I can fill. I can focus it instead if you want.",
    };
  }

  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) {
    return { success: false, message: "That field is disabled or read-only." };
  }

  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();
    highlightElement(el);

    if (el instanceof HTMLSelectElement) {
      const match = Array.from(el.options).find(
        (o) =>
          o.text.toLowerCase().includes(value.toLowerCase()) ||
          o.value.toLowerCase() === value.toLowerCase()
      );
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true, message: `Selected “${match.text}” in ${elementId}.` };
      }
      return {
        success: false,
        message: `I couldn't find an option matching “${value}”. Options are: ${Array.from(el.options).map((o) => o.text).join(", ")}`,
      };
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.textContent = value;
    }

    const fieldLabel =
      el.getAttribute("aria-label") ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) ||
      "field";

    return { success: true, message: `Entered value in ${fieldLabel} (${elementId}).` };
  } catch {
    return { success: false, message: "I couldn't set the value on that field." };
  }
}

export interface ResolvedElementUrlResult {
  resolvedUrl: string | null;
  elementId: string;
  label: string;
  isLink: boolean;
}

/**
 * Deterministically resolves the absolute URL of an element from the semantic registry / DOM.
 * Never allows the LLM to invent or hallucinate URLs.
 * Validates protocol to strictly allow http: and https:, rejecting dangerous protocols like javascript: or data:.
 */
export function resolveElementUrl(elementId: string): ResolvedElementUrlResult {
  const { el, record } = resolve(elementId);
  const label =
    record?.accessibleName ||
    el?.getAttribute("aria-label") ||
    (el?.textContent || "").trim().slice(0, 80) ||
    elementId;

  if (!el) {
    return {
      resolvedUrl: null,
      elementId,
      label,
      isLink: false,
    };
  }

  // Check if el itself is an anchor or has an anchor ancestor/descendant
  const anchor =
    (el instanceof HTMLAnchorElement ? el : null) ||
    el.closest<HTMLAnchorElement>("a[href]") ||
    el.querySelector<HTMLAnchorElement>("a[href]");

  let rawHref = anchor?.getAttribute("href") || record?.href || "";

  if (!rawHref && anchor?.href) {
    rawHref = anchor.href;
  }

  if (!rawHref) {
    const dataUrl = el.getAttribute("data-url") || el.getAttribute("data-href");
    if (dataUrl) rawHref = dataUrl;
  }

  const cleanHref = rawHref.trim();

  // Reject empty, hash-only, or dangerous protocols
  if (
    !cleanHref ||
    cleanHref === "#" ||
    cleanHref.toLowerCase().startsWith("javascript:") ||
    cleanHref.toLowerCase().startsWith("data:") ||
    cleanHref.toLowerCase().startsWith("file:")
  ) {
    return {
      resolvedUrl: null,
      elementId,
      label,
      isLink: Boolean(anchor),
    };
  }

  try {
    const resolved = new URL(cleanHref, window.location.href);
    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      return {
        resolvedUrl: resolved.href,
        elementId,
        label,
        isLink: true,
      };
    }
  } catch {
    // Malformed URL string
  }

  return {
    resolvedUrl: null,
    elementId,
    label,
    isLink: Boolean(anchor),
  };
}
