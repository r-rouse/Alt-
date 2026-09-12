/**
 * Orchestrates scan → deterministic repair → (AI inferences applied from side panel).
 */

import { scanAccessibility } from "./accessibilityScanner";
import { deterministicInference } from "./deterministicRepairs";
import {
  applyInferences,
  getAppliedRepairs,
  getRepairsEnabled,
  getSuggestedRepairs,
  resetRepairState,
  setSuggestedRepairs,
} from "./repairEngine";
import type {
  AccessibilityIssue,
  AccessibilityScanResult,
  InferenceResult,
  ScanSummary,
} from "../shared/accessibility";
import { pauseMutationWatcher } from "./mutationWatcher";

let lastIssues: AccessibilityIssue[] = [];

function buildSummary(
  issues: AccessibilityIssue[],
  repairedCount: number,
  suggestedCount: number,
  skippedCount: number
): ScanSummary {
  const byType: Record<string, number> = {};
  for (const i of issues) {
    byType[i.type] = (byType[i.type] || 0) + 1;
  }
  return {
    issueCount: issues.length,
    repairedCount,
    suggestedCount,
    skippedCount,
    byType,
  };
}

function announcement(summary: ScanSummary): string {
  if (summary.issueCount === 0) {
    return "PageGuide found no accessibility issues on this page.";
  }
  return `PageGuide found ${summary.issueCount} potential accessibility issue${summary.issueCount === 1 ? "" : "s"} and repaired ${summary.repairedCount} high-confidence issue${summary.repairedCount === 1 ? "" : "s"}.`;
}

export function getLastIssues(): AccessibilityIssue[] {
  return lastIssues;
}

/**
 * Deterministic scan + local heuristic repairs (no network).
 */
export function runDeterministicScan(): AccessibilityScanResult {
  pauseMutationWatcher(true);
  try {
    resetRepairState(true);
    const issues = scanAccessibility();
    lastIssues = issues;

    const inferences: InferenceResult[] = [];
    const unresolved: AccessibilityIssue[] = [];
    const skipped: import("../shared/accessibility").SuggestedRepair[] = [];

    for (const issue of issues) {
      const det = deterministicInference(issue);
      if (det && det.repairs.length > 0) {
        inferences.push(det);
      } else if (det && det.repairs.length === 0) {
        skipped.push({
          issueId: issue.id,
          elementId: issue.elementId,
          inference: det,
          status: "skipped-low-confidence",
        });
      } else {
        unresolved.push(issue);
      }
    }

    setSuggestedRepairs(skipped);
    applyInferences(inferences);

    const applied = getAppliedRepairs();
    const suggested = getSuggestedRepairs();
    const summary = buildSummary(
      issues,
      new Set(applied.map((r) => r.issueId)).size,
      suggested.filter((s) => s.status === "suggested").length + unresolved.length,
      suggested.filter((s) => s.status === "skipped-low-confidence").length
    );

    return {
      meta: { title: document.title || "(untitled)", url: location.href },
      issues,
      appliedRepairs: applied,
      suggestedRepairs: suggested,
      summary,
      repairsEnabled: getRepairsEnabled(),
      announcement: announcement(summary),
    };
  } finally {
    pauseMutationWatcher(false);
  }
}

export function issuesNeedingAi(): AccessibilityIssue[] {
  const repaired = new Set(getAppliedRepairs().map((r) => r.issueId));
  const suggestedIds = new Set(getSuggestedRepairs().map((s) => s.issueId));
  return lastIssues.filter(
    (i) =>
      !repaired.has(i.id) &&
      !suggestedIds.has(i.id) &&
      i.type !== "heading-hierarchy"
  );
}

export function applyAiInferences(inferences: InferenceResult[]): AccessibilityScanResult {
  pauseMutationWatcher(true);
  try {
    applyInferences(inferences);
    const applied = getAppliedRepairs();
    const suggested = getSuggestedRepairs();
    const summary = buildSummary(
      lastIssues,
      new Set(applied.map((r) => r.issueId)).size,
      suggested.filter((s) => s.status === "suggested").length,
      suggested.filter((s) => s.status === "skipped-low-confidence").length
    );
    return {
      meta: { title: document.title || "(untitled)", url: location.href },
      issues: lastIssues,
      appliedRepairs: applied,
      suggestedRepairs: suggested,
      summary,
      repairsEnabled: getRepairsEnabled(),
      announcement: announcement(summary),
    };
  } finally {
    pauseMutationWatcher(false);
  }
}

export function currentRepairState(): AccessibilityScanResult {
  const applied = getAppliedRepairs();
  const suggested = getSuggestedRepairs();
  const summary = buildSummary(
    lastIssues,
    new Set(applied.map((r) => r.issueId)).size,
    suggested.filter((s) => s.status === "suggested").length,
    suggested.filter((s) => s.status === "skipped-low-confidence").length
  );
  return {
    meta: { title: document.title || "(untitled)", url: location.href },
    issues: lastIssues,
    appliedRepairs: applied,
    suggestedRepairs: suggested,
    summary,
    repairsEnabled: getRepairsEnabled(),
    announcement: announcement(summary),
  };
}
