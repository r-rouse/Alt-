/**
 * Content script entry: DOM tools + accessibility scan/repair layer + Image Vision layer.
 * Only inspects the page when messaged (user activated PageGuide).
 */

import type { ExtensionMessage, ExtensionResponse } from "../shared/messages";
import { isExtensionMessage } from "../shared/messages";
import {
  parsePage,
  getSectionText,
  listInteractiveSummary,
} from "./pageParser";
import {
  focusElement,
  clickElement,
  scrollToElement,
  getElementText,
  fillInput,
  resolveElementUrl,
} from "./actions";
import {
  applyAiInferences,
  currentRepairState,
  getLastIssues,
  issuesNeedingAi,
  runDeterministicScan,
} from "./scanOrchestrator";
import {
  getAppliedRepairs,
  setRepairsEnabled,
  undoAllRepairs,
  undoRepair,
} from "./repairEngine";
import {
  scanPageImages,
  extractImageDataUrl,
  augmentImage,
  restoreImage,
  focusImageElement,
  imageRegistry,
} from "./imageScanner";
import { startMutationWatcher } from "./mutationWatcher";
import type { InferenceResult } from "../shared/accessibility";
import {
  generateProofOfRelevanceAudit,
  logAuditToConsole,
} from "../shared/accessibilityAuditLog";

let dirty = false;

startMutationWatcher(() => {
  dirty = true;
});

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  try {
    switch (message.type) {
      case "PING":
        return { ok: true, data: { pong: true } };

      case "GET_PAGE_STRUCTURE": {
        const data = parsePage();
        return { ok: true, data };
      }

      case "LIST_INTERACTIVE": {
        return { ok: true, data: listInteractiveSummary() };
      }

      case "GET_SECTION":
        return { ok: true, data: getSectionText(message.elementId) };

      case "FOCUS_ELEMENT":
        return { ok: true, data: focusElement(message.elementId) };

      case "CLICK_ELEMENT":
        return {
          ok: true,
          data: clickElement(message.elementId, Boolean(message.confirmed)),
        };

      case "SCROLL_TO_ELEMENT":
        return { ok: true, data: scrollToElement(message.elementId) };

      case "GET_ELEMENT_TEXT":
        return { ok: true, data: getElementText(message.elementId) };

      case "RESOLVE_ELEMENT_URL":
        return { ok: true, data: resolveElementUrl(message.elementId) };

      case "FILL_INPUT":
        return { ok: true, data: fillInput(message.elementId, message.value) };

      case "ORIENT_COMMAND":
        return { ok: true, data: parsePage() };

      case "SCAN_ACCESSIBILITY":
      case "RUN_FULL_SCAN": {
        dirty = false;
        const scanRes = runDeterministicScan();
        try {
          const audit = generateProofOfRelevanceAudit(scanRes);
          logAuditToConsole(audit, "Webpage Live Scan");
        } catch {}
        return { ok: true, data: scanRes };
      }

      case "GET_ISSUES_FOR_INFERENCE": {
        const issues = issuesNeedingAi();
        return {
          ok: true,
          data: {
            issues,
            pageTitle: document.title || "(untitled)",
            pageUrl: location.href,
          },
        };
      }

      case "APPLY_INFERENCES": {
        const inferences = message.inferences as InferenceResult[];
        return { ok: true, data: applyAiInferences(inferences) };
      }

      case "SET_REPAIRS_ENABLED": {
        setRepairsEnabled(message.enabled);
        return { ok: true, data: currentRepairState() };
      }

      case "GET_REPAIR_STATE":
      case "GET_ACCESSIBILITY_ISSUES": {
        const state = currentRepairState();
        if (dirty && state.issues.length === 0) {
          return { ok: true, data: runDeterministicScan() };
        }
        return { ok: true, data: state };
      }

      case "GET_APPLIED_REPAIRS": {
        return {
          ok: true,
          data: {
            success: true,
            message: formatRepairsMessage(),
            data: getAppliedRepairs(),
          },
        };
      }

      case "UNDO_ALL_REPAIRS": {
        undoAllRepairs();
        return { ok: true, data: currentRepairState() };
      }

      case "UNDO_REPAIR": {
        undoRepair(message.repairId);
        return { ok: true, data: currentRepairState() };
      }

      /** Image Accessibility & Vision Engine Messages */
      case "SCAN_IMAGES": {
        const result = scanPageImages();
        return { ok: true, data: result };
      }

      case "GET_IMAGE_DATA": {
        const dataUrl = await extractImageDataUrl(message.imageId);
        return {
          ok: true,
          data: { imageId: message.imageId, imageDataUrl: dataUrl },
        };
      }

      case "AUGMENT_IMAGE_ACCESSIBILITY": {
        const repairRecord = augmentImage(message.imageId, message.description);
        return {
          ok: true,
          data: { imageId: message.imageId, repaired: true, repairRecord },
        };
      }

      case "RESTORE_IMAGE_ACCESSIBILITY": {
        const ok = restoreImage(message.imageId);
        return {
          ok: true,
          data: { imageId: message.imageId, repaired: !ok },
        };
      }

      case "FOCUS_IMAGE": {
        const success = focusImageElement(message.imageId);
        return {
          ok: true,
          data: {
            success,
            message: success
              ? `Keyboard focus moved to ${message.imageId}.`
              : `Could not focus image ${message.imageId}.`,
          },
        };
      }

      case "GET_ACTIVE_IMAGE": {
        return {
          ok: true,
          data: {
            activeImageId: imageRegistry.getActiveId(),
          },
        };
      }

      default:
        return { ok: false, error: "Unknown PageGuide message." };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected page error";
    return {
      ok: false,
      error: `Something went wrong while reading this page: ${msg}`,
    };
  }
}

function formatRepairsMessage(): string {
  const repairs = getAppliedRepairs();
  const issues = getLastIssues();
  if (repairs.length === 0) {
    return issues.length
      ? `Found ${issues.length} issues; no repairs currently applied.`
      : "No repairs applied yet.";
  }
  const lines = repairs.slice(0, 20).map(
    (r) =>
      `- ${r.elementId}: ${r.attribute}="${r.newValue}" (${Math.round(r.confidence * 100)}%, ${r.source})`
  );
  return `Applied repairs (${repairs.length}):\n${lines.join("\n")}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionMessage(message)) return false;

  if (sender.url && sender.url.includes("sidepanel.html")) {
    return false;
  }

  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((err) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "Message handling failed",
      })
    );
  return true;
});
