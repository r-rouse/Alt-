/**
 * Vision Provider Layer for PageGuide
 *
 * Provides a clean provider abstraction so image understanding is decoupled
 * from specific API request details.
 *
 * Supported providers:
 * 1. OpenAI (Default / Primary) - using gpt-4o-mini with vision
 * 2. OpenRouter (Optional) - OpenAI-compatible router supporting multimodal models
 */

import type { PageImage, ImageConversationMessage } from "../shared/images";

export interface ImageInput {
  id: string;
  src: string;
  dataUrl: string;
}

export interface ImagePageContext {
  pageTitle: string;
  pageUrl: string;
  heading?: string | null;
  caption?: string | null;
  nearbyText?: string | null;
  existingAlt?: string | null;
  width?: number;
  height?: number;
}

export interface ImageDescription {
  imageId: string;
  description: string;
  mode: "quick" | "detailed";
  provider: "openai" | "openrouter";
}

export interface ImageAnswer {
  imageId: string;
  answer: string;
  question: string;
  provider: "openai" | "openrouter";
}

export interface VisionProvider {
  readonly id: "openai" | "openrouter";
  readonly name: string;

  describeImage(
    image: ImageInput,
    context: ImagePageContext,
    mode: "quick" | "detailed"
  ): Promise<ImageDescription>;

  askImageQuestion(
    image: ImageInput,
    context: ImagePageContext,
    question: string,
    conversation?: ImageConversationMessage[]
  ): Promise<ImageAnswer>;
}

export function formatPageContext(context: ImagePageContext): string {
  const lines: string[] = [
    `PAGE TITLE: ${context.pageTitle || "(unknown)"}`,
    `PAGE URL: ${context.pageUrl || "(unknown)"}`,
  ];

  if (context.heading) {
    lines.push(`NEAREST HEADING: ${context.heading}`);
  }
  if (context.caption) {
    lines.push(`FIGURE CAPTION / ARIA: ${context.caption}`);
  }
  if (context.nearbyText) {
    lines.push(`NEARBY PARAGRAPH TEXT: ${context.nearbyText}`);
  }
  if (context.existingAlt && context.existingAlt.trim()) {
    lines.push(`AUTHOR-PROVIDED ALT TEXT: "${context.existingAlt}"`);
  }
  if (context.width && context.height) {
    lines.push(`DISPLAY DIMENSIONS: ${context.width}x${context.height}px`);
  }

  return lines.join("\n");
}

export function pageImageToContext(image: PageImage): ImagePageContext {
  return {
    pageTitle: image.pageTitle,
    pageUrl: image.pageUrl,
    heading: image.heading,
    caption: image.caption,
    nearbyText: image.nearbyText,
    existingAlt: image.alt,
    width: image.width,
    height: image.height,
  };
}

export const VISION_SYSTEM_PROMPT = `You are PageGuide Vision, an AI accessibility agent that helps blind and low-vision users understand and explore images on webpages.

Your primary mission is to make visual information accessible, interactive, and conversational.

## Core Principles
1. Context-Aware: Explain what the image conveys IN THE CONTEXT OF THIS WEBPAGE. An image of a bicycle in a municipal transit report is about bike lane infrastructure; in a shop, it is about bike specs and components.
2. Honest & Conservative: If text or details are blurry, small, or ambiguous, state "appears to be...", "seems to show...", or "the label is difficult to read, but looks like...". Never invent numbers or facts.
3. Concise & Screen-Reader Friendly: Avoid visual coordinate jargon ("top-left pixel"). Use natural spatial references ("in the foreground", "along the eastern border", "on the horizontal axis").
4. Charts & Data Visualizations:
   - State chart type (bar chart, line chart, scatter plot, etc.).
   - State title, axes, and units.
   - Describe the overall trend (growth, decline, plateau).
   - Point out peaks, lows, and notable comparisons.
   - Use "approximately" for interpolated numerical values.
5. Maps & Diagrams:
   - Identify geographic region.
   - Highlighted zones, routes, legend categories, and landmarks.
6. Text in Images:
   - Read visible signage, banners, headings, or labels accurately.`;

/**
 * 1. OpenAI Vision Provider (Primary / Default)
 */
export class OpenAIVisionProvider implements VisionProvider {
  public readonly id = "openai" as const;
  public readonly name = "OpenAI (gpt-4o-mini)";
  private readonly endpoint = "https://api.openai.com/v1/chat/completions";
  private readonly model = "gpt-4o-mini";

  constructor(private apiKey: string) {}

  public setApiKey(key: string): void {
    this.apiKey = key;
  }

