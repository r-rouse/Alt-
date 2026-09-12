/**
 * Accessibility domain types for PageGuide's runtime repair layer.
 */

/** Where a semantic property came from */
export type SemanticSource = "native" | "deterministic" | "ai-inferred";

export type AccessibilityIssueType =
  | "missing-accessible-name"
  | "missing-alt-text"
  | "missing-form-label"
  | "non-semantic-interactive"
  | "not-keyboard-accessible"
  | "heading-hierarchy"
  | "other";

export type IssueSeverity = "low" | "medium" | "high";

/** Compact context describing an element for scanning + AI inference */
export interface SemanticElement {
  elementId: string;
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  visibleText: string | null;
  alt: string | null;
  placeholder: string | null;
  inputType: string | null;
  title: string | null;
  disabled: boolean;
  checked: boolean | null;
  tabindex: number | null;
  clickable: boolean;
  keyboardAccessible: boolean;
  nearbyText: string | null;
  nearbyHeading: string | null;
  parentLandmark: string | null;
  parentForm: string | null;
  childSummary: string | null;
  precedingText: string | null;
  followingText: string | null;
  nameSource: SemanticSource;
}

export interface AccessibilityIssue {
  id: string;
  elementId: string;
  type: AccessibilityIssueType;
  severity: IssueSeverity;
  context: SemanticElement;
  deterministicEvidence: string[];
  /** Optional human-readable summary for the UI */
  summary: string;
}

export type RepairAttribute =
  | "aria-label"
  | "aria-labelledby"
  | "role"
  | "tabindex"
  | "alt"
  | "title";

export interface ProposedRepair {
  attribute: RepairAttribute;
  value: string;
}

export interface InferenceResult {
  elementId: string;
  issueId: string;
  inferredRole: string | null;
  accessibleName: string | null;
  repairs: ProposedRepair[];
  confidence: number;
  reason: string;
  source: SemanticSource;
}

export interface AppliedRepair {
  id: string;
  issueId: string;
  elementId: string;
  attribute: string;
  previousValue: string | null;
  newValue: string;
  confidence: number;
  reason: string;
  source: SemanticSource;
  /** Keyboard handler we may have attached for non-semantic controls */
  addedKeyHandler?: boolean;
}

export interface SuggestedRepair {
  issueId: string;
  elementId: string;
  inference: InferenceResult;
  status: "suggested" | "skipped-low-confidence";
}

export interface ScanSummary {
  issueCount: number;
  repairedCount: number;
  suggestedCount: number;
  skippedCount: number;
  byType: Record<string, number>;
}

export interface AccessibilityScanResult {
  meta: { title: string; url: string };
  issues: AccessibilityIssue[];
  appliedRepairs: AppliedRepair[];
  suggestedRepairs: SuggestedRepair[];
  summary: ScanSummary;
  repairsEnabled: boolean;
  announcement: string;
}

/** Confidence thresholds — tune during hackathon demos */
export const CONFIDENCE = {
  /** Apply safe semantic repair automatically */
  AUTO_APPLY: 0.9,
  /** Show as suggested repair; do not auto-apply */
  SUGGEST: 0.7,
} as const;

/** Format an issue's context for the AI inference prompt (no DOM access). */
export function formatIssueForInference(issue: AccessibilityIssue): string {
  const c = issue.context;
  const lines = [
    `ISSUE ID: ${issue.id}`,
    `ELEMENT: ${c.elementId}`,
    `ISSUE TYPE: ${issue.type}`,
    `SEVERITY: ${issue.severity}`,
    `HTML TYPE: ${c.tagName}`,
    `ROLE: ${c.role || "none"}`,
    `ACCESSIBLE NAME: ${c.accessibleName || "NONE"}`,
    `VISIBLE TEXT: ${c.visibleText || "NONE"}`,
    `CLICKABLE: ${c.clickable}`,
    `KEYBOARD ACCESSIBLE: ${c.keyboardAccessible}`,
    `CHILD CONTENT: ${c.childSummary || "none"}`,
    `NEARBY TEXT: ${c.nearbyText || "none"}`,
    `NEARBY HEADING: ${c.nearbyHeading || "none"}`,
    `PRECEDING TEXT: ${c.precedingText || "none"}`,
    `FOLLOWING TEXT: ${c.followingText || "none"}`,
    `PARENT LANDMARK: ${c.parentLandmark || "none"}`,
    `PARENT FORM: ${c.parentForm || "none"}`,
    `PLACEHOLDER: ${c.placeholder || "none"}`,
    `INPUT TYPE: ${c.inputType || "n/a"}`,
    `ALT: ${c.alt === null ? "n/a" : c.alt === "" ? "(empty — decorative?)" : c.alt}`,
    `EVIDENCE:`,
    ...issue.deterministicEvidence.map((e) => `  - ${e}`),
  ];
  return lines.join("\n");
}
