/**
 * Proof of Relevance — Accessibility Audit & Logging Engine
 *
 * Transforms raw DOM scans, repair records, and image evaluations into a structured,
 * demonstrable audit log that proves why PageGuide is essential for blind and low-vision users.
 */

import type {
  AccessibilityIssue,
  AccessibilityIssueType,
  AccessibilityScanResult,
  AppliedRepair,
  IssueSeverity,
} from "./accessibility";
import type { PageImage } from "./images";

export interface AuditLogItem {
  id: string;
  issueId: string;
  elementId: string;
  tagName: string;
  type: AccessibilityIssueType;
  typeLabel: string;
  wcagCriterion: string;
  severity: IssueSeverity;
  severityLabel: string;
  visibleText: string | null;
  location: string;
  evidence: string[];
  summary: string;
  userImpact: string;
  repaired: boolean;
  appliedRepair?: {
    attribute: string;
    newValue: string;
    source: string;
    confidence: number;
    reason: string;
  };
}

export interface ProofOfRelevanceAudit {
  pageTitle: string;
  pageUrl: string;
  timestamp: string;
  stats: {
    totalIssues: number;
    criticalHighCount: number;
    mediumCount: number;
    lowCount: number;
    repairedCount: number;
    unrepairedCount: number;
    repairRatePercent: number;
    inaccessibleImagesCount: number;
    byType: Record<string, number>;
  };
  items: AuditLogItem[];
}

const TYPE_CONFIG: Record<
  AccessibilityIssueType,
  { label: string; wcag: string; userImpact: string }
> = {
  "missing-accessible-name": {
    label: "Missing Accessible Name",
    wcag: "WCAG 2.1 - 4.1.2 Name, Role, Value (Level A)",
    userImpact:
      "Screen readers announce 'unlabeled button' or 'link'. Blind users cannot determine the target or purpose.",
  },
  "missing-alt-text": {
    label: "Missing Image Description",
    wcag: "WCAG 2.1 - 1.1.1 Non-text Content (Level A)",
    userImpact:
      "Screen readers skip the image or read raw cryptic filenames. Visual information, charts, and diagrams are inaccessible.",
  },
  "missing-form-label": {
    label: "Missing Form Label",
    wcag: "WCAG 2.1 - 1.3.1 Info & Relationships, 3.3.2 Labels (Level A)",
    userImpact:
      "Form input has no linked label. Users cannot know what data is required when attempting to fill the field.",
  },
  "non-semantic-interactive": {
    label: "Non-Semantic Interactive Element",
    wcag: "WCAG 2.1 - 4.1.2 Name, Role, Value (Level A)",
    userImpact:
      "A generic <div> or <span> is used as a button/link without ARIA role. Assistive technology does not identify it as clickable.",
  },
  "not-keyboard-accessible": {
    label: "Not Keyboard Accessible",
    wcag: "WCAG 2.1 - 2.1.1 Keyboard (Level A)",
    userImpact:
      "Control cannot receive keyboard focus or be activated with Enter/Space, locking out keyboard, switch, and screen reader users.",
  },
  "heading-hierarchy": {
    label: "Broken Heading Hierarchy",
    wcag: "WCAG 2.1 - 1.3.1 Info & Relationships, 2.4.6 Headings (Level AA)",
    userImpact:
      "Heading levels skip irregularly, breaking screen reader heading rotor navigation and mental model construction.",
  },
  other: {
    label: "General Accessibility Barrier",
    wcag: "WCAG 2.1 - Principles of Accessibility",
    userImpact:
      "Element violates accessibility best practices, causing confusion or navigation friction for assistive tech users.",
  },
};

/**
 * Generate a complete Proof of Relevance audit structure from scan and repair data.
 */
export function generateProofOfRelevanceAudit(
  scan: AccessibilityScanResult,
  images?: PageImage[]
): ProofOfRelevanceAudit {
  const issues = scan.issues || [];
  const repairs = scan.appliedRepairs || [];
  const repairsByIssueId = new Map<string, AppliedRepair>();
  const repairsByElementId = new Map<string, AppliedRepair>();

  for (const r of repairs) {
    if (r.issueId) repairsByIssueId.set(r.issueId, r);
    if (r.elementId) repairsByElementId.set(r.elementId, r);
  }

  const items: AuditLogItem[] = issues.map((iss) => {
    const config = TYPE_CONFIG[iss.type] || TYPE_CONFIG.other;
    const repair = repairsByIssueId.get(iss.id) || repairsByElementId.get(iss.elementId);
    const c = iss.context;

    const locationParts: string[] = [];
    if (c.parentLandmark) locationParts.push(`Landmark: ${c.parentLandmark}`);
    if (c.nearbyHeading) locationParts.push(`Section: ${c.nearbyHeading}`);
    const location = locationParts.join(" | ") || "Main content";

    return {
      id: iss.id,
      issueId: iss.id,
      elementId: iss.elementId,
      tagName: c.tagName ? `<${c.tagName.toLowerCase()}>` : "element",
      type: iss.type,
      typeLabel: config.label,
      wcagCriterion: config.wcag,
      severity: iss.severity,
      severityLabel: iss.severity.toUpperCase(),
      visibleText: c.visibleText || null,
      location,
      evidence: iss.deterministicEvidence.length > 0 ? iss.deterministicEvidence : [iss.summary],
      summary: iss.summary,
      userImpact: config.userImpact,
      repaired: Boolean(repair),
      appliedRepair: repair
        ? {
            attribute: repair.attribute,
            newValue: repair.newValue,
            source: repair.source,
            confidence: Math.round(repair.confidence * 100),
            reason: repair.reason,
          }
        : undefined,
    };
  });

  const criticalHighCount = items.filter((i) => i.severity === "high").length;
  const mediumCount = items.filter((i) => i.severity === "medium").length;
  const lowCount = items.filter((i) => i.severity === "low").length;
  const repairedCount = items.filter((i) => i.repaired).length;
  const unrepairedCount = items.length - repairedCount;
  const repairRatePercent =
    items.length > 0 ? Math.round((repairedCount / items.length) * 100) : 100;

  const inaccessibleImagesCount = (images || []).filter(
    (img) => img.accessibilityStatus === "missing" || img.accessibilityStatus === "poor"
  ).length;

  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.typeLabel] = (byType[item.typeLabel] || 0) + 1;
  }

  return {
    pageTitle: scan.meta?.title || "(untitled page)",
    pageUrl: scan.meta?.url || "",
    timestamp: new Date().toISOString(),
    stats: {
      totalIssues: items.length,
      criticalHighCount,
      mediumCount,
      lowCount,
      repairedCount,
      unrepairedCount,
      repairRatePercent,
      inaccessibleImagesCount,
      byType,
    },
    items,
  };
}

