/**
 * OpenAI agent loop with structured tool calling.
 * The model decides WHAT; the extension executes constrained HOW.
 */

import { SYSTEM_PROMPT } from "./systemPrompt";
import { AGENT_TOOLS } from "./tools";
import type { AgentTurnResult, ChatMessage, PageStructureResult, BrowserTabInfo } from "../shared/types";
import type { ExtensionMessage, ExtensionResponse } from "../shared/messages";
import type { PageImage, ImageScanSummary } from "../shared/images";
import {
  describeImageWithVision,
  askImageQuestionWithVision,
  VisionService,
} from "./visionAgent";
import type { PageGuideAgentBridge } from "./agentBridge";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const MAX_TOOL_ROUNDS = 6;

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
};

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type PageToolExecutor = (message: ExtensionMessage) => Promise<ExtensionResponse>;

function friendlyApiError(status: number, body: string, provider: string): string {
  if (status === 401) {
    return `${provider} rejected the API key. Check your key in PageGuide Settings.`;
  }
  if (status === 429) {
    return `${provider} rate limit reached. Please wait a moment and try again.`;
  }
  if (status >= 500) {
    return `${provider} is temporarily unavailable. Please try again shortly.`;
  }
  return `I couldn't reach the AI service (${status}). ${body.slice(0, 120)}`;
}

async function callOpenAI(
  apiKey: string,
  messages: OpenAIMessage[],
  providerType: "openai" | "openrouter" = "openai"
): Promise<OpenAIMessage> {
  const isRouter = providerType === "openrouter";
  const url = isRouter ? OPENROUTER_URL : OPENAI_URL;
  const model = isRouter ? OPENROUTER_MODEL : OPENAI_MODEL;
  const providerLabel = isRouter ? "OpenRouter" : "OpenAI";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (isRouter) {
    headers["HTTP-Referer"] = "https://pageguide.local";
    headers["X-Title"] = "PageGuide Web Companion";
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(friendlyApiError(res.status, body, providerLabel));
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: OpenAIMessage }>;
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("The AI returned an empty response. Please try again.");
  return message;
}

function normalizeElementId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("pg-") ? trimmed : `pg-${trimmed}`;
}

