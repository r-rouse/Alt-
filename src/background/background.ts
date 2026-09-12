/**
 * Background service worker.
 * Routes messages between the side panel and the active tab's content script.
 * Opens the side panel when the toolbar action is clicked.
 */

import type { ExtensionMessage, ExtensionResponse } from "../shared/messages";
import { isExtensionMessage } from "../shared/messages";
import type { BrowserTabInfo } from "../shared/types";

// Open side panel on action click (Chrome Side Panel API)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("PageGuide: side panel behavior", err));

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "orient-me") {
    // Side panel listens for this via runtime message broadcast
    chrome.runtime.sendMessage({ type: "ORIENT_COMMAND" }).catch(() => {
      /* side panel may be closed */
    });
  }
});

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const ping = (await chrome.tabs.sendMessage(tabId, {
      type: "PING",
    })) as ExtensionResponse;
    if (ping?.ok) return true;
  } catch {
    // Not injected yet
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["contentScript.js"],
    });
    // Brief pause for listener registration
    await new Promise((r) => setTimeout(r, 50));
    return true;
  } catch {
    return false;
  }
}

async function forwardToActiveTab(message: ExtensionMessage): Promise<ExtensionResponse> {
  const tabId = await getActiveTabId();
  if (tabId == null) {
    return {
      ok: false,
      error: "I couldn't find an active tab. Focus a webpage and try again.",
    };
  }

  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      error:
        "PageGuide can't read this Chrome page (settings, store, or similar). Open a regular website and try again.",
    };
  }

  const ready = await ensureContentScript(tabId);
  if (!ready) {
    return {
      ok: false,
      error:
        "I couldn't connect to this page. Try refreshing the tab, then open PageGuide again.",
    };
  }

  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      message
    )) as ExtensionResponse;
    return response ?? { ok: false, error: "No response from the page." };
  } catch {
    return {
      ok: false,
      error:
        "I lost connection to the page. Refresh the tab and try again.",
    };
  }
}

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const mimeType = blob.type || "image/jpeg";
  return `data:${mimeType};base64,${base64}`;
}

function isValidNavUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleOpenNewTab(url: string): Promise<ExtensionResponse> {
  if (!isValidNavUrl(url)) {
    return {
      ok: false,
      error: "I can't open that URL. Alt+ only navigates to web pages using http: or https:.",
    };
  }

  try {
    const tab = await chrome.tabs.create({ url, active: true });
    console.log(
      `[Alt+ Browser Action]\nIntent: Open URL in new tab\nAction: OPEN_NEW_TAB\nNew tab ID: ${tab.id}\nTarget URL: ${url}\nStatus: success`
    );
    return {
      ok: true,
      data: {
        tabId: tab.id!,
        url: tab.url || url,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to open new tab.",
    };
  }
}

async function handleGetOpenTabs(): Promise<ExtensionResponse> {
  try {
    const rawTabs = await chrome.tabs.query({ currentWindow: true });
    const tabs: BrowserTabInfo[] = rawTabs
      .filter((t) => t.id != null)
      .map((t) => ({
        id: t.id!,
        title: t.title || "Untitled Tab",
        url: t.url || "",
        active: Boolean(t.active),
      }));
    console.log(`[Alt+ Browser Action]\nAction: GET_OPEN_TABS\nTotal tabs: ${tabs.length}`);
    return { ok: true, data: { tabs } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to query open tabs.",
    };
  }
}

async function handleSwitchTab(tabId: number): Promise<ExtensionResponse> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    console.log(`[Alt+ Browser Action]\nAction: SWITCH_TAB\nTarget tab: ${tabId}\nStatus: success`);
    return {
      ok: true,
      data: {
        switched: true,
        tabId: tab.id ?? tabId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Failed to switch to tab ${tabId}.`,
    };
  }
}

async function handleCloseTab(tabId?: number): Promise<ExtensionResponse> {
  try {
    const targetId = tabId ?? (await getActiveTabId());
    if (targetId == null) {
      return { ok: false, error: "I couldn't find an active tab to close." };
    }
    await chrome.tabs.remove(targetId);
    console.log(`[Alt+ Browser Action]\nAction: CLOSE_TAB\nClosed tab: ${targetId}\nStatus: success`);
    return {
      ok: true,
      data: {
        closed: true,
        tabId: targetId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to close tab.",
    };
  }
}

// Track tab activations to broadcast to sidepanel
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && !isRestrictedUrl(tab.url)) {
      chrome.runtime
        .sendMessage({
          type: "TAB_CONTEXT_CHANGED",
          tabId: tab.id!,
          url: tab.url || "",
          title: tab.title || "",
          source: "activation",
        })
        .catch(() => {});
    }
  } catch {}
});

// Track completed tab navigation to broadcast to sidepanel
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active && !isRestrictedUrl(tab.url)) {
    chrome.runtime
      .sendMessage({
        type: "TAB_CONTEXT_CHANGED",
        tabId: tab.id!,
        url: tab.url || "",
        title: tab.title || "",
        source: "navigation",
      })
      .catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Direct background messages (e.g. image proxy fetch)
  if (message && typeof message === "object" && (message as { type?: string }).type === "FETCH_IMAGE_BLOB") {
    fetchImageAsDataUrl((message as { url: string }).url)
      .then((dataUrl) => sendResponse({ ok: true, data: { dataUrl } }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "Image fetch failed",
        })
      );
    return true; // async
  }

  // Messages from side panel destined for the page or browser
  if (!isExtensionMessage(message)) return false;

  // Ignore ORIENT_COMMAND from commands — side panel handles it
  if (message.type === "ORIENT_COMMAND" && sender.id === chrome.runtime.id && !sender.tab) {
    // Let other listeners (side panel) receive it; don't treat as page tool here
    return false;
  }

  // Handle browser-level actions in the service worker
  if (!sender.tab) {
    if (message.type === "OPEN_NEW_TAB") {
      handleOpenNewTab(message.url)
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : "Failed to open new tab.",
          })
        );
      return true; // async
    }

    if (message.type === "GET_OPEN_TABS") {
      handleGetOpenTabs()
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : "Failed to get open tabs.",
          })
        );
      return true; // async
    }

    if (message.type === "SWITCH_TAB") {
      handleSwitchTab(message.tabId)
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : "Failed to switch tab.",
          })
        );
      return true; // async
    }

    if (message.type === "CLOSE_TAB") {
      handleCloseTab(message.tabId)
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : "Failed to close tab.",
          })
        );
      return true; // async
    }

    // Side panel → background → content script
    forwardToActiveTab(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "Messaging failed.",
        } satisfies ExtensionResponse)
      );
    return true; // async
  }

  return false;
});
