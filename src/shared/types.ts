/** Shared domain types for PageGuide */

export interface PageMeta {
  title: string;
  url: string;
}

export interface PageStructureResult {
  text: string;
  meta: PageMeta;
  interactiveCount: number;
  truncated: boolean;
}

export interface ToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export type AgentToolName =
  | "getPageStructure"
  | "getSection"
  | "listInteractiveElements"
  | "getAccessibilityIssues"
  | "getAppliedRepairs"
  | "focusElement"
  | "clickElement"
  | "scrollToElement"
  | "getElementText"
  | "fillInput"
  | "openNewTab"
  | "getOpenTabs"
  | "switchTab"
  | "closeTab"
  | "describeActiveImage"
  | "askAboutImage"
  | "focusImage"
  | "listImages"
  | "getPageContext"
  | "getImages"
  | "getActiveImage"
  | "setActiveImage"
  | "describeImage"
  | "askImageQuestion"
  | "applyImageDescription"
  | "nextImage"
  | "previousImage";

export interface BrowserTabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export * from "./images";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AgentTurnResult {
  reply: string;
  toolsUsed: string[];
  error?: string;
}
