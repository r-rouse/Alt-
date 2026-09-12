/**
 * PageGuide Vision Agent Facade
 *
 * Re-exports the central VisionService and provides backward-compatible helper functions
 * powered by the VisionProvider layer (OpenAI default / OpenRouter optional).
 */

import type { PageImage, ImageConversationMessage } from "../shared/images";
import {
  OpenAIVisionProvider,
  OpenRouterVisionProvider,
  VisionService,
  pageImageToContext,
  createVisionService,
} from "./visionProvider";

export * from "./visionProvider";

// Global default service instance
let globalVisionService: VisionService = new VisionService(
  new OpenAIVisionProvider("")
);

export function getGlobalVisionService(): VisionService {
  return globalVisionService;
}

export function configureVisionService(options: {
  providerType?: "openai" | "openrouter";
  openAiKey?: string;
  openRouterKey?: string;
}): VisionService {
  globalVisionService = createVisionService(options);
  return globalVisionService;
}

export async function describeImageWithVision(options: {
  apiKey: string;
  image: PageImage;
  imageDataUrl: string;
  mode: "quick" | "detailed";
  providerType?: "openai" | "openrouter";
}): Promise<string> {
  const { apiKey, image, imageDataUrl, mode, providerType = "openai" } = options;

  const provider =
    providerType === "openrouter"
      ? new OpenRouterVisionProvider(apiKey)
      : new OpenAIVisionProvider(apiKey);

  const service = new VisionService(provider);
  const context = pageImageToContext(image);

  const result = await service.describeImage(
    { id: image.id, src: image.src, dataUrl: imageDataUrl },
    context,
    mode
  );

  return result.description;
}

export async function askImageQuestionWithVision(options: {
  apiKey: string;
  image: PageImage;
  imageDataUrl: string;
  question: string;
  history?: ImageConversationMessage[];
  providerType?: "openai" | "openrouter";
}): Promise<string> {
  const {
    apiKey,
    image,
    imageDataUrl,
    question,
    history = [],
    providerType = "openai",
  } = options;

  const provider =
    providerType === "openrouter"
      ? new OpenRouterVisionProvider(apiKey)
      : new OpenAIVisionProvider(apiKey);

  const service = new VisionService(provider);
  const context = pageImageToContext(image);

  const result = await service.askImageQuestion(
    { id: image.id, src: image.src, dataUrl: imageDataUrl },
    context,
    question,
    history
  );

  return result.answer;
}
