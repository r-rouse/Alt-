/**
 * PageGuide Agent ↔ UI Bridge (AG-UI Architecture)
 *
 * Serves as the lightweight agent-to-application bridge connecting:
 * - Chrome webpage DOM & image registry
 * - Shared PageGuide Agent State (reactive state with activeImageId)
 * - Constrained Frontend Agent Tools
 * - Central VisionService (OpenAI default / OpenRouter optional)
 *
 * NOTE ON COPILOTKIT EVALUATION:
 * CopilotKit's standard packages (@copilotkit/react-core / runtime) require an external
 * Node/Next server runtime (CopilotRuntime) to stream agent completions, which introduces
 * unnecessary external backend servers into a standalone Chrome extension (Manifest V3).
 * Following the architectural guidelines ("Keep this architecture lightweight. Do NOT introduce
 * unnecessary servers..."), this AG-UI bridge implements the exact agent ↔ application bridge
 * pattern natively in the extension without bloated server requirements.
 */

import type { PageImage, ImageConversationMessage, ImageScanSummary } from "../shared/images";
import type { ExtensionMessage, ExtensionResponse } from "../shared/messages";
import {
  VisionService,
  createVisionService,
  pageImageToContext,
  type ImageDescription,
  type ImageAnswer,
} from "./visionProvider";

export interface PageGuideAgentState {
  page: {
    title: string;
    url: string;
  };
  images: PageImage[];
  activeImageId: string | null;
  inaccessibleImageCount: number;
  currentDescription?: string;
  repairsEnabled: boolean;
}

export interface FrontendAgentTools {
  getPageContext(): {
    title: string;
    url: string;
    inaccessibleImages: number;
    repairsEnabled: boolean;
    activeImageId: string | null;
    totalImages: number;
  };
  getImages(): PageImage[];
  getActiveImage(): PageImage | null;
  setActiveImage(imageId: string): PageImage | null;
  focusImage(imageId: string): Promise<boolean>;
  describeImage(imageId: string, mode: "quick" | "detailed"): Promise<string>;
  askImageQuestion(imageId: string, question: string): Promise<string>;
  applyImageDescription(imageId: string, description?: string): Promise<boolean>;
  nextImage(): Promise<PageImage | null>;
  previousImage(): Promise<PageImage | null>;
}

export type StateChangeListener = (state: PageGuideAgentState) => void;

export class PageGuideAgentBridge implements FrontendAgentTools {
  private state: PageGuideAgentState = {
    page: { title: "(not connected)", url: "" },
    images: [],
    activeImageId: null,
    inaccessibleImageCount: 0,
    currentDescription: undefined,
    repairsEnabled: true,
  };

  private listeners = new Set<StateChangeListener>();
  private imageDataCache = new Map<string, string>();
  private conversationHistory = new Map<string, ImageConversationMessage[]>();

  constructor(
    private sendToPage: (message: ExtensionMessage) => Promise<ExtensionResponse>,
    private visionService: VisionService
  ) {}

  public getState(): PageGuideAgentState {
    return { ...this.state, images: [...this.state.images] };
  }

