/**
 * High-confidence deterministic repairs from local heuristics (no AI).
 * Prefer these when context is unambiguous — wrong labels are worse than missing ones.
 */

import type { AccessibilityIssue, InferenceResult, ProposedRepair } from "../shared/accessibility";

function repairsForNameAndRole(
  name: string,
  needsRole: boolean,
  needsTabindex: boolean,
  needsAlt: boolean
): ProposedRepair[] {
  const repairs: ProposedRepair[] = [];
  if (needsAlt) {
    repairs.push({ attribute: "alt", value: name });
  } else {
    repairs.push({ attribute: "aria-label", value: name });
  }
  if (needsRole) repairs.push({ attribute: "role", value: "button" });
  if (needsTabindex) repairs.push({ attribute: "tabindex", value: "0" });
  return repairs;
}

/**
 * Try to invent a safe accessible name from surrounding context.
 * Returns null when uncertain.
 */
export function deterministicInference(issue: AccessibilityIssue): InferenceResult | null {
  const c = issue.context;
  const needsRole =
    issue.type === "non-semantic-interactive" ||
    (c.clickable && !c.role && c.tagName !== "button" && c.tagName !== "a" && c.tagName !== "input");
  const needsTabindex =
    issue.type === "not-keyboard-accessible" ||
    (needsRole && !c.keyboardAccessible);
  const needsAlt = issue.type === "missing-alt-text";

  // Form label from placeholder — only when placeholder is descriptive
  if (issue.type === "missing-form-label" && c.placeholder) {
    const ph = c.placeholder.trim();
    if (ph.length >= 3 && !/^enter\b/i.test(ph)) {
      let name = ph;
      // Soften "you@example.com" → Email address
      if (/@/.test(ph) || c.inputType === "email") name = "Email address";
      else if (c.inputType === "tel") name = "Phone number";
      else if (c.inputType === "search") name = "Search";
      else if (/promo|coupon|code/i.test(ph)) name = "Promo code";

      return {
        elementId: c.elementId,
        issueId: issue.id,
        inferredRole: null,
        accessibleName: name,
        repairs: [{ attribute: "aria-label", value: name }],
        confidence: c.inputType === "email" || /@/.test(ph) ? 0.93 : 0.91,
        reason: `Inferred form label from placeholder and input type (${c.inputType || "text"}).`,
        source: "deterministic",
      };
    }
  }

  // Missing name on icon button — use nearby text / heading
  if (
    issue.type === "missing-accessible-name" ||
    issue.type === "non-semantic-interactive" ||
    issue.type === "not-keyboard-accessible"
  ) {
    const nearby = `${c.nearbyText || ""} ${c.precedingText || ""} ${c.followingText || ""}`.toLowerCase();
    const heading = (c.nearbyHeading || "").toLowerCase();
    const child = (c.childSummary || "").toLowerCase();
    const landmark = (c.parentLandmark || "").toLowerCase();

    let name: string | null = null;
    let confidence = 0;

    // Cart patterns
    if (/(\d+)\s*items?/.test(nearby) || /cart/.test(nearby + child + landmark)) {
      const m = nearby.match(/(\d+)\s*items?/);
      name = m ? `Shopping cart, ${m[1]} items` : "Shopping cart";
      confidence = 0.94;
    } else if (/menu|hamburger|nav/.test(child + nearby + landmark)) {
      name = "Open navigation menu";
      confidence = 0.92;
    } else if (/search/.test(child + nearby + landmark + (c.placeholder || ""))) {
      name = "Search";
      confidence = 0.93;
    } else if (
      /checkout|order summary|total:|proceed|continue/.test(nearby + heading + landmark) &&
      (child.includes("svg") || child.includes("arrow") || !c.visibleText)
    ) {
      name = "Proceed to checkout";
      confidence = 0.94;
    } else if (/close|dismiss/.test(nearby + child)) {
      name = "Close";
      confidence = 0.9;
    } else if (c.precedingText && c.precedingText.length < 40 && /total|shipping|subtotal/i.test(c.precedingText)) {
      name = "Proceed to checkout";
      confidence = 0.91;
    }

    // Keyboard-only issue with existing name — just make focusable
    if (issue.type === "not-keyboard-accessible" && c.accessibleName) {
      const repairs: ProposedRepair[] = [];
      if (needsRole) repairs.push({ attribute: "role", value: "button" });
      repairs.push({ attribute: "tabindex", value: "0" });
      return {
        elementId: c.elementId,
        issueId: issue.id,
        inferredRole: needsRole ? "button" : c.role,
        accessibleName: c.accessibleName,
        repairs,
        confidence: 0.95,
        reason: "Element is interactive but not focusable; adding keyboard access.",
        source: "deterministic",
      };
    }

    if (name && confidence >= 0.9) {
      return {
        elementId: c.elementId,
        issueId: issue.id,
        inferredRole: needsRole ? "button" : c.role,
        accessibleName: name,
        repairs: repairsForNameAndRole(name, needsRole, needsTabindex || needsRole, false),
        confidence,
        reason: `Deterministic inference from nearby context (“${(c.nearbyText || c.nearbyHeading || "").slice(0, 60)}”).`,
        source: "deterministic",
      };
    }
  }

  // Missing alt — use nearby text cautiously
  if (issue.type === "missing-alt-text") {
    if (/cart/.test(`${c.nearbyText} ${c.parentLandmark}`)) {
      return {
        elementId: c.elementId,
        issueId: issue.id,
        inferredRole: "img",
        accessibleName: "Shopping cart",
        repairs: [{ attribute: "alt", value: "Shopping cart" }],
        confidence: 0.9,
        reason: "Image near cart-related text.",
        source: "deterministic",
      };
    }
    // Decorative icons inside labeled buttons — empty alt is safer; leave for AI
  }

  // Heading hierarchy — do not auto-"fix" by changing levels (risky). Skip.
  if (issue.type === "heading-hierarchy") {
    return {
      elementId: c.elementId,
      issueId: issue.id,
      inferredRole: null,
      accessibleName: c.accessibleName,
      repairs: [],
      confidence: 0.4,
      reason: "Heading hierarchy issues are reported but not auto-modified (risk of incorrect structure).",
      source: "deterministic",
    };
  }

  return null;
}
