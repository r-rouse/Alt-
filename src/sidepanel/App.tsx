/**
 * PageGuide Side Panel
 *
 * Product Metaphor: A knowledgeable, patient, sighted companion sitting beside
 * a blind or low-vision person, looking at the screen together, explaining what
 * is there, describing visual highlights, guiding navigation, and helping them
 * achieve their goals.
 *
 * Architecture:
 * - PageGuideAgentBridge (AG-UI standard agent ↔ application bridge)
 * - VisionService with VisionProvider layer (OpenAI default / OpenRouter optional)
 * - Reactive Agent State (activeImageId multi-turn conversational exploration)
 * - Silent Runtime Accessibility Repairs in background
 * - Warm Automatic Companion Orientation on page connect
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { runAgentTurn, generateCompanionOrientation } from "../agent/agent";
import { inferAccessibilityRepairs } from "../agent/accessibilityAgent";
import {
  VisionService,
  createVisionService,
} from "../agent/visionProvider";
import { PageGuideAgentBridge, type PageGuideAgentState } from "../agent/agentBridge";
import { audio, type HandsFreeState } from "./audioService";
import type { ExtensionMessage, ExtensionResponse } from "../shared/messages";
import type {
  AccessibilityIssue,
  AccessibilityScanResult,
  AppliedRepair,
  SuggestedRepair,
} from "../shared/accessibility";
import type {
  PageImage,
  ImageScanSummary,
} from "../shared/images";
import type { ChatMessage, PageStructureResult } from "../shared/types";
import {
  generateProofOfRelevanceAudit,
  formatAuditAsMarkdown,
  formatAuditAsJson,
  logAuditToConsole,
  type ProofOfRelevanceAudit,
  type AuditLogItem,
} from "../shared/accessibilityAuditLog";

type UiMessage = { id: string; role: "user" | "assistant"; content: string };

const STORAGE_KEY = "pageguide_openai_key";
const OPENROUTER_STORAGE_KEY = "pageguide_openrouter_key";
const PROVIDER_STORAGE_KEY = "pageguide_vision_provider";
const AUDIO_STORAGE_KEY = "pageguide_audio_enabled";
const HANDSFREE_STORAGE_KEY = "pageguide_handsfree_enabled";

async function sendToPage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return (await chrome.runtime.sendMessage(message)) as ExtensionResponse;
}

function getEnvApiKey(): string {
  try {
    return (import.meta.env.VITE_OPENAI_API_KEY as string) || "";
  } catch {
    return "";
  }
}

function getEnvOpenRouterKey(): string {
  try {
    return (import.meta.env.VITE_OPENROUTER_API_KEY as string) || "";
  } catch {
    return "";
  }
}

function getEnvProvider(): "openai" | "openrouter" {
  try {
    const p = (import.meta.env.VITE_VISION_PROVIDER as string) || "openai";
    return p === "openrouter" ? "openrouter" : "openai";
  } catch {
    return "openai";
  }
}

function isScanResult(data: unknown): data is AccessibilityScanResult {
  return Boolean(data && typeof data === "object" && "summary" in data && "issues" in data);
}

function getVisualLabel(img: PageImage, index: number): string {
  if (img.heading && img.heading.trim()) return img.heading.trim();
  if (img.caption && img.caption.trim()) return img.caption.trim();
  if (
    img.alt &&
    img.alt.trim().length > 3 &&
    !img.alt.toLowerCase().includes("image") &&
    !img.alt.toLowerCase().includes("photo")
  ) {
    return img.alt.trim();
  }
  if (img.nearbyText) {
    const sentence = img.nearbyText.split(/[.?!]/)[0]?.trim();
    if (sentence && sentence.length > 5 && sentence.length < 60) {
      return sentence;
    }
  }
  return `Visual Highlight ${index + 1}`;
}

export function App() {
  const titleId = useId();
  const inputId = useId();
  const keyInputId = useId();
  const routerKeyInputId = useId();

  // Page Connection State
  const [pageTitle, setPageTitle] = useState("Connecting to page…");
  const [pageUrl, setPageUrl] = useState("");
  const [pageStructure, setPageStructure] = useState("");

  // Provider & API Keys Configuration
  const [providerType, setProviderType] = useState<"openai" | "openrouter">(getEnvProvider);
  const [openAiKey, setOpenAiKey] = useState(getEnvApiKey);
  const [openAiKeyDraft, setOpenAiKeyDraft] = useState(getEnvApiKey);
  const [openRouterKey, setOpenRouterKey] = useState(getEnvOpenRouterKey);
  const [openRouterKeyDraft, setOpenRouterKeyDraft] = useState(getEnvOpenRouterKey);

  // Visual Highlights State
  const [images, setImages] = useState<PageImage[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [imageScanning, setImageScanning] = useState(false);
  const [imageProcessingId, setImageProcessingId] = useState<string | null>(null);
  const [showVisualsList, setShowVisualsList] = useState(true);

  // Background Accessibility Repair State (Silent)
  const [scan, setScan] = useState<AccessibilityScanResult | null>(null);
  const [repairsOn, setRepairsOn] = useState(true);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  // Proof of Relevance Audit State
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [auditFilter, setAuditFilter] = useState<"all" | "high" | "repaired" | "unrepaired">("all");
  const [copiedAuditNotice, setCopiedAuditNotice] = useState(false);

  // Audio & Voice State
  const [audioEnabled, setAudioEnabled] = useState(true);
  const audioEnabledRef = useRef(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported] = useState(() => audio.isVoiceInputSupported());
  const [micPermissionNeeded, setMicPermissionNeeded] = useState(false);
  const [handsFreeActive, setHandsFreeActive] = useState(false);
  const [handsFreeState, setHandsFreeState] = useState<HandsFreeState>("off");

  // Conversation & Agent State
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");
  const [hasOriented, setHasOriented] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => {});
  const pendingTabOrientation = useRef<boolean>(false);

  const sendToPageWrapped = useCallback(
    async (message: ExtensionMessage): Promise<ExtensionResponse> => {
      if (message.type === "OPEN_NEW_TAB" || message.type === "SWITCH_TAB") {
        pendingTabOrientation.current = true;
      }
      return sendToPage(message);
    },
    []
  );

  // Agent / UI Bridge instance (AG-UI Architecture)
  const bridgeRef = useRef<PageGuideAgentBridge | null>(null);
  if (!bridgeRef.current) {
    const vs = createVisionService({
      providerType,
      openAiKey,
      openRouterKey,
    });
    bridgeRef.current = new PageGuideAgentBridge(sendToPageWrapped, vs);
  }

  // Subscribe to Bridge State Updates
  useEffect(() => {
    if (!bridgeRef.current) return;
    const unsub = bridgeRef.current.subscribe((state: PageGuideAgentState) => {
      setImages(state.images);
      setActiveImageId(state.activeImageId);
      if (state.page.title && state.page.title !== "(not connected)") {
        setPageTitle(state.page.title);
      }
      if (state.page.url) {
        setPageUrl(state.page.url);
      }
      setRepairsOn(state.repairsEnabled);
    });
    return unsub;
  }, []);

  // Sync VisionService on Key/Provider changes
  useEffect(() => {
    if (!bridgeRef.current) return;
    const vs = createVisionService({
      providerType,
      openAiKey,
      openRouterKey,
    });
    bridgeRef.current.setVisionService(vs);
  }, [providerType, openAiKey, openRouterKey]);

  // Subscribe to audio service status
  useEffect(() => {
    const unsubSpeaking = audio.onSpeakingChange(setIsSpeaking);
    const unsubListening = audio.onListeningChange(setIsListening);
    const unsubHandsFree = audio.onHandsFreeStateChange((state) => {
      setHandsFreeState(state);
      setHandsFreeActive(state !== "off");
    });
    return () => {
      unsubSpeaking();
      unsubListening();
      unsubHandsFree();
    };
  }, []);

  const announce = useCallback((text: string, options?: { speak?: boolean }) => {
    setLiveAnnouncement("");
    window.setTimeout(() => setLiveAnnouncement(text), 30);
    const shouldSpeak = options?.speak ?? true;
    if (audioEnabledRef.current && shouldSpeak) {
      audio.speak(text);
    }
  }, []);

  // Load API keys, provider, and audio setting
  useEffect(() => {
    chrome.storage.local.get(
      [
        STORAGE_KEY,
        OPENROUTER_STORAGE_KEY,
        PROVIDER_STORAGE_KEY,
        AUDIO_STORAGE_KEY,
        HANDSFREE_STORAGE_KEY,
      ],
      (result) => {
        const storedKey = (result[STORAGE_KEY] as string) || "";
        const storedRouterKey = (result[OPENROUTER_STORAGE_KEY] as string) || "";
        const storedProvider =
          (result[PROVIDER_STORAGE_KEY] as "openai" | "openrouter") || getEnvProvider();

        const key = storedKey || getEnvApiKey();
        const rKey = storedRouterKey || getEnvOpenRouterKey();

        setOpenAiKey(key);
        setOpenAiKeyDraft(key);
        setOpenRouterKey(rKey);
        setOpenRouterKeyDraft(rKey);
        setProviderType(storedProvider);

        if (!key && !rKey) setShowSettings(true);

        if (typeof result[AUDIO_STORAGE_KEY] === "boolean") {
          setAudioEnabled(result[AUDIO_STORAGE_KEY]);
          audioEnabledRef.current = result[AUDIO_STORAGE_KEY];
        }

        // Auto-resume Hands-Free if previously enabled by user
        if (result[HANDSFREE_STORAGE_KEY] === true && audio.isVoiceInputSupported()) {
          void audio.startHandsFree({
            onCommand: (cmd) => {
              void sendRef.current(cmd);
            },
            onError: (err, isPerm) => {
              if (isPerm) setMicPermissionNeeded(true);
              setErrorBanner(err);
            },
          });
        }
      }
    );
  }, []);

  const applyScanResult = useCallback((data: AccessibilityScanResult) => {
    setScan(data);
    setPageTitle(data.meta.title);
    setPageUrl(data.meta.url);
    setRepairsOn(data.repairsEnabled);
    setErrorBanner("");
    bridgeRef.current?.updatePageInfo(data.meta.title, data.meta.url, data.repairsEnabled);

    try {
      const audit = generateProofOfRelevanceAudit(data, images);
      logAuditToConsole(audit, "Companion Side Panel");
    } catch {}
  }, [images]);

  // Scan Images silently for visual highlights
  const runImageScan = useCallback(async (): Promise<PageImage[]> => {
    setImageScanning(true);
    const res = await sendToPage({ type: "SCAN_IMAGES" });
    setImageScanning(false);
    if (!res.ok) {
      return [];
    }
    const data = res.data as {
      images: PageImage[];
      summary: ImageScanSummary;
      activeImageId: string | null;
    };
    bridgeRef.current?.setImages(data.images, data.activeImageId);
    return data.images;
  }, []);

  // Silent background scan + runtime DOM repairs
  const runSilentRepairs = useCallback(
    async (keyOverride?: string): Promise<AccessibilityScanResult | null> => {
      const key = keyOverride ?? openAiKey;
      const response = await sendToPage({ type: "RUN_FULL_SCAN" });
      if (!response.ok || !isScanResult(response.data)) {
        return null;
      }

      let result = response.data;
      applyScanResult(result);

      // Perform silent AI inferences for any remaining unlabeled interactive elements
      if (key) {
        try {
          const need = await sendToPage({ type: "GET_ISSUES_FOR_INFERENCE" });
          if (need.ok && need.data && "issues" in need.data) {
            const payload = need.data as {
              issues: AccessibilityIssue[];
              pageTitle: string;
              pageUrl: string;
            };
            if (payload.issues.length > 0) {
              const { inferences } = await inferAccessibilityRepairs(
                key,
                payload.issues,
                payload.pageTitle,
                payload.pageUrl
              );
              if (inferences.length > 0) {
                const applied = await sendToPage({
                  type: "APPLY_INFERENCES",
                  inferences,
                });
                if (applied.ok && isScanResult(applied.data)) {
                  result = applied.data;
                  applyScanResult(result);
                }
              }
            }
          }
        } catch (err) {
          console.warn("Silent repair inference completed with warning:", err);
        }
      }
      return result;
    },
    [openAiKey, applyScanResult]
  );

  const refreshStructure = async (): Promise<PageStructureResult | null> => {
    const res = await sendToPage({ type: "GET_PAGE_STRUCTURE" });
    if (!res.ok) return null;
    const data = res.data as PageStructureResult;
    setPageStructure(data.text);
    setPageTitle(data.meta.title);
    setPageUrl(data.meta.url);
    bridgeRef.current?.updatePageInfo(data.meta.title, data.meta.url);
    return data;
  };

  // Perform Warm Companion Orientation
  const performOrientation = useCallback(
    async (overrideKey?: string) => {
      const activeKey =
        overrideKey || (providerType === "openrouter" ? openRouterKey : openAiKey);
      setBusy(true);
      audio.playEarcon("scan_start");

      const [struct, scannedImages] = await Promise.all([
        refreshStructure(),
        runImageScan(),
      ]);

      const title = struct?.meta.title || pageTitle;
      const url = struct?.meta.url || pageUrl;
      const structureText = struct?.text || pageStructure;

      const orientation = await generateCompanionOrientation({
        apiKey: activeKey,
        pageTitle: title,
        pageUrl: url,
        pageStructure: structureText,
        images: scannedImages,
        providerType,
      });

      setMessages((prev) => [
        ...prev,
        { id: `orient-${Date.now()}`, role: "assistant", content: orientation },
      ]);
      announce(orientation, { speak: true });
      audio.playEarcon("scan_complete");
      setBusy(false);
      setHasOriented(true);
    },
    [providerType, openRouterKey, openAiKey, pageTitle, pageUrl, pageStructure, runImageScan, announce]
  );

  // Initial load: run silent repairs, discover visual highlights, and greet user with Companion Orientation
  const didInitialConnect = useRef(false);
  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY, OPENROUTER_STORAGE_KEY], async (result) => {
      if (didInitialConnect.current) return;
      didInitialConnect.current = true;

      const stored = (result[STORAGE_KEY] as string) || "";
      const storedRouter = (result[OPENROUTER_STORAGE_KEY] as string) || "";
      const key = stored || getEnvApiKey();
      const rKey = storedRouter || getEnvOpenRouterKey();

      setOpenAiKey(key);
      setOpenAiKeyDraft(key);
      setOpenRouterKey(rKey);
      setOpenRouterKeyDraft(rKey);

      // 1. Silently repair page semantics for screen readers
      void runSilentRepairs(key);

      // 2. Discover visual highlights and deliver warm companion orientation
      const effectiveKey = providerType === "openrouter" ? rKey : key;
      void performOrientation(effectiveKey);
    });
  }, [runSilentRepairs, performOrientation, providerType]);

  const appendAssistant = useCallback(
    (content: string) => {
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}-${prev.length}`, role: "assistant", content },
      ]);
      announce(content, { speak: true });
    },
    [announce]
  );

  const handleTabContextSwitch = useCallback(
    async (tabId: number, url: string, title: string, isFromAgentAction = false) => {
      try {
        await new Promise((r) => setTimeout(r, 200));
        const struct = await refreshStructure();
        if (struct) {
          setPageTitle(struct.meta.title || title);
          setPageUrl(struct.meta.url || url);
        }
        await runImageScan();
        const effectiveKey = providerType === "openrouter" ? openRouterKey : openAiKey;
        if (effectiveKey) {
          void runSilentRepairs(effectiveKey);
        }

        if (isFromAgentAction && struct) {
          const cleanTitle = struct.meta.title || "new";
          const matchHeading = struct.text.match(/Heading \d: ([^\n]+)/i);
          const headingHint = matchHeading ? matchHeading[1].trim() : "";
          const orientationText = headingHint
            ? `You're now on the ${cleanTitle} page. It starts with ${headingHint}.`
            : `You're now on the ${cleanTitle} page.`;
          appendAssistant(orientationText);
        }
      } catch (err) {
        console.warn("Failed to synchronize tab context:", err);
      }
    },
    [refreshStructure, runImageScan, runSilentRepairs, providerType, openRouterKey, openAiKey, appendAssistant]
  );

  // Listen for shortcuts, permissions & tab switches
  useEffect(() => {
    const listener = (message: unknown) => {
      if (message && typeof message === "object") {
        const msg = message as { type?: string };
        if (msg.type === "ORIENT_COMMAND") {
          void performOrientation();
        } else if (msg.type === "MIC_PERMISSION_GRANTED") {
          setMicPermissionNeeded(false);
          setErrorBanner("");
          announce(
            "Microphone permission granted. You can now use voice commands.",
            { speak: true }
          );
        } else if (msg.type === "TAB_CONTEXT_CHANGED") {
          const tabMsg = msg as {
            type: "TAB_CONTEXT_CHANGED";
            tabId: number;
            url: string;
            title: string;
            source?: string;
          };
          const shouldOrient = pendingTabOrientation.current;
          pendingTabOrientation.current = false;
          void handleTabContextSwitch(tabMsg.tabId, tabMsg.url, tabMsg.title, shouldOrient);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [announce, performOrientation, handleTabContextSwitch]);

  // Focus and select image via Bridge
  const focusAndSelectImage = async (imageId: string) => {
    if (!bridgeRef.current) return;
    const ok = await bridgeRef.current.focusImage(imageId);
    if (ok) {
      audio.playEarcon("focus_moved");
      const img = images.find((i) => i.id === imageId);
      const label = img ? getVisualLabel(img, 0) : imageId;
      announce(`Focused ${label} on page.`, { speak: true });
    }
  };

  // Step to Next Image
  const handleNextImage = async () => {
    if (!bridgeRef.current) return;
    const next = await bridgeRef.current.nextImage();
    if (next) {
      audio.playEarcon("focus_moved");
      const label = getVisualLabel(next, 0);
      announce(`Selected next visual highlight: ${label}`, { speak: true });
    }
  };

  // Step to Previous Image
  const handlePreviousImage = async () => {
    if (!bridgeRef.current) return;
    const prev = await bridgeRef.current.previousImage();
    if (prev) {
      audio.playEarcon("focus_moved");
      const label = getVisualLabel(prev, 0);
      announce(`Selected previous visual highlight: ${label}`, { speak: true });
    }
  };

  const currentActiveKey = providerType === "openrouter" ? openRouterKey : openAiKey;

  // Describe image with Vision (Quick Alt or Detailed)
  const describeImage = async (
    imageId: string,
    mode: "quick" | "detailed"
  ) => {
    if (!currentActiveKey) {
      setShowSettings(true);
      const err = `Please save your ${
        providerType === "openrouter" ? "OpenRouter" : "OpenAI"
      } API key in Settings first.`;
      setErrorBanner(err);
      announce(err, { speak: true });
      return;
    }

    if (!bridgeRef.current) return;

    setImageProcessingId(imageId);
    audio.playEarcon("scan_start");
    const target = images.find((i) => i.id === imageId);
    const label = target ? getVisualLabel(target, 0) : "visual";
    announce(
      `Analyzing ${label} with companion vision...`,
      { speak: true }
    );

    try {
      const description = await bridgeRef.current.describeImage(imageId, mode);
      audio.playEarcon("image_described");
      appendAssistant(description);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to describe visual";
      setErrorBanner(msg);
      announce(msg, { speak: true });
      audio.playEarcon("error");
    } finally {
      setImageProcessingId(null);
    }
  };

  // Ask interactive question about active visual
  const askImageQuestion = async (imageId: string, question: string) => {
    if (!currentActiveKey) {
      setShowSettings(true);
      const err = `Please save your ${
        providerType === "openrouter" ? "OpenRouter" : "OpenAI"
      } API key in Settings first.`;
      setErrorBanner(err);
      announce(err, { speak: true });
      return;
    }

    if (!bridgeRef.current) return;

    setBusy(true);
    setImageProcessingId(imageId);
    audio.playEarcon("scan_start");

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}-${prev.length}`, role: "user", content: question },
    ]);

    try {
      const answer = await bridgeRef.current.askImageQuestion(imageId, question);
      audio.playEarcon("image_described");
      appendAssistant(answer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to answer question";
      setErrorBanner(msg);
      announce(msg, { speak: true });
      audio.playEarcon("error");
    } finally {
      setBusy(false);
      setImageProcessingId(null);
      inputRef.current?.focus();
    }
  };

  // Determine if a query specifically targets the currently active visual
  const isImageSpecificQuestion = (text: string): boolean => {
    if (!activeImageId) return false;
    const lower = text.toLowerCase();
    // Non-image queries that should go to page agent turn
    if (
      lower.includes("orient") ||
      lower.includes("what is this page") ||
      lower.includes("what's on this page") ||
      lower.includes("navigate") ||
      lower.includes("take me to") ||
      lower.includes("register") ||
      lower.includes("search for")
    ) {
      return false;
    }
    return (
      lower.includes("describe") ||
      lower.includes("tell me more") ||
      lower.includes("chart") ||
      lower.includes("map") ||
      lower.includes("photo") ||
      lower.includes("picture") ||
      lower.includes("detail") ||
      lower.includes("what does this") ||
      lower.includes("read text") ||
      lower.includes("trend") ||
      lower.includes("peak") ||
      lower.includes("what is in this")
    );
  };

  // Master send handler (Text or Voice)
  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    setInput("");
    audio.notifyHandsFreeProcessing(true);

    // If active image and user specifically asks about the image:
    if (activeImageId && isImageSpecificQuestion(text)) {
      const lower = text.toLowerCase();
      if (
        (lower.includes("describe") && !lower.includes("detail")) ||
        lower === "describe this" ||
        lower === "describe this image"
      ) {
        await describeImage(activeImageId, "quick");
        return;
      }
      if (lower.includes("tell me more") || lower.includes("detail")) {
        await describeImage(activeImageId, "detailed");
        return;
      }
      await askImageQuestion(activeImageId, text);
      return;
    }

    // Direct check for orientation
    const lower = text.toLowerCase();
    if (
      lower === "orient me" ||
      lower === "orient me." ||
      lower === "what's on this page?" ||
      lower === "what is on this page?"
    ) {
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}-${prev.length}`, role: "user", content: text },
      ]);
      await performOrientation();
      return;
    }

    // Otherwise, route to page-level companion agent turn
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}-${prev.length}`, role: "user", content: text },
    ]);

    const structure = await refreshStructure();

    const history: ChatMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const result = await runAgentTurn({
      apiKey: currentActiveKey,
      userText: text,
      pageStructure: structure?.text || pageStructure,
      pageTitle: structure?.meta.title || pageTitle,
      pageUrl: structure?.meta.url || pageUrl,
      history,
      execute: sendToPageWrapped,
      bridge: bridgeRef.current || undefined,
      providerType,
    });

    if (result.toolsUsed.includes("focusElement") || result.toolsUsed.includes("focusImage")) {
      audio.playEarcon("focus_moved");
    }

    appendAssistant(result.reply);

    // If tab navigation occurred and hasn't oriented yet, deliver short transition orientation
    if (pendingTabOrientation.current) {
      pendingTabOrientation.current = false;
      setTimeout(async () => {
        try {
          const newStruct = await refreshStructure();
          if (newStruct) {
            setPageTitle(newStruct.meta.title);
            setPageUrl(newStruct.meta.url);
            const matchHeading = newStruct.text.match(/Heading \d: ([^\n]+)/i);
            const headingHint = matchHeading ? matchHeading[1].trim() : "";
            const orientationText = headingHint
              ? `You're now on the ${newStruct.meta.title} page. It starts with ${headingHint}.`
              : `You're now on the ${newStruct.meta.title} page.`;
            appendAssistant(orientationText);
          }
        } catch {}
      }, 400);
    }

    if (result.error === "missing_api_key") setShowSettings(true);
    setBusy(false);
    inputRef.current?.focus();
  };

  sendRef.current = handleSend;

  const toggleHandsFree = useCallback(async () => {
    if (audio.isHandsFreeActive()) {
      audio.stopHandsFree();
      audio.playEarcon("toggle_off");
      chrome.storage.local.set({ [HANDSFREE_STORAGE_KEY]: false });
      announce("Hands-free voice mode turned off.", { speak: true });
    } else {
      audio.playEarcon("toggle_on");
      chrome.storage.local.set({ [HANDSFREE_STORAGE_KEY]: true });
      await audio.startHandsFree({
        onCommand: (command) => {
          setInput(command);
          void sendRef.current(command);
        },
        onError: (err, isPermissionError) => {
          if (isPermissionError) {
            setMicPermissionNeeded(true);
          }
          setErrorBanner(err);
          announce(err, { speak: true });
        },
      });
      announce(
        "Hands-free mode active. Just say PageGuide, or speak your request.",
        { speak: true }
      );
    }
  }, [announce]);

  const toggleListening = useCallback(() => {
    if (audio.isListening()) {
      audio.stopListening();
      return;
    }
    audio.startListening({
      apiKey: openAiKey,
      onResult: (transcript) => {
        if (transcript.trim()) {
          setInput(transcript);
          void sendRef.current(transcript);
        }
      },
      onError: (err, isPermissionError) => {
        if (isPermissionError) {
          setMicPermissionNeeded(true);
        }
        setErrorBanner(err);
        announce(err, { speak: true });
      },
    });
  }, [announce, openAiKey]);

  // Global keyboard shortcuts (Escape to silence, Alt+M for voice command)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (audio.isSpeaking()) {
          audio.stopSpeaking();
        }
        if (audio.isListening()) {
          audio.stopListening();
        }
      }
      if ((e.altKey || e.metaKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleListening();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleListening]);

  // Silent Background Repairs Toggle
  const toggleRepairs = async (enabled: boolean) => {
    if (enabled) {
      audio.playEarcon("toggle_on");
    } else {
      audio.playEarcon("toggle_off");
    }
    const response = await sendToPage({ type: "SET_REPAIRS_ENABLED", enabled });
    if (!response.ok) {
      setErrorBanner(response.error);
      audio.playEarcon("error");
      return;
    }
    if (isScanResult(response.data)) {
      applyScanResult(response.data);
      announce(
        enabled
          ? "Silent screen reader repairs enabled."
          : "Silent repairs disabled. Original page semantics restored.",
        { speak: true }
      );
    }
  };

  const undoAll = async () => {
    const response = await sendToPage({ type: "UNDO_ALL_REPAIRS" });
    if (response.ok && isScanResult(response.data)) {
      applyScanResult(response.data);
      audio.playEarcon("toggle_off");
      announce("All PageGuide runtime repairs removed.", { speak: true });
    }
  };

  // Filter out decorative images from visual highlights list
  const visualHighlights = images.filter((i) => i.accessibilityStatus !== "decorative");
  const activeImage = visualHighlights.find((i) => i.id === activeImageId);

  // Proof of Relevance Audit Computation
  const auditLog: ProofOfRelevanceAudit | null = scan
    ? generateProofOfRelevanceAudit(scan, images)
    : null;

  const filteredAuditItems: AuditLogItem[] = (auditLog?.items || []).filter((item) => {
    if (auditFilter === "high") return item.severity === "high";
    if (auditFilter === "repaired") return item.repaired;
    if (auditFilter === "unrepaired") return !item.repaired;
    return true;
  });

  const handleCopyAuditMarkdown = async () => {
    if (!auditLog) return;
    const md = formatAuditAsMarkdown(auditLog);
    try {
      await navigator.clipboard.writeText(md);
      setCopiedAuditNotice(true);
      audio.playEarcon("repair_applied");
      announce("Proof of relevance audit log copied to clipboard as Markdown.", { speak: true });
      setTimeout(() => setCopiedAuditNotice(false), 2500);
    } catch {
      announce("Failed to copy audit log to clipboard.", { speak: true });
    }
  };

  const handleDownloadAuditJson = () => {
    if (!auditLog) return;
    const jsonStr = formatAuditAsJson(auditLog);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pageguide-accessibility-audit-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    announce("Downloaded accessibility audit log JSON.", { speak: true });
  };

  const handleHighlightIssue = async (elementId: string, label: string) => {
    await sendToPage({ type: "FOCUS_ELEMENT", elementId });
    audio.playEarcon("focus_moved");
    announce(`Focused ${label} on page.`, { speak: true });
  };

  return (
    <div className="app">
      {/* Companion Brand Header */}
      <header className="header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 id={titleId} className="brand">
              PageGuide
            </h1>
            <p className="tagline">Your Sighted Companion for the Web</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <button
              type="button"
              className={`btn btn-audit-trigger ${showAuditModal ? "btn-audit-trigger-active" : ""}`}
              onClick={() => setShowAuditModal((v) => !v)}
              aria-expanded={showAuditModal}
              title="Proof of Relevance: View accessibility barriers and repairs"
              aria-label={`Proof of relevance: ${auditLog ? auditLog.stats.totalIssues : 0} accessibility barriers`}
            >
              📊 Proof of Relevance {auditLog && auditLog.stats.totalIssues > 0 ? `(${auditLog.stats.totalIssues})` : ""}
            </button>
            <button
              type="button"
              className="btn btn-settings-icon"
              onClick={() => setShowSettings((s) => !s)}
              aria-expanded={showSettings}
              title="PageGuide Settings"
              aria-label="Settings"
            >
              ⚙ Settings
            </button>
          </div>
        </div>

        {/* Live Page Context Indicator */}
        <div className="page-context-badge" role="status" aria-label="Current webpage">
          <span className="page-context-dot" aria-hidden="true" />
          <span className="page-context-title" title={pageTitle}>
            Looking at: <strong>{pageTitle || "Current webpage"}</strong>
          </span>
        </div>
      </header>

      {/* Audio & Hands-Free Toolbar */}
      <div className="audio-toolbar" role="region" aria-label="Audio controls">
        <button
          type="button"
          className={`btn btn-audio ${audioEnabled ? "btn-audio-active" : ""}`}
          onClick={() => {
            const next = !audioEnabled;
            setAudioEnabled(next);
            audioEnabledRef.current = next;
            chrome.storage.local.set({ [AUDIO_STORAGE_KEY]: next });
            if (!next) {
              audio.stopSpeaking();
            } else {
              audio.playEarcon("toggle_on");
              audio.speak("Voice audio enabled.");
            }
          }}
          aria-pressed={audioEnabled}
          aria-label={
            audioEnabled
              ? "Voice audio is ON. Click to mute."
              : "Voice audio is OFF. Click to unmute."
          }
        >
          {audioEnabled ? "🔊 Voice: ON" : "🔇 Voice: OFF"}
        </button>

        {isSpeaking ? (
          <button
            type="button"
            className="btn btn-speaking"
            onClick={() => audio.stopSpeaking()}
            aria-label="Silence speech"
            title="Press Escape or click to silence speech"
          >
            ⏹ Silence (Esc)
          </button>
        ) : null}

        {voiceSupported ? (
          <button
            type="button"
            className={`btn btn-handsfree ${handsFreeActive ? "btn-handsfree-active" : ""}`}
            onClick={toggleHandsFree}
            aria-pressed={handsFreeActive}
            aria-label={
              handsFreeActive
                ? "Hands-free voice mode is active. Say PageGuide or speak your command. Click to turn off."
                : "Turn on hands-free voice mode. Wake word: PageGuide."
            }
            title={
              handsFreeActive
                ? "Hands-free mode active (wake word: 'PageGuide')"
                : "Enable hands-free mode (wake word: 'PageGuide')"
            }
          >
            {handsFreeActive ? "✨ Hands-Free: ON" : "✨ Hands-Free: OFF"}
          </button>
        ) : null}

        {voiceSupported ? (
          <button
            type="button"
            className={`btn btn-mic ${isListening ? "btn-mic-active" : ""}`}
            onClick={toggleListening}
            aria-pressed={isListening}
            aria-label={
              isListening
                ? "Listening to your voice. Click to cancel."
                : "Speak a voice command (Alt+M)"
            }
            title="Speak a voice command (Alt+M)"
          >
            {isListening ? "🔴 Listening…" : "🎤 Push-to-Talk (Alt+M)"}
          </button>
        ) : null}

        <button
          type="button"
          className="btn"
          style={{ marginLeft: "auto", fontSize: "0.82rem", padding: "0.3rem 0.55rem" }}
          onClick={() => void performOrientation()}
          title="Re-orient to this page"
          disabled={busy}
        >
          🧭 Re-Orient
        </button>
      </div>

      {/* Hands-Free Live Conversational Status Bar */}
      {handsFreeActive ? (
        <div
          className={`handsfree-banner handsfree-banner-${handsFreeState}`}
          role="status"
          aria-live="polite"
        >
          <span className="handsfree-dot" aria-hidden="true" />
          <span className="handsfree-text">
            {handsFreeState === "waiting_for_wake_word" && (
              <>👂 Say <strong>&quot;PageGuide&quot;</strong> to speak</>
            )}
            {handsFreeState === "listening_command" && (
              <>🟢 Listening… (speak your request, or say &quot;Thanks PageGuide&quot;)</>
            )}
            {handsFreeState === "processing" && <>⚙️ Thinking…</>}
            {handsFreeState === "speaking" && (
              <>🔊 Speaking… (press Esc to silence)</>
            )}
            {handsFreeState === "off" && <>Hands-free inactive</>}
          </span>
        </div>
      ) : null}

      {/* Error or Warning Banner */}
      {errorBanner ? (
        <div className="error" role="alert">
          {errorBanner}
        </div>
      ) : null}

      {/* Microphone Permission Instructions Banner */}
      {micPermissionNeeded ? (
        <div className="mic-banner" role="alert">
          <p style={{ margin: "0 0 0.35rem", fontWeight: 700 }}>
            Microphone Access Needed for Voice Commands
          </p>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>
            Chrome side panels require a one-time tab prompt to enable microphone access.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => audio.openPermissionTab()}
          >
            Open Microphone Authorization Tab
          </button>
        </div>
      ) : null}

      {/* Proof of Relevance: Full Accessibility Error Audit Log */}
      {showAuditModal && auditLog ? (
        <section className="audit-section" aria-labelledby="audit-heading">
          <div className="audit-header">
            <div>
              <h2 id="audit-heading" className="audit-title">
                📊 Proof of Relevance: Accessibility Barrier Audit
              </h2>
              <p className="hint" style={{ margin: "0.15rem 0 0" }}>
                Empirical proof of barriers found on this page and runtime remediations performed by PageGuide.
              </p>
            </div>
            <button
              type="button"
              className="btn-chip"
              onClick={() => setShowAuditModal(false)}
              aria-label="Close audit log"
            >
              ✕ Close
            </button>
          </div>

          {/* KPI Summary Cards */}
          <div className="audit-stat-grid" role="region" aria-label="Accessibility barrier metrics">
            <div className="audit-stat-card audit-stat-barriers">
              <span className="audit-stat-num">{auditLog.stats.totalIssues}</span>
              <span className="audit-stat-label">Barriers Found</span>
            </div>
            <div className="audit-stat-card audit-stat-critical">
              <span className="audit-stat-num">{auditLog.stats.criticalHighCount}</span>
              <span className="audit-stat-label">Critical Blockers</span>
            </div>
            <div className="audit-stat-card audit-stat-repaired">
              <span className="audit-stat-num">
                {auditLog.stats.repairedCount}
                <small style={{ fontSize: "0.75rem", opacity: 0.85, marginLeft: "2px" }}>
                  ({auditLog.stats.repairRatePercent}%)
                </small>
              </span>
              <span className="audit-stat-label">Repaired Live</span>
            </div>
            <div className="audit-stat-card audit-stat-visuals">
              <span className="audit-stat-num">{auditLog.stats.inaccessibleImagesCount}</span>
              <span className="audit-stat-label">Inaccessible Visuals</span>
            </div>
          </div>

          {/* Export and Action Toolbar */}
          <div className="audit-actions-row">
            <button
              type="button"
              className="btn btn-audit-action"
              onClick={() => void handleCopyAuditMarkdown()}
              title="Copy complete markdown audit log to clipboard for reports or evaluation"
            >
              {copiedAuditNotice ? "✓ Copied to Clipboard!" : "📋 Copy Markdown Log"}
            </button>
            <button
              type="button"
              className="btn btn-audit-action"
              onClick={handleDownloadAuditJson}
              title="Download full structured audit report as JSON"
            >
              💾 Export JSON
            </button>
          </div>

          {/* Filter Pills */}
          <div className="audit-filters-row" role="tablist" aria-label="Filter accessibility errors">
            <button
              type="button"
              className={`audit-filter-pill ${auditFilter === "all" ? "audit-filter-pill-active" : ""}`}
              onClick={() => setAuditFilter("all")}
            >
              All ({auditLog.stats.totalIssues})
            </button>
            <button
              type="button"
              className={`audit-filter-pill ${auditFilter === "high" ? "audit-filter-pill-active" : ""}`}
              onClick={() => setAuditFilter("high")}
            >
              Critical ({auditLog.stats.criticalHighCount})
            </button>
            <button
              type="button"
              className={`audit-filter-pill ${auditFilter === "repaired" ? "audit-filter-pill-active" : ""}`}
              onClick={() => setAuditFilter("repaired")}
            >
              Repaired ({auditLog.stats.repairedCount})
            </button>
            <button
              type="button"
              className={`audit-filter-pill ${auditFilter === "unrepaired" ? "audit-filter-pill-active" : ""}`}
              onClick={() => setAuditFilter("unrepaired")}
            >
              Needs Review ({auditLog.stats.unrepairedCount})
            </button>
          </div>

          {/* Detailed Error Cards List */}
          <div className="audit-items-list" role="feed" aria-label="Accessibility error list">
            {filteredAuditItems.length === 0 ? (
              <p className="empty" style={{ padding: "0.8rem", textAlign: "center" }}>
                No barriers match the selected filter.
              </p>
            ) : (
              filteredAuditItems.map((item) => (
                <article
                  key={item.id}
                  className={`audit-item-card audit-item-${item.severity}`}
                  aria-label={`${item.severityLabel} severity: ${item.typeLabel}`}
                >
                  <div className="audit-item-top">
                    <span className={`audit-badge-sev audit-badge-sev-${item.severity}`}>
                      {item.severityLabel}
                    </span>
                    <span className="audit-badge-type">{item.typeLabel}</span>
                    <span className="audit-item-el" title={`PageGuide ID: ${item.elementId}`}>
                      {item.tagName} <code>[{item.elementId}]</code>
                    </span>
                    <span className="audit-badge-wcag">{item.wcagCriterion.split("-")[1]?.trim() || "WCAG A"}</span>
                  </div>

                  <p className="audit-item-summary">
                    <strong>Issue:</strong> {item.summary}
                  </p>

                  <p className="audit-item-impact">
                    <strong>Blind / Low-Vision Impact:</strong> {item.userImpact}
                  </p>

                  <div className="audit-item-evidence">
                    <span className="audit-evidence-heading">Technical Evidence:</span>
                    <ul className="audit-evidence-ul">
                      {item.evidence.map((ev, eIdx) => (
                        <li key={eIdx}>{ev}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="audit-item-footer">
                    {item.repaired && item.appliedRepair ? (
                      <span className="audit-status-repaired">
                        ✓ <strong>Repaired in DOM:</strong> <code>{item.appliedRepair.attribute}=&quot;{item.appliedRepair.newValue}&quot;</code> ({item.appliedRepair.confidence}%, {item.appliedRepair.source})
                      </span>
                    ) : (
                      <span className="audit-status-unrepaired">
                        ⚠️ <strong>Unrepaired Barrier:</strong> Requires developer remediation or manual inspection
                      </span>
                    )}

                    <button
                      type="button"
                      className="btn-chip"
                      onClick={() => void handleHighlightIssue(item.elementId, `${item.typeLabel} on ${item.tagName}`)}
                      title="Scroll to and focus this element on the webpage"
                      style={{ marginLeft: "auto", fontSize: "0.78rem" }}
                    >
                      🎯 Highlight on Page
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      ) : null}

      {/* Settings Modal/Section */}
      {showSettings ? (
        <section className="settings" aria-labelledby="settings-heading">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 id="settings-heading" style={{ margin: 0, fontSize: "1.05rem" }}>
              Companion Settings
            </h2>
            <button
              type="button"
              className="btn-chip"
              onClick={() => setShowSettings(false)}
              aria-label="Close settings"
            >
              ✕ Close
            </button>
          </div>

          <label htmlFor="provider-select" style={{ marginTop: "0.5rem" }}>
            Active AI Vision Provider
          </label>
          <select
            id="provider-select"
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as "openai" | "openrouter")}
          >
            <option value="openai">OpenAI (gpt-4o-mini) — Primary / Default</option>
            <option value="openrouter">OpenRouter (openai/gpt-4o-mini) — Multimodal Router</option>
          </select>

          {providerType === "openai" ? (
            <>
              <label htmlFor={keyInputId}>OpenAI API Key (Vision & Whisper Speech)</label>
              <input
                id={keyInputId}
                type="password"
                autoComplete="off"
                value={openAiKeyDraft}
                onChange={(e) => setOpenAiKeyDraft(e.target.value)}
                placeholder="sk-…"
              />
              <p className="hint">
                Stored in chrome.storage.local only. Direct connection to OpenAI API.
              </p>
            </>
          ) : (
            <>
              <label htmlFor={routerKeyInputId}>OpenRouter API Key</label>
              <input
                id={routerKeyInputId}
                type="password"
                autoComplete="off"
                value={openRouterKeyDraft}
                onChange={(e) => setOpenRouterKeyDraft(e.target.value)}
                placeholder="sk-or-v1-…"
              />
              <p className="hint">
                Stored in chrome.storage.local only. Routes completions via OpenRouter.
              </p>
            </>
          )}

          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: "0.4rem" }}
            onClick={() => {
              const trimmedOpenAi = openAiKeyDraft.trim();
              const trimmedRouter = openRouterKeyDraft.trim();
              chrome.storage.local.set(
                {
                  [STORAGE_KEY]: trimmedOpenAi,
                  [OPENROUTER_STORAGE_KEY]: trimmedRouter,
                  [PROVIDER_STORAGE_KEY]: providerType,
                },
                () => {
                  setOpenAiKey(trimmedOpenAi);
                  setOpenRouterKey(trimmedRouter);
                  setShowSettings(false);
                  announce(
                    `Settings saved. Active provider: ${
                      providerType === "openrouter" ? "OpenRouter" : "OpenAI"
                    }.`
                  );
                }
              );
            }}
          >
            Save Settings
          </button>

          {/* Under The Hood: Silent Runtime Repairs */}
          <div className="settings-under-the-hood">
            <h3 style={{ margin: "0.8rem 0 0.3rem", fontSize: "0.92rem", color: "var(--muted)" }}>
              Under The Hood: Screen Reader DOM Repairs
            </h3>
            <p className="hint" style={{ margin: "0 0 0.5rem" }}>
              PageGuide quietly adds missing names, form labels, and interactive roles to the webpage so VoiceOver, NVDA, and JAWS encounter proper semantics.
            </p>
            <div className="toggle-row" role="group" aria-label="DOM repairs toggle">
              <span className="label" style={{ fontSize: "0.85rem" }}>
                Repairs:
              </span>
              <button
                type="button"
                className={`btn toggle ${!repairsOn ? "toggle-active" : ""}`}
                aria-pressed={!repairsOn}
                onClick={() => void toggleRepairs(false)}
              >
                OFF
              </button>
              <button
                type="button"
                className={`btn toggle ${repairsOn ? "toggle-active" : ""}`}
                aria-pressed={repairsOn}
                onClick={() => void toggleRepairs(true)}
              >
                ON
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: "0.8rem", padding: "0.3rem 0.5rem", marginLeft: "auto" }}
                onClick={() => void undoAll()}
              >
                Undo All Repairs
              </button>
            </div>

            <button
              type="button"
              className="linkish"
              style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}
              onClick={() => setShowTechnicalDetails((v) => !v)}
            >
              {showTechnicalDetails ? "▾ Hide" : "▸ Show"} Developer Diagnostics ({scan ? scan.summary.repairedCount : 0} repairs applied)
            </button>

            {showTechnicalDetails && scan ? (
              <div className="debug-box" style={{ marginTop: "0.4rem" }}>
                <p style={{ margin: "0 0 0.3rem", fontSize: "0.8rem" }}>
                  <strong>{scan.summary.repairedCount}</strong> repaired / <strong>{scan.summary.issueCount}</strong> original issues
                </p>
                <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.78rem" }}>
                  {scan.appliedRepairs.map((r) => (
                    <li key={r.id}>
                      {r.elementId}: {r.attribute}=&quot;{r.newValue}&quot; ({r.source})
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-audit-action"
                  style={{ marginTop: "0.5rem", width: "100%", fontSize: "0.82rem" }}
                  onClick={() => {
                    setShowSettings(false);
                    setShowAuditModal(true);
                  }}
                >
                  📊 Open Proof of Relevance Audit Log
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Visual Highlights Section */}
      {visualHighlights.length > 0 ? (
        <section className="visual-highlights-section" aria-labelledby="visuals-heading">
          <div className="visual-highlights-header">
            <h2 id="visuals-heading" className="visual-highlights-title">
              Visual Highlights ({visualHighlights.length})
            </h2>
            <button
              type="button"
              className="btn-link"
              onClick={() => setShowVisualsList((v) => !v)}
              aria-expanded={showVisualsList}
            >
              {showVisualsList ? "Hide" : "Show"}
            </button>
          </div>

          {/* Active Visual Banner */}
          {activeImage ? (
            <div
              className="active-image-banner"
              role="region"
              aria-label="Currently exploring visual"
            >
              <div className="active-image-header">
                <span>Exploring: {getVisualLabel(activeImage, 0)}</span>
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => setActiveImageId(null)}
                  title="Clear active visual selection"
                  aria-label="Close active visual"
                >
                  ✕ Close
                </button>
              </div>
              <p className="active-image-desc">
                {activeImage.generatedQuickDescription ||
                  activeImage.alt ||
                  "Click 'Describe' to hear what's in this visual, or ask a question below."}
              </p>
              <div className="active-image-actions">
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => void handlePreviousImage()}
                  aria-label="Previous visual highlight"
                >
                  ◀ Prev
                </button>
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => void handleNextImage()}
                  aria-label="Next visual highlight"
                >
                  Next ▶
                </button>
                <button
                  type="button"
                  className="btn-chip btn-chip-primary"
                  onClick={() => void describeImage(activeImage.id, "quick")}
                  disabled={imageProcessingId === activeImage.id}
                >
                  ⚡ Describe
                </button>
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => void describeImage(activeImage.id, "detailed")}
                  disabled={imageProcessingId === activeImage.id}
                >
                  🔍 Tell Me More
                </button>
                <button
                  type="button"
                  className="btn-chip"
                  onClick={() => void focusAndSelectImage(activeImage.id)}
                >
                  🎯 Focus in Page
                </button>
              </div>
            </div>
          ) : null}

          {/* Visual Highlight Cards Carousel/List */}
          {showVisualsList && (
            <div className="visual-cards-container" role="feed" aria-label="Visual highlights on this page">
              {visualHighlights.map((img, idx) => {
                const isSelected = activeImageId === img.id;
                const isProcessing = imageProcessingId === img.id;
                const label = getVisualLabel(img, idx);

                return (
                  <article
                    key={img.id}
                    className={`visual-card ${isSelected ? "visual-card-active" : ""} ${
                      isProcessing ? "loading-pulse" : ""
                    }`}
                    aria-current={isSelected ? "true" : undefined}
                  >
                    <div className="visual-card-thumb">
                      <img
                        src={img.src}
                        alt=""
                        loading="lazy"
                        aria-hidden="true"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = "none";
                        }}
                      />
                    </div>
                    <div className="visual-card-info">
                      <h3 className="visual-card-label">{label}</h3>
                      <p className="visual-card-snippet">
                        {img.nearbyText?.slice(0, 95) || img.alt || "Visual content from page"}
                      </p>
                      <div className="visual-card-btns">
                        <button
                          type="button"
                          className="btn-chip btn-chip-primary"
                          onClick={() => {
                            void focusAndSelectImage(img.id);
                            void describeImage(img.id, "quick");
                          }}
                          disabled={isProcessing}
                        >
                          {isProcessing ? "Analyzing…" : "Explore with Companion"}
                        </button>
                        <button
                          type="button"
                          className="btn-chip"
                          onClick={() => void focusAndSelectImage(img.id)}
                        >
                          Focus
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {/* CONVERSATION SECTION (Companion Dialogue Stream) */}
      <section
        className="conversation"
        aria-labelledby="conversation-heading"
        aria-busy={busy}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 id="conversation-heading" style={{ margin: 0, fontSize: "1.05rem" }}>
            Companion Conversation
          </h2>
          {activeImageId ? (
            <span style={{ fontSize: "0.8rem", color: "var(--accent)" }}>
              Focused on visual
            </span>
          ) : null}
        </div>

        {/* Suggestion Chips */}
        <div className="quick-prompts" role="group" aria-label="Companion suggestions">
          {activeImageId ? (
            <>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void describeImage(activeImageId, "quick")}
              >
                Describe this visual
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void describeImage(activeImageId, "detailed")}
              >
                Tell me more
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void askImageQuestion(activeImageId, "What does this show?")}
              >
                What does this show?
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void askImageQuestion(activeImageId, "Read the visible text in this visual")}
              >
                Read visible text
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void performOrientation()}
              >
                🧭 Orient me
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void handleSend("What accessibility barriers were found on this page and what did PageGuide repair?")}
              >
                📊 Proof of relevance
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void handleSend("What is important on this page?")}
              >
                🌟 What's important?
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void handleSend("What actions can I take on this page?")}
              >
                📋 What can I do?
              </button>
              <button
                type="button"
                className="quick-prompt-btn"
                onClick={() => void handleSend("Are there any interactive forms or buttons here?")}
              >
                🔍 Find actions & links
              </button>
            </>
          )}
        </div>

        {/* Message Feed */}
        {messages.length === 0 ? (
          <p className="empty">
            Connecting to webpage… PageGuide will orient you in a moment.
          </p>
        ) : (
          <ul className="message-list">
            {messages.map((m) => (
              <li key={m.id} className={`message message-${m.role}`}>
                <div className="message-header">
                  <span className="speaker">
                    {m.role === "user" ? "You" : "PageGuide"}
                  </span>
                  {m.role === "assistant" ? (
                    <button
                      type="button"
                      className="btn-replay"
                      onClick={() => audio.speak(m.content)}
                      aria-label="Listen to this message"
                      title="Read aloud"
                    >
                      🔊 Listen
                    </button>
                  ) : null}
                </div>
                <p style={{ whiteSpace: "pre-wrap", margin: "0.35rem 0 0" }}>{m.content}</p>
              </li>
            ))}
          </ul>
        )}
        {busy ? <p className="thinking">PageGuide is looking at the screen…</p> : null}
      </section>

      {/* Screen Reader Live Announcement Region */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>

      {/* Composer Input */}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <div className="composer-header">
          <label htmlFor={inputId}>
            {activeImageId
              ? "Ask PageGuide about this visual"
              : "Ask PageGuide anything about this page"}
          </label>
          {voiceSupported ? (
            <button
              type="button"
              className={`btn btn-composer-mic ${isListening ? "btn-mic-active" : ""}`}
              onClick={toggleListening}
              aria-pressed={isListening}
              aria-label={
                isListening ? "Listening... Click to stop" : "Speak command (Alt+M)"
              }
              title="Speak command (Alt+M)"
            >
              {isListening ? "🔴 Listening…" : "🎤 Voice (Alt+M)"}
            </button>
          ) : null}
        </div>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={
            activeImageId
              ? "Tell me more about this photo, chart, or map…"
              : "What's on this page? Help me register. Where is the map?…"
          }
          disabled={busy}
        />
        <div className="composer-actions">
          <button
            type="submit"
            className="btn btn-primary send"
            disabled={busy || !input.trim()}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