  public subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const s = this.getState();
    this.listeners.forEach((fn) => fn(s));
  }

  public updatePageInfo(title: string, url: string, repairsEnabled?: boolean): void {
    this.state.page = { title, url };
    if (typeof repairsEnabled === "boolean") {
      this.state.repairsEnabled = repairsEnabled;
    }
    this.notify();
  }

  public setImages(images: PageImage[], activeId?: string | null): void {
    this.state.images = images;
    this.state.inaccessibleImageCount = images.filter(
      (img) => img.accessibilityStatus === "missing" || img.accessibilityStatus === "poor"
    ).length;

    if (activeId !== undefined) {
      this.state.activeImageId = activeId;
    } else if (!this.state.activeImageId || !images.some((i) => i.id === this.state.activeImageId)) {
      // Pick first non-decorative image as default active
      const first = images.find((i) => i.accessibilityStatus !== "decorative") || images[0];
      this.state.activeImageId = first?.id || null;
    }

    const active = this.getActiveImage();
    this.state.currentDescription =
      active?.generatedQuickDescription || active?.alt || undefined;

    this.notify();
  }

  public setVisionService(service: VisionService): void {
    this.visionService = service;
  }

  public getVisionService(): VisionService {
    return this.visionService;
  }

  // -------------------------------------------------------------
  // Frontend Agent Tools Implementation
  // -------------------------------------------------------------

  public getPageContext() {
    return {
      title: this.state.page.title,
      url: this.state.page.url,
      inaccessibleImages: this.state.inaccessibleImageCount,
      repairsEnabled: this.state.repairsEnabled,
      activeImageId: this.state.activeImageId,
      totalImages: this.state.images.length,
    };
  }

  public getImages(): PageImage[] {
    return [...this.state.images];
  }

  public getActiveImage(): PageImage | null {
    if (!this.state.activeImageId) return null;
    return this.state.images.find((i) => i.id === this.state.activeImageId) || null;
  }

  public setActiveImage(imageId: string): PageImage | null {
    const target = this.state.images.find((i) => i.id === imageId);
    if (!target) return null;

    this.state.activeImageId = imageId;
    this.state.currentDescription =
      target.generatedQuickDescription || target.alt || undefined;
    this.notify();
    return target;
  }

  public async focusImage(imageId: string): Promise<boolean> {
    this.setActiveImage(imageId);
    const res = await this.sendToPage({ type: "FOCUS_IMAGE", imageId });
    return Boolean(res.ok);
  }

  public async nextImage(): Promise<PageImage | null> {
    if (this.state.images.length === 0) return null;
    const currentIdx = this.state.images.findIndex(
      (i) => i.id === this.state.activeImageId
    );
    const nextIdx = (currentIdx + 1) % this.state.images.length;
    const next = this.state.images[nextIdx];
    await this.focusImage(next.id);
    return next;
  }

  public async previousImage(): Promise<PageImage | null> {
    if (this.state.images.length === 0) return null;
    const currentIdx = this.state.images.findIndex(
      (i) => i.id === this.state.activeImageId
    );
    const prevIdx =
      currentIdx <= 0 ? this.state.images.length - 1 : currentIdx - 1;
    const prev = this.state.images[prevIdx];
    await this.focusImage(prev.id);
    return prev;
  }

  public async getImageDataUrl(imageId: string): Promise<string> {
    if (this.imageDataCache.has(imageId)) {
      return this.imageDataCache.get(imageId)!;
    }
    const res = await this.sendToPage({ type: "GET_IMAGE_DATA", imageId });
    if (!res.ok) {
      throw new Error(res.error || `Failed to extract image data for ${imageId}`);
    }
    const dataUrl = (res.data as { imageDataUrl: string }).imageDataUrl;
    this.imageDataCache.set(imageId, dataUrl);
    return dataUrl;
  }

  public async describeImage(
    imageId: string,
    mode: "quick" | "detailed" = "quick"
  ): Promise<string> {
    const img = this.state.images.find((i) => i.id === imageId);
    if (!img) {
      throw new Error(`Image ${imageId} not found.`);
    }

    this.setActiveImage(imageId);
    const dataUrl = await this.getImageDataUrl(imageId);
    const context = pageImageToContext(img);

    const desc: ImageDescription = await this.visionService.describeImage(
      { id: img.id, src: img.src, dataUrl },
      context,
      mode
    );

    // If quick mode, automatically augment the live DOM for screen readers
    if (mode === "quick") {
      await this.applyImageDescription(imageId, desc.description);
    }

    // Update in-memory state
    img.generatedQuickDescription =
      mode === "quick" ? desc.description : img.generatedQuickDescription;
    img.generatedDetailedDescription =
      mode === "detailed" ? desc.description : img.generatedDetailedDescription;
    this.state.currentDescription = desc.description;
    this.notify();

    return desc.description;
  }

  public async askImageQuestion(
    imageId: string,
    question: string
  ): Promise<string> {
    const img = this.state.images.find((i) => i.id === imageId);
    if (!img) {
      throw new Error(`Image ${imageId} not found.`);
    }

    this.setActiveImage(imageId);
    const dataUrl = await this.getImageDataUrl(imageId);
    const context = pageImageToContext(img);

    const history = this.conversationHistory.get(imageId) || [];

    const answer: ImageAnswer = await this.visionService.askImageQuestion(
      { id: img.id, src: img.src, dataUrl },
      context,
      question,
      history
    );

    this.conversationHistory.set(imageId, [
      ...history,
      { role: "user", content: question },
      { role: "assistant", content: answer.answer },
    ]);

    return answer.answer;
  }

  public async applyImageDescription(
    imageId: string,
    description?: string
  ): Promise<boolean> {
    const img = this.state.images.find((i) => i.id === imageId);
    if (!img) return false;

    const descToApply =
      description ||
      img.generatedQuickDescription ||
      img.generatedDetailedDescription;

    if (!descToApply) {
      throw new Error("No description available to apply for this image.");
    }

    const res = await this.sendToPage({
      type: "AUGMENT_IMAGE_ACCESSIBILITY",
      imageId,
      description: descToApply,
    });

    if (res.ok) {
      img.screenReaderAugmented = true;
      img.generatedQuickDescription = descToApply;
      this.notify();
      return true;
    }
    return false;
  }
}
