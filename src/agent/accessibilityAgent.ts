/**
 * AI accessibility inference — structured repairs only, never arbitrary JS.
 */

import type { AccessibilityIssue, InferenceResult } from "../shared/accessibility";
import { formatIssueForInference } from "../shared/accessibility";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export const ACCESSIBILITY_INFERENCE_PROMPT = `You are PageGuide, an accessibility agent that analyzes webpages and proposes semantic accessibility repairs for blind and low-vision users.

Your goal is to restore missing semantic information, not redesign websites.

Rules:
- Infer meaning conservatively from surrounding text, headings, form relationships, element type, icons, and interaction behavior.
- Never invent page functionality that is not evidenced.
- When uncertain, lower your confidence.
- Prefer no repair over an incorrect repair. A WRONG label is worse than a missing one.
- Never generate JavaScript or CSS selectors for execution.
- Never modify application data, prices, or business logic.
- Repairs may only use these attributes: aria-label, aria-labelledby, role, tabindex, alt, title.
- For clickable non-semantic elements, prefer role="button" and tabindex="0" when they act as buttons.
- For images, propose alt text only when you can infer a useful description; use empty alt only if clearly decorative.
- For form fields, propose a concise aria-label (e.g. "Email address", "Promo code").
- Do not propose heading level changes.

Return a JSON object with shape:
{
  "results": [
    {
      "elementId": "pg-42",
      "issueId": "issue-1",
      "inferredRole": "button" | null,
      "accessibleName": "Proceed to checkout" | null,
      "repairs": [{ "attribute": "aria-label", "value": "Proceed to checkout" }],
      "confidence": 0.0-1.0,
      "reason": "short evidence-based explanation"
    }
  ]
}

Only include entries for issues you were given. Omit repairs array (or use empty) when confidence would be below 0.7.`;

function friendlyApiError(status: number, body: string): string {
  if (status === 401) return "OpenAI rejected the API key. Check Settings.";
  if (status === 429) return "OpenAI rate limit reached. Try again shortly.";
  if (status >= 500) return "OpenAI is temporarily unavailable.";
  return `AI inference failed (${status}): ${body.slice(0, 100)}`;
}

function parseResults(raw: string, issues: AccessibilityIssue[]): InferenceResult[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) return [];
  try {
    const json = JSON.parse(raw.slice(start, end + 1)) as {
      results?: Array<{
        elementId?: string;
        issueId?: string;
        inferredRole?: string | null;
        accessibleName?: string | null;
        repairs?: Array<{ attribute?: string; value?: string }>;
        confidence?: number;
        reason?: string;
      }>;
    };
    const issueById = new Map(issues.map((i) => [i.id, i]));
    const out: InferenceResult[] = [];
    for (const r of json.results || []) {
      if (!r.elementId || !r.issueId) continue;
      if (!issueById.has(r.issueId)) continue;
      const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
      const allowed = new Set(["aria-label", "aria-labelledby", "role", "tabindex", "alt", "title"]);
      const repairs = (r.repairs || [])
        .filter((p) => p.attribute && p.value != null && allowed.has(p.attribute))
        .map((p) => ({
          attribute: p.attribute as InferenceResult["repairs"][0]["attribute"],
          value: String(p.value),
        }));
      out.push({
        elementId: r.elementId.startsWith("pg-") ? r.elementId : `pg-${r.elementId}`,
        issueId: r.issueId,
        inferredRole: r.inferredRole ?? null,
        accessibleName: r.accessibleName ?? null,
        repairs,
        confidence,
        reason: r.reason || "AI inference",
        source: "ai-inferred",
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Ask the model to infer repairs for issues that deterministic heuristics could not resolve.
 */
export async function inferAccessibilityRepairs(
  apiKey: string,
  issues: AccessibilityIssue[],
  pageTitle: string,
  pageUrl: string
): Promise<{ inferences: InferenceResult[]; error?: string }> {
  if (!apiKey) {
    return { inferences: [], error: "missing_api_key" };
  }
  if (issues.length === 0) return { inferences: [] };

  // Cap batch size for hackathon latency / token limits
  const batch = issues.slice(0, 12);
  const payload = batch.map(formatIssueForInference).join("\n\n---\n\n");

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ACCESSIBILITY_INFERENCE_PROMPT },
          {
            role: "user",
            content: `PAGE\nTitle: ${pageTitle}\nURL: ${pageUrl}\n\nInfer accessibility repairs for these issues:\n\n${payload}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { inferences: [], error: friendlyApiError(res.status, body) };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content || "";
    return { inferences: parseResults(content, batch) };
  } catch (err) {
    return {
      inferences: [],
      error: err instanceof Error ? err.message : "AI inference failed.",
    };
  }
}