  public async describeImage(
    image: ImageInput,
    context: ImagePageContext,
    mode: "quick" | "detailed"
  ): Promise<ImageDescription> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is missing. Please save your API key in PageGuide Settings.");
    }

    const contextStr = formatPageContext(context);
    const prompt =
      mode === "quick"
        ? `Generate a CONCISE, HIGH-VALUE 1 to 2 sentence description of this image suitable as screen-reader alt text for a blind user.
Focus on the primary subject and why it matters in this context. Be direct, vivid, and omit fluff like "This is an image of".

PAGE CONTEXT:
${contextStr}`
        : `Provide a DETAILED, rich accessibility description of this image for a blind user exploring this webpage.
Explain:
1. What the image shows overall and its purpose in the article/page.
2. Key subjects, layout, and notable visual elements (foreground, background).
3. If this is a chart or map: explain types, axes, trends, regions, categories, and significant values.
4. Any visible text or signage.

PAGE CONTEXT:
${contextStr}`;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: mode === "quick" ? 180 : 500,
        temperature: 0.2,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: image.dataUrl,
                  detail: mode === "quick" ? "low" : "high",
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI Vision error (${res.status}): ${err.slice(0, 150)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("OpenAI returned an empty description.");
    }

    return {
      imageId: image.id,
      description: reply,
      mode,
      provider: "openai",
    };
  }

  public async askImageQuestion(
    image: ImageInput,
    context: ImagePageContext,
    question: string,
    conversation: ImageConversationMessage[] = []
  ): Promise<ImageAnswer> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is missing. Please save your API key in PageGuide Settings.");
    }

    const contextStr = formatPageContext(context);
    const messages: any[] = [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are answering questions from a blind user about this specific image on the webpage.
PAGE CONTEXT:
${contextStr}`,
          },
          {
            type: "image_url",
            image_url: {
              url: image.dataUrl,
              detail: "high",
            },
          },
        ],
      },
    ];

    for (const turn of conversation.slice(-6)) {
      messages.push({
        role: turn.role,
        content: turn.content,
      });
    }

    messages.push({
      role: "user",
      content: question,
    });

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 450,
        temperature: 0.3,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI Vision error (${res.status}): ${err.slice(0, 150)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("OpenAI returned an empty answer.");
    }

    return {
      imageId: image.id,
      answer: reply,
      question,
      provider: "openai",
    };
  }
}

/**
 * 2. OpenRouter Vision Provider (Optional Provider)
 */
export class OpenRouterVisionProvider implements VisionProvider {
  public readonly id = "openrouter" as const;
  public readonly name = "OpenRouter (openai/gpt-4o-mini)";
  private readonly endpoint = "https://openrouter.ai/api/v1/chat/completions";
  private readonly model: string;

  constructor(private apiKey: string, model = "openai/gpt-4o-mini") {
    this.model = model;
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
  }

  public async describeImage(
    image: ImageInput,
    context: ImagePageContext,
    mode: "quick" | "detailed"
  ): Promise<ImageDescription> {
    if (!this.apiKey) {
      throw new Error("OpenRouter API key is missing. Please save your API key in PageGuide Settings.");
    }

    const contextStr = formatPageContext(context);
    const prompt =
      mode === "quick"
        ? `Generate a CONCISE, HIGH-VALUE 1 to 2 sentence description of this image suitable as screen-reader alt text for a blind user.
Focus on the primary subject and why it matters in this context. Be direct, vivid, and omit fluff like "This is an image of".

PAGE CONTEXT:
${contextStr}`
        : `Provide a DETAILED, rich accessibility description of this image for a blind user exploring this webpage.
Explain:
1. What the image shows overall and its purpose in the article/page.
2. Key subjects, layout, and notable visual elements (foreground, background).
3. If this is a chart or map: explain types, axes, trends, regions, categories, and significant values.
4. Any visible text or signage.

PAGE CONTEXT:
${contextStr}`;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/pageguide/pageguide",
        "X-Title": "PageGuide Accessibility Agent",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: mode === "quick" ? 180 : 500,
        temperature: 0.2,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: image.dataUrl,
                  detail: mode === "quick" ? "low" : "high",
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter Vision error (${res.status}): ${err.slice(0, 150)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("OpenRouter returned an empty description.");
    }

    return {
      imageId: image.id,
      description: reply,
      mode,
      provider: "openrouter",
    };
  }

  public async askImageQuestion(
    image: ImageInput,
    context: ImagePageContext,
    question: string,
    conversation: ImageConversationMessage[] = []
  ): Promise<ImageAnswer> {
    if (!this.apiKey) {
      throw new Error("OpenRouter API key is missing. Please save your API key in PageGuide Settings.");
    }

    const contextStr = formatPageContext(context);
    const messages: any[] = [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are answering questions from a blind user about this specific image on the webpage.
PAGE CONTEXT:
${contextStr}`,
          },
          {
            type: "image_url",
            image_url: {
              url: image.dataUrl,
              detail: "high",
            },
          },
        ],
      },
    ];

    for (const turn of conversation.slice(-6)) {
      messages.push({
        role: turn.role,
        content: turn.content,
      });
    }

    messages.push({
      role: "user",
      content: question,
    });

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/pageguide/pageguide",
        "X-Title": "PageGuide Accessibility Agent",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 450,
        temperature: 0.3,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter Vision error (${res.status}): ${err.slice(0, 150)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("OpenRouter returned an empty answer.");
    }

    return {
      imageId: image.id,
      answer: reply,
      question,
      provider: "openrouter",
    };
  }
}

/**
 * 3. Central Vision Service
 *
 * All PageGuide components and agents call this single service
 * rather than interacting directly with OpenAI or OpenRouter.
 */
export class VisionService {
  constructor(private provider: VisionProvider) {}

  public getProvider(): VisionProvider {
    return this.provider;
  }

  public setProvider(provider: VisionProvider): void {
    this.provider = provider;
  }

  public async describeImage(
    image: ImageInput,
    context: ImagePageContext,
    mode: "quick" | "detailed" = "quick"
  ): Promise<ImageDescription> {
    return this.provider.describeImage(image, context, mode);
  }

  public async askImageQuestion(
    image: ImageInput,
    context: ImagePageContext,
    question: string,
    conversation: ImageConversationMessage[] = []
  ): Promise<ImageAnswer> {
    return this.provider.askImageQuestion(image, context, question, conversation);
  }
}

/**
 * Factory helper for VisionService with defaults
 */
export function createVisionService(options: {
  providerType?: "openai" | "openrouter";
  openAiKey?: string;
  openRouterKey?: string;
}): VisionService {
  const providerType = options.providerType || "openai";

  if (providerType === "openrouter" && options.openRouterKey) {
    return new VisionService(new OpenRouterVisionProvider(options.openRouterKey));
  }

  return new VisionService(new OpenAIVisionProvider(options.openAiKey || ""));
}
