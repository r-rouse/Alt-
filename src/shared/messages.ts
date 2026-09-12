/**
 * Typed Chrome extension messaging for PageGuide.
 */

import type {
  AccessibilityIssue,
  AccessibilityScanResult,
  AppliedRepair,
  SuggestedRepair,
} from "./accessibility";
import type { PageImage, ImageScanSummary, ImageAccessibilityRepair } from "./images";
import type { PageStructureResult, ToolResult } from "./types";

export type ExtensionMessage =
  | { type: "GET_PAGE_STRUCTURE" }
  | { type: "LIST_INTERACTIVE" }
  | { type: "GET_SECTION"; elementId: string }
  | { type: "FOCUS_ELEMENT"; elementId: string }
  | { type: "CLICK_ELEMENT"; elementId: string; confirmed?: boolean }
  | { type: "SCROLL_TO_ELEMENT"; elementId: string }
  | { type: "GET_ELEMENT_TEXT"; elementId: string }
  | { type: "FILL_INPUT"; elementId: string; value: string }
  | { type: "PING" }
  | { type: "ORIENT_COMMAND" }
  /** Accessibility scan & repair */
  | { type: "SCAN_ACCESSIBILITY" }
  | { type: "GET_ISSUES_FOR_INFERENCE" }
  | {
      type: "APPLY_INFERENCES";
      inferences: import("./accessibility").InferenceResult[];
    }
  | { type: "SET_REPAIRS_ENABLED"; enabled: boolean }
  | { type: "GET_REPAIR_STATE" }
  | { type: "UNDO_ALL_REPAIRS" }
  | { type: "UNDO_REPAIR"; repairId: string }
  | { type: "GET_ACCESSIBILITY_ISSUES" }
  | { type: "GET_APPLIED_REPAIRS" }
  | { type: "RUN_FULL_SCAN" }
  /** Image Accessibility & Vision Features */
  | { type: "SCAN_IMAGES" }
  | { type: "GET_IMAGE_DATA"; imageId: string }
  | { type: "AUGMENT_IMAGE_ACCESSIBILITY"; imageId: string; description: string }
  | { type: "RESTORE_IMAGE_ACCESSIBILITY"; imageId: string }
  | { type: "FOCUS_IMAGE"; imageId: string }
  | { type: "GET_ACTIVE_IMAGE" }
  | { type: "FETCH_IMAGE_BLOB"; url: string }
  /** Browser & Tab Navigation Actions */
  | { type: "OPEN_NEW_TAB"; url: string }
  | { type: "GET_OPEN_TABS" }
  | { type: "SWITCH_TAB"; tabId: number }
  | { type: "CLOSE_TAB"; tabId?: number }
  | { type: "RESOLVE_ELEMENT_URL"; elementId: string }
  | {
      type: "TAB_CONTEXT_CHANGED";
      tabId: number;
      url: string;
      title: string;
      source?: "navigation" | "activation" | "tab_created";
    };

export type ExtensionResponse =
  | { ok: true; data: PageStructureResult }
  | { ok: true; data: ToolResult }
  | { ok: true; data: { pong: true } }
  | { ok: true; data: AccessibilityScanResult }
  | {
      ok: true;
      data: {
        issues: AccessibilityIssue[];
        pageTitle: string;
        pageUrl: string;
      };
    }
  | {
      ok: true;
      data: {
        repairsEnabled: boolean;
        appliedRepairs: AppliedRepair[];
        suggestedRepairs: SuggestedRepair[];
        issues: AccessibilityIssue[];
      };
    }
  | {
      ok: true;
      data: {
        images: PageImage[];
        summary: ImageScanSummary;
        activeImageId: string | null;
      };
    }
  | {
      ok: true;
      data: {
        imageId: string;
        imageDataUrl: string;
      };
    }
  | {
      ok: true;
      data: {
        dataUrl: string;
      };
    }
  | {
      ok: true;
      data: {
        imageId: string;
        repaired: boolean;
        repairRecord?: ImageAccessibilityRepair;
      };
    }
  | {
      ok: true;
      data: {
        activeImageId: string | null;
      };
    }
  /** Browser & Tab Navigation Responses */
  | {
      ok: true;
      data: {
        tabId: number;
        url: string;
      };
    }
  | {
      ok: true;
      data: {
        tabs: import("./types").BrowserTabInfo[];
      };
    }
  | {
      ok: true;
      data: {
        switched: boolean;
        tabId: number;
      };
    }
  | {
      ok: true;
      data: {
        closed: boolean;
        tabId?: number;
      };
    }
  | {
      ok: true;
      data: {
        resolvedUrl: string | null;
        elementId: string;
        label: string;
        isLink: boolean;
      };
    }
  | { ok: false; error: string };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: unknown };
  return typeof msg.type === "string";
}
