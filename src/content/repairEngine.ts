/**
 * Runtime repair engine — applies minimal, reversible accessibility semantics.
 * Never executes AI-generated JavaScript. Never modifies business data.
 */

import { elementRegistry } from "./elementRegistry";
import type {
  AppliedRepair,
  InferenceResult,
  ProposedRepair,
  SemanticSource,
  SuggestedRepair,
} from "../shared/accessibility";
import { CONFIDENCE } from "../shared/accessibility";

let repairsEnabled = true;
let applied: AppliedRepair[] = [];
let suggested: SuggestedRepair[] = [];
/** Snapshot used when repairs are toggled OFF so we can restore ON */
let disabledSnapshot: AppliedRepair[] = [];
let repairSeq = 0;

const keyHandlerElements = new WeakSet<HTMLElement>();

function onActivationKey(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.currentTarget as HTMLElement;
  e.preventDefault();
  el.click();
}

function ensureButtonKeyboard(el: HTMLElement): boolean {
  if (keyHandlerElements.has(el)) return false;
  el.addEventListener("keydown", onActivationKey);
  keyHandlerElements.add(el);
  return true;
}

function removeButtonKeyboard(el: HTMLElement): void {
  if (!keyHandlerElements.has(el)) return;
  el.removeEventListener("keydown", onActivationKey);
  keyHandlerElements.delete(el);
}

export function getRepairsEnabled(): boolean {
  return repairsEnabled;
}

export function getAppliedRepairs(): AppliedRepair[] {
  return repairsEnabled ? [...applied] : [...disabledSnapshot];
}

export function getSuggestedRepairs(): SuggestedRepair[] {
  return [...suggested];
}

export function setSuggestedRepairs(list: SuggestedRepair[]): void {
  suggested = list;
}

function setAttr(el: HTMLElement, attr: string, value: string): string | null {
  const prev = el.hasAttribute(attr) ? el.getAttribute(attr) : null;
  el.setAttribute(attr, value);
  el.dataset.pageguideRepaired = "true";
  return prev;
}

function restoreAttr(el: HTMLElement, attr: string, previousValue: string | null): void {
  if (previousValue == null) el.removeAttribute(attr);
  else el.setAttribute(attr, previousValue);
}

function applyOne(
  el: HTMLElement,
  repair: ProposedRepair,
  meta: {
    issueId: string;
    elementId: string;
    confidence: number;
    reason: string;
    source: SemanticSource;
  }
): AppliedRepair | null {
  const allowed = ["aria-label", "aria-labelledby", "role", "tabindex", "alt", "title"];
  if (!allowed.includes(repair.attribute)) return null;

  const existing = el.getAttribute(repair.attribute);
  if (
    existing &&
    existing.trim() &&
    (repair.attribute === "aria-label" || repair.attribute === "alt")
  ) {
    // Never clobber a non-empty native accessible name / alt
    return null;
  }

  const previousValue = setAttr(el, repair.attribute, repair.value);
  let addedKeyHandler = false;

  if (
    repair.attribute === "role" &&
    repair.value === "button" &&
    !el.matches("button, a[href], input, select, textarea")
  ) {
    addedKeyHandler = ensureButtonKeyboard(el);
  }

  const record: AppliedRepair = {
    id: `repair-${++repairSeq}`,
    issueId: meta.issueId,
    elementId: meta.elementId,
    attribute: repair.attribute,
    previousValue,
    newValue: repair.value,
    confidence: meta.confidence,
    reason: meta.reason,
    source: meta.source,
    addedKeyHandler,
  };
  applied.push(record);
  return record;
}

export function recordAppliedRepair(record: AppliedRepair): void {
  // Remove existing repair for same element and attribute if any
  applied = applied.filter(
    (r) => !(r.elementId === record.elementId && r.attribute === record.attribute)
  );
  applied.push(record);
}

export function applyInference(inference: InferenceResult): {
  applied: AppliedRepair[];
  suggested: SuggestedRepair | null;
} {
  if (inference.confidence < CONFIDENCE.SUGGEST) {
    const s: SuggestedRepair = {
      issueId: inference.issueId,
      elementId: inference.elementId,
      inference,
      status: "skipped-low-confidence",
    };
    suggested.push(s);
    return { applied: [], suggested: s };
  }

  if (inference.confidence < CONFIDENCE.AUTO_APPLY || !repairsEnabled) {
    const s: SuggestedRepair = {
      issueId: inference.issueId,
      elementId: inference.elementId,
      inference,
      status: "suggested",
    };
    suggested.push(s);
    return { applied: [], suggested: s };
  }

  const el = elementRegistry.get(inference.elementId);
  if (!el) return { applied: [], suggested: null };

  const appliedNow: AppliedRepair[] = [];
  for (const repair of inference.repairs) {
    const record = applyOne(el, repair, {
      issueId: inference.issueId,
      elementId: inference.elementId,
      confidence: inference.confidence,
      reason: inference.reason,
      source: inference.source,
    });
    if (record) appliedNow.push(record);
  }
  return { applied: appliedNow, suggested: null };
}

export function applyInferences(inferences: InferenceResult[]): AppliedRepair[] {
  const all: AppliedRepair[] = [];
  for (const inf of inferences) {
    all.push(...applyInference(inf).applied);
  }
  return all;
}

function restoreAllFromList(list: AppliedRepair[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const repair = list[i];
    const el = elementRegistry.get(repair.elementId);
    if (el) {
      restoreAttr(el, repair.attribute, repair.previousValue);
      if (repair.addedKeyHandler) removeButtonKeyboard(el);
      delete el.dataset.pageguideRepaired;
    }
  }
}

export function undoRepair(repairId: string): boolean {
  const idx = applied.findIndex((r) => r.id === repairId);
  if (idx < 0) return false;
  const repair = applied[idx];
  const el = elementRegistry.get(repair.elementId);
  if (el) {
    restoreAttr(el, repair.attribute, repair.previousValue);
    if (repair.addedKeyHandler) removeButtonKeyboard(el);
    if (!applied.some((r, i) => i !== idx && r.elementId === repair.elementId)) {
      delete el.dataset.pageguideRepaired;
    }
  }
  applied.splice(idx, 1);
  return true;
}

export function undoAllRepairs(): void {
  restoreAllFromList(applied);
  applied = [];
  disabledSnapshot = [];
}

export function setRepairsEnabled(enabled: boolean): void {
  if (enabled === repairsEnabled) return;

  if (!enabled) {
    disabledSnapshot = applied.map((r) => ({ ...r }));
    restoreAllFromList(applied);
    applied = [];
    repairsEnabled = false;
    return;
  }

  repairsEnabled = true;
  const snapshot = disabledSnapshot;
  disabledSnapshot = [];

  for (const repair of snapshot) {
    const el = elementRegistry.get(repair.elementId);
    if (!el) continue;
    const previousValue = setAttr(el, repair.attribute, repair.newValue);
    let addedKeyHandler = false;
    if (
      repair.attribute === "role" &&
      repair.newValue === "button" &&
      !el.matches("button, a[href], input, select, textarea")
    ) {
      addedKeyHandler = ensureButtonKeyboard(el);
    }
    applied.push({
      ...repair,
      id: `repair-${++repairSeq}`,
      previousValue,
      addedKeyHandler,
    });
  }
}

export function resetRepairState(undoDom: boolean): void {
  if (undoDom) {
    restoreAllFromList(applied);
    restoreAllFromList(disabledSnapshot);
  }
  applied = [];
  suggested = [];
  disabledSnapshot = [];
  repairSeq = 0;
  repairsEnabled = true;
}