async function executeTool(
  name: string,
  argsJson: string,
  execute: PageToolExecutor,
  apiKey: string,
  bridge?: PageGuideAgentBridge,
  providerType: "openai" | "openrouter" = "openai"
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return "Tool arguments were invalid JSON.";
  }

  const elementId = normalizeElementId(args.elementId);

  let message: ExtensionMessage;
  switch (name) {
    case "getPageContext": {
      if (bridge) {
        return JSON.stringify(bridge.getPageContext());
      }
      const pageStructureRes = await execute({ type: "GET_PAGE_STRUCTURE" });
      const imgRes = await execute({ type: "SCAN_IMAGES" });
      const imgData = imgRes.ok
        ? (imgRes.data as { summary: ImageScanSummary; activeImageId: string | null })
        : null;
      return JSON.stringify({
        title: pageStructureRes.ok
          ? (pageStructureRes.data as PageStructureResult).meta.title
          : "",
        url: pageStructureRes.ok
          ? (pageStructureRes.data as PageStructureResult).meta.url
          : "",
        totalImages: imgData?.summary.total || 0,
        inaccessibleImages:
          (imgData?.summary.missingCount || 0) + (imgData?.summary.poorCount || 0),
        activeImageId: imgData?.activeImageId || null,
      });
    }

    case "getImages":
    case "listImages": {
      if (bridge) {
        const imgs = bridge.getImages();
        const lines = imgs.map(
          (img) =>
            `- [${img.id}] Status: ${img.accessibilityStatus} (${img.statusReason || ""}). Heading: ${img.heading || "none"}. Alt: "${img.alt ?? "none"}"`
        );
        return `Found ${imgs.length} images.\nActive image: ${bridge.getActiveImage()?.id || "none"}\n${lines.join("\n")}`;
      }
      const res = await execute({ type: "SCAN_IMAGES" });
      if (!res.ok) return res.error;
      const data = res.data as {
        images: PageImage[];
        summary: ImageScanSummary;
        activeImageId: string | null;
      };
      const lines = data.images.map(
        (img) =>
          `- [${img.id}] Status: ${img.accessibilityStatus} (${img.statusReason || ""}). Heading: ${img.heading || "none"}. Alt: "${img.alt ?? "none"}"`
      );
      return `Found ${data.summary.total} images (${data.summary.missingCount} missing alt, ${data.summary.poorCount} poor alt, ${data.summary.goodCount} good alt, ${data.summary.decorativeCount} decorative).\nActive image: ${data.activeImageId || "none"}\n${lines.join("\n")}`;
    }

    case "getActiveImage": {
      if (bridge) {
        const active = bridge.getActiveImage();
        return active
          ? `Active image is ${active.id}: status=${active.accessibilityStatus}, heading=${active.heading || "none"}, alt="${active.alt || "none"}"`
          : "No active image currently selected.";
      }
      const res = await execute({ type: "GET_ACTIVE_IMAGE" });
      if (!res.ok) return res.error;
      const id = (res.data as { activeImageId: string | null }).activeImageId;
      return id ? `Active image is ${id}.` : "No active image currently selected.";
    }

    case "setActiveImage": {
      const imageId = String(args.imageId || "");
      if (!imageId) return "Please provide an imageId.";
      if (bridge) {
        const set = bridge.setActiveImage(imageId);
        return set ? `Active image set to ${imageId}.` : `Image ${imageId} not found.`;
      }
      return `Active image set to ${imageId}.`;
    }

    case "focusImage": {
      const imageId = String(args.imageId || "");
      if (bridge) {
        const ok = await bridge.focusImage(imageId);
        return ok ? `Keyboard focus moved to image ${imageId}.` : `Could not focus image ${imageId}.`;
      }
      const res = await execute({ type: "FOCUS_IMAGE", imageId });
      if (!res.ok) return res.error;
      return (res.data as { message: string }).message;
    }

    case "nextImage": {
      if (bridge) {
        const next = await bridge.nextImage();
        return next ? `Moved to next image ${next.id}.` : "No images on page.";
      }
      return "Next image navigation completed.";
    }

    case "previousImage": {
      if (bridge) {
        const prev = await bridge.previousImage();
        return prev ? `Moved to previous image ${prev.id}.` : "No images on page.";
      }
      return "Previous image navigation completed.";
    }

    case "describeImage":
    case "describeActiveImage": {
      const mode = args.mode === "detailed" ? "detailed" : "quick";
      if (bridge) {
        const targetId =
          typeof args.imageId === "string" && args.imageId
            ? args.imageId
            : bridge.getActiveImage()?.id;
        if (!targetId) return "No active image found on this page to describe.";
        const desc = await bridge.describeImage(targetId, mode);
        return `[${targetId}] (${mode}): ${desc}`;
      }

      const scanRes = await execute({ type: "SCAN_IMAGES" });
      if (!scanRes.ok) return scanRes.error;
      const scanData = scanRes.data as {
        images: PageImage[];
        activeImageId: string | null;
      };
      const targetId =
        typeof args.imageId === "string" && args.imageId
          ? args.imageId
          : scanData.activeImageId;
      if (!targetId) return "No active image found on this page to describe.";
      const img = scanData.images.find((i) => i.id === targetId);
      if (!img) return `Image ${targetId} not found on the page.`;

      const dataRes = await execute({
        type: "GET_IMAGE_DATA",
        imageId: targetId,
      });
      if (!dataRes.ok) return dataRes.error;
      const imgData = dataRes.data as { imageDataUrl: string };

      const desc = await describeImageWithVision({
        apiKey,
        image: img,
        imageDataUrl: imgData.imageDataUrl,
        mode,
        providerType,
      });

      if (mode === "quick") {
        await execute({
          type: "AUGMENT_IMAGE_ACCESSIBILITY",
          imageId: targetId,
          description: desc,
        });
      }

      return `[${targetId}] (${mode}): ${desc}`;
    }

    case "askImageQuestion":
    case "askAboutImage": {
      const question = String(args.question || "");
      if (!question) return "Please provide a question about the image.";

      if (bridge) {
        const targetId =
          typeof args.imageId === "string" && args.imageId
            ? args.imageId
            : bridge.getActiveImage()?.id;
        if (!targetId) return "No active image found on this page to ask about.";
        const answer = await bridge.askImageQuestion(targetId, question);
        return `[Regarding ${targetId}]: ${answer}`;
      }

      const scanRes = await execute({ type: "SCAN_IMAGES" });
      if (!scanRes.ok) return scanRes.error;
      const scanData = scanRes.data as {
        images: PageImage[];
        activeImageId: string | null;
      };
      const targetId =
        typeof args.imageId === "string" && args.imageId
          ? args.imageId
          : scanData.activeImageId;
      if (!targetId) return "No active image found on this page to ask about.";
      const img = scanData.images.find((i) => i.id === targetId);
      if (!img) return `Image ${targetId} not found on the page.`;

      const dataRes = await execute({
        type: "GET_IMAGE_DATA",
        imageId: targetId,
      });
      if (!dataRes.ok) return dataRes.error;
      const imgData = dataRes.data as { imageDataUrl: string };

      const answer = await askImageQuestionWithVision({
        apiKey,
        image: img,
        imageDataUrl: imgData.imageDataUrl,
        question,
        providerType,
      });

      return `[Regarding ${targetId}]: ${answer}`;
    }

    case "applyImageDescription": {
      const imageId = String(args.imageId || "");
      if (bridge) {
        const ok = await bridge.applyImageDescription(imageId);
        return ok
          ? `Applied accessibility description to ${imageId}. VoiceOver will now announce it.`
          : `Failed to apply description to ${imageId}.`;
      }
      return `Applied accessibility description to ${imageId}.`;
    }

    case "getPageStructure":
      message = { type: "GET_PAGE_STRUCTURE" };
      break;
    case "listInteractiveElements":
      message = { type: "LIST_INTERACTIVE" };
      break;
    case "getAccessibilityIssues":
      message = { type: "GET_ACCESSIBILITY_ISSUES" };
      break;
    case "getAppliedRepairs":
      message = { type: "GET_APPLIED_REPAIRS" };
      break;
    case "getSection":
      message = { type: "GET_SECTION", elementId };
      break;
    case "focusElement":
      message = { type: "FOCUS_ELEMENT", elementId };
      break;
    case "clickElement":
      message = {
        type: "CLICK_ELEMENT",
        elementId,
        confirmed: Boolean(args.confirmed),
      };
      break;
    case "scrollToElement":
      message = { type: "SCROLL_TO_ELEMENT", elementId };
      break;
    case "getElementText":
      message = { type: "GET_ELEMENT_TEXT", elementId };
      break;
    case "fillInput":
      message = {
        type: "FILL_INPUT",
        elementId,
        value: typeof args.value === "string" ? args.value : "",
      };
      break;

    case "openNewTab": {
      let targetUrl: string | null = null;
      let elementLabel = "";
      const requestedElementId = typeof args.elementId === "string" ? args.elementId.trim() : "";
      const directUrl = typeof args.url === "string" ? args.url.trim() : "";

      // Deterministically resolve URL from page element registry
      if (requestedElementId) {
        const res = await execute({
          type: "RESOLVE_ELEMENT_URL",
          elementId: requestedElementId,
        });
        if (res.ok && res.data && "resolvedUrl" in res.data) {
          const urlData = res.data as {
            resolvedUrl: string | null;
            label: string;
            isLink: boolean;
          };
          elementLabel = urlData.label;
          if (urlData.resolvedUrl) {
            targetUrl = urlData.resolvedUrl;
          } else if (!urlData.isLink) {
            return `That control (${requestedElementId}) does not appear to be a link that opens a separate page, but I can activate it here on this page if you would like.`;
          } else {
            return `I found “${elementLabel}”, but it doesn't have a valid web address to open in a new tab.`;
          }
        }
      }

      if (!targetUrl && directUrl) {
        try {
          const parsed = new URL(directUrl);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            targetUrl = parsed.href;
          } else {
            return "I can't open that URL. Alt+ only navigates to web pages using http: or https:.";
          }
        } catch {
          return `“${directUrl}” is not a valid web address.`;
        }
      }

      if (!targetUrl) {
        return "I couldn't determine which link or address to open in a new tab. Please specify which link or page you want to open.";
      }

      console.log(
        `[Alt+ Browser Action]\nIntent: Open ${elementLabel || targetUrl} in new tab\nResolved element: ${requestedElementId || "none"}\nAccessible name: ${elementLabel || "none"}\nResolved URL: ${targetUrl}\nAction: OPEN_NEW_TAB`
      );

      const openRes = await execute({
        type: "OPEN_NEW_TAB",
        url: targetUrl,
      });

      if (!openRes.ok) {
        console.log(`[Alt+ Browser Action]\nAction: OPEN_NEW_TAB\nStatus: failed (${openRes.error})`);
        return `I couldn't open that page in a new tab: ${openRes.error}`;
      }

      const tabData = openRes.data as { tabId: number; url: string };
      console.log(`[Alt+ Browser Action]\nAction: OPEN_NEW_TAB\nNew tab: ${tabData.tabId}\nStatus: success`);
      const nameToReport = elementLabel ? `the ${elementLabel} link` : targetUrl;
      return `Opened ${nameToReport} in a new tab. The browser has switched to the new tab.`;
    }

    case "getOpenTabs": {
      const tabsRes = await execute({ type: "GET_OPEN_TABS" });
      if (!tabsRes.ok) return `Failed to list open tabs: ${tabsRes.error}`;
      const tabsData = tabsRes.data as { tabs: BrowserTabInfo[] };
      const tabs = tabsData.tabs || [];
      if (tabs.length === 0) return "No open tabs found.";

      const activeTab = tabs.find((t) => t.active);
      const tabList = tabs
        .map(
          (t) =>
            `- Tab ${t.id}: “${t.title}” (${t.url})${t.active ? " [CURRENT ACTIVE TAB]" : ""}`
        )
        .join("\n");

      return `Currently open tabs (${tabs.length} total):\n${tabList}\n\nYou are currently on: ${activeTab ? `“${activeTab.title}” (Tab ${activeTab.id})` : "unknown tab"}.`;
    }

    case "switchTab": {
      const tabId = typeof args.tabId === "number" ? args.tabId : parseInt(String(args.tabId), 10);
      if (isNaN(tabId)) {
        return "Please specify a valid numeric tabId to switch to. You can call getOpenTabs to find the tab ID.";
      }

      console.log(`[Alt+ Browser Action]\nIntent: Switch to tab\nAction: SWITCH_TAB\nTarget tab: ${tabId}`);
      const switchRes = await execute({ type: "SWITCH_TAB", tabId });
      if (!switchRes.ok) {
        return `Could not switch to tab ${tabId}: ${switchRes.error}`;
      }
      return `Switched to tab ${tabId}. The page is now active.`;
    }

    case "closeTab": {
      const tabId =
        typeof args.tabId === "number"
          ? args.tabId
          : args.tabId
          ? parseInt(String(args.tabId), 10)
          : undefined;

      console.log(`[Alt+ Browser Action]\nIntent: Close tab\nAction: CLOSE_TAB\nTarget tab: ${tabId ?? "current"}`);
      const closeRes = await execute({ type: "CLOSE_TAB", tabId });
      if (!closeRes.ok) {
        return `Could not close tab: ${closeRes.error}`;
      }
      return tabId ? `Closed tab ${tabId}.` : "Closed the current tab.";
    }
    default:
      return `Unknown tool: ${name}`;
  }

  const response = await execute(message);
  if (!response.ok) return response.error;

  const data = response.data;

  if (data && typeof data === "object") {
    if ("text" in data && "meta" in data) {
      return (data as PageStructureResult).text;
    }
    if ("message" in data && typeof (data as { message: unknown }).message === "string") {
      return (data as { message: string }).message;
    }
    if ("summary" in data && "issues" in data) {
      const scan = data as {
        summary: {
          issueCount: number;
          repairedCount: number;
          suggestedCount: number;
        };
        issues: Array<{ id: string; elementId: string; type: string; summary: string }>;
        appliedRepairs: Array<{
          elementId: string;
          attribute: string;
          newValue: string;
          confidence: number;
          source: string;
        }>;
        repairsEnabled: boolean;
        announcement: string;
      };
      const issueLines = scan.issues
        .slice(0, 30)
        .map((i) => `- [${i.id}] ${i.elementId} ${i.type}: ${i.summary}`)
        .join("\n");
      const repairLines = scan.appliedRepairs
        .slice(0, 30)
        .map(
          (r) =>
            `- ${r.elementId}: ${r.attribute}="${r.newValue}" (${Math.round(r.confidence * 100)}%, ${r.source})`
        )
        .join("\n");
      return `${scan.announcement}\nRepairs enabled: ${scan.repairsEnabled}\nIssues (${scan.summary.issueCount}):\n${issueLines || "(none)"}\n\nApplied repairs (${scan.summary.repairedCount}):\n${repairLines || "(none)"}`;
    }
  }

  return JSON.stringify(data);
}