/**
 * Format audit log as a clean, publication-ready Markdown report.
 */
export function formatAuditAsMarkdown(audit: ProofOfRelevanceAudit): string {
  const lines: string[] = [
    `# PageGuide Accessibility Audit — Proof of Relevance`,
    ``,
    `> **Page Title**: ${audit.pageTitle}  `,
    `> **URL**: ${audit.pageUrl}  `,
    `> **Audit Timestamp**: ${audit.timestamp}  `,
    `> **Engine**: PageGuide Deterministic A11y Scanner + Runtime Semantic Repair Engine`,
    ``,
    `---`,
    ``,
    `## Executive Proof of Relevance Summary`,
    ``,
    `Web accessibility failures directly prevent blind and low-vision users from completing basic tasks on this page. Below is the empirical proof of barriers detected by PageGuide and the runtime remediations applied in memory:`,
    ``,
    `- **Total Accessibility Barriers Detected**: **${audit.stats.totalIssues}**`,
    `- **Critical / High-Severity Blockers**: **${audit.stats.criticalHighCount}**`,
    `- **Runtime Auto-Remediations Applied**: **${audit.stats.repairedCount}** (${audit.stats.repairRatePercent}% repaired live)`,
    `- **Inaccessible Visuals / Charts**: **${audit.stats.inaccessibleImagesCount}**`,
    ``,
    `### Barrier Breakdown by WCAG Category`,
  ];

  for (const [typeLabel, count] of Object.entries(audit.stats.byType)) {
    lines.push(`- **${typeLabel}**: ${count}`);
  }

  lines.push(``, `---`, ``, `## Detailed Barrier & Remediation Log`, ``);

  if (audit.items.length === 0) {
    lines.push(`*No accessibility barriers detected on this page.*`);
  } else {
    audit.items.forEach((item, idx) => {
      lines.push(
        `### ${idx + 1}. [${item.severityLabel}] ${item.typeLabel} on \`${item.tagName}\` (\`${item.elementId}\`)`,
        ``,
        `- **WCAG Standard**: ${item.wcagCriterion}`,
        `- **Location**: ${item.location}`,
        `- **Visible Content**: ${item.visibleText ? `"${item.visibleText}"` : "(none / icon only)"}`,
        `- **User Barrier**: ${item.userImpact}`,
        `- **Technical Evidence**:`,
        ...item.evidence.map((e) => `  - ${e}`),
        `- **Remediation Status**: ${
          item.repaired && item.appliedRepair
            ? `✅ **Repaired Live** — Added \`${item.appliedRepair.attribute}="${item.appliedRepair.newValue}"\` (${item.appliedRepair.confidence}% confidence, ${item.appliedRepair.source})`
            : `⚠️ **Flagged for AI / Manual Assistance**`
        }`,
        ``
      );
    });
  }

  lines.push(
    `---`,
    ``,
    `## Conclusion: Why PageGuide is Essential`,
    ``,
    `Standard screen readers (VoiceOver, NVDA, JAWS) rely entirely on underlying DOM markup. Without PageGuide's runtime repairs and sighted AI companion layer, the **${audit.stats.totalIssues} barriers** identified above render this website confusing or completely impassable for users who cannot see the screen.`
  );

  return lines.join("\n");
}

/**
 * Format audit log as structured JSON.
 */
export function formatAuditAsJson(audit: ProofOfRelevanceAudit): string {
  return JSON.stringify(audit, null, 2);
}

/**
 * Log structured Proof of Relevance audit into the browser developer console.
 */
export function logAuditToConsole(audit: ProofOfRelevanceAudit, tagPrefix = "PageGuide"): void {
  try {
    const title = `%c[${tagPrefix}] Proof of Relevance — Accessibility Audit (${audit.stats.totalIssues} barriers, ${audit.stats.repairedCount} repaired)`;
    console.groupCollapsed(
      title,
      "color: #3b82f6; font-weight: bold; font-size: 1.05rem;"
    );

    console.log(`Page: ${audit.pageTitle} (${audit.pageUrl})`);
    console.log(
      `Summary: ${audit.stats.totalIssues} total barriers, ${audit.stats.criticalHighCount} critical blockers, ${audit.stats.repairRatePercent}% auto-repaired.`
    );

    if (audit.items.length > 0) {
      console.table(
        audit.items.map((i) => ({
          ID: i.elementId,
          Severity: i.severityLabel,
          Type: i.typeLabel,
          Element: i.tagName,
          Summary: i.summary,
          Repaired: i.repaired ? `YES: ${i.appliedRepair?.attribute}="${i.appliedRepair?.newValue}"` : "NO",
        }))
      );
    }

    console.groupEnd();
  } catch {
    // Console formatting failed
  }
}