export async function runAgentTurn(options: {
  apiKey: string;
  userText: string;
  pageStructure: string;
  pageTitle: string;
  pageUrl: string;
  history: ChatMessage[];
  execute: PageToolExecutor;
  bridge?: PageGuideAgentBridge;
  providerType?: "openai" | "openrouter";
}): Promise<AgentTurnResult> {
  const {
    apiKey,
    userText,
    pageStructure,
    pageTitle,
    pageUrl,
    history,
    execute,
    bridge,
    providerType = "openai",
  } = options;

  if (!apiKey) {
    return {
      reply:
        "PageGuide needs an API key. Open Settings below, paste your key, and save. For hackathons you can also set VITE_OPENAI_API_KEY in a .env file and rebuild.",
      toolsUsed: [],
      error: "missing_api_key",
    };
  }

  const toolsUsed: string[] = [];

  const messages: OpenAIMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `CURRENT PAGE\nTitle: ${pageTitle}\nURL: ${pageUrl}\n\nSEMANTIC STRUCTURE:\n${pageStructure}`,
    },
  ];

  for (const m of history.slice(-8)) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: "user", content: userText });

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const assistant = await callOpenAI(apiKey, messages, providerType);
      messages.push(assistant);

      const toolCalls = assistant.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        const reply =
          (assistant.content || "").trim() ||
          "I'm not sure how to help with that on this page. Try asking me to orient you, or describe what you want to find.";
        return { reply, toolsUsed };
      }

      for (const call of toolCalls) {
        toolsUsed.push(call.function.name);
        const result = await executeTool(
          call.function.name,
          call.function.arguments,
          execute,
          apiKey,
          bridge,
          providerType
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    }

    return {
      reply:
        "I took several steps on the page but didn't finish. Please try a more specific request, or ask me to orient you again.",
      toolsUsed,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Something went wrong talking to the AI service.";
    return { reply: message, toolsUsed, error: "api_error" };
  }
}

/**
 * Generate a warm, natural Companion Orientation when connecting to a webpage.
 * Metaphor: Sighted human companion sitting beside a blind user.
 */
export async function generateCompanionOrientation(options: {
  apiKey: string;
  pageTitle: string;
  pageUrl: string;
  pageStructure: string;
  images: PageImage[];
  providerType?: "openai" | "openrouter";
}): Promise<string> {
  const {
    apiKey,
    pageTitle,
    pageUrl,
    pageStructure,
    images,
    providerType = "openai",
  } = options;

  const visualHighlights = images
    .filter((img) => img.accessibilityStatus !== "decorative")
    .slice(0, 5);

  if (!apiKey) {
    const visualNote =
      visualHighlights.length > 0
        ? ` There ${
            visualHighlights.length === 1 ? "is 1 visual highlight" : `are ${visualHighlights.length} visual highlights`
          } including photographs, charts, or maps to explore.`
        : "";
    return `You're on ${pageTitle || "this webpage"}.${visualNote}\n\nYou can explore visual highlights, ask me to take you to any section, or ask what's on the page.\n\nWhat would you like to do?`;
  }

  const visualLines = visualHighlights
    .map(
      (img) =>
        `- ${img.heading || img.caption || "Visual"}: ${
          img.nearbyText?.slice(0, 100) || img.alt || "Page graphic"
        }`
    )
    .join("\n");

  const prompt = `You are PageGuide, a patient and knowledgeable sighted companion sitting beside a blind person looking at this webpage together.
Provide a warm, natural orientation greeting following this exact conversational structure:

1. Identification: "You're on the [Website/Page title]..."
2. Navigation: Briefly mention how the navigation or main sections are organized (e.g. "The main navigation has [N] sections...").
3. Primary Purpose / Headline: What is this page promoting, explaining, or offering?
4. Visual Highlights: Naturally describe notable visuals (photos, charts, maps) on the page in plain human language (e.g. "There's a photograph of...", "There's a map showing...").
5. Available Actions: What key things can the user do here?
6. Conclude with: "What would you like to do?"

PAGE CONTEXT:
Title: ${pageTitle}
URL: ${pageUrl}

SEMANTIC STRUCTURE:
${pageStructure}

VISUAL HIGHLIGHTS:
${visualLines || "None"}

CRITICAL RULES:
- Speak strictly as a warm, human companion.
- NEVER use developer or accessibility jargon (NEVER say DOM, ARIA, alt tags, violations, repair counts, element IDs).
- Keep it concise, natural, and under 140 words.`;

  try {
    const isRouter = providerType === "openrouter";
    const url = isRouter ? OPENROUTER_URL : OPENAI_URL;
    const model = isRouter ? OPENROUTER_MODEL : OPENAI_MODEL;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (isRouter) {
      headers["HTTP-Referer"] = "https://pageguide.local";
      headers["X-Title"] = "PageGuide Web Companion";
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      }),
    });

    if (res.ok) {
      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content?.trim();
      if (reply) return reply;
    }
  } catch (err) {
    console.warn("AI orientation request failed, using local companion greeting:", err);
  }

  const visualNote =
    visualHighlights.length > 0
      ? ` There ${
          visualHighlights.length === 1 ? "is 1 visual highlight" : `are ${visualHighlights.length} visual highlights`
        } including photographs, charts, or maps to explore.`
      : "";
  return `You're on ${pageTitle || "this webpage"}.${visualNote}\n\nYou can explore visual highlights, navigate to sections, or ask any question about the page.\n\nWhat would you like to do?`;
}
