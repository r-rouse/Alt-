/**
 * PageGuide Image Scanner & Registry
 *
 * Discovers images, extracts surrounding semantic context, classifies accessibility,
 * extracts image data for Vision AI, and performs reversible DOM augmentations.
 */

import type {
  PageImage,
  ImageAccessibilityStatus,
  ImageAccessibilityRepair,
  ImageScanSummary,
} from "../shared/images";
import { elementRegistry } from "./elementRegistry";
import { recordAppliedRepair } from "./repairEngine";

interface ImageRecord {
  id: string;
  element: HTMLImageElement;
  originalAlt: string | null;
  originalAriaLabel: string | null;
  pageImage: PageImage;
  repairedRecord?: ImageAccessibilityRepair;
}

class ImageRegistry {
  private map = new Map<string, ImageRecord>();
  private nextId = 1;
  private activeId: string | null = null;
  private listenersAttached = false;

  public clear(): void {
    this.map.clear();
    this.nextId = 1;
  }

  public register(el: HTMLImageElement, pageImage: PageImage): string {
    const id = pageImage.id || `pg-img-${this.nextId++}`;
    pageImage.id = id;

    const originalAlt = el.hasAttribute("alt") ? el.getAttribute("alt") : null;
    const originalAriaLabel = el.hasAttribute("aria-label")
      ? el.getAttribute("aria-label")
      : null;

    this.map.set(id, {
      id,
      element: el,
      originalAlt,
      originalAriaLabel,
      pageImage,
    });

    el.dataset.pageguideImgId = id;
    elementRegistry.registerWithId(el, id);

    // Attach focus listener so VoiceOver/keyboard navigation automatically updates active image
    this.ensureFocusListener(el, id);

    return id;
  }

  public get(id: string): ImageRecord | undefined {
    return this.map.get(id);
  }

  public getActiveId(): string | null {
    if (this.activeId && this.map.has(this.activeId)) {
      return this.activeId;
    }
    // Default to first meaningful image if available
    for (const [id, record] of this.map.entries()) {
      if (record.pageImage.accessibilityStatus !== "decorative") {
        return id;
      }
    }
    const first = this.map.keys().next().value;
    return first ?? null;
  }

  public setActiveId(id: string): void {
    if (this.map.has(id)) {
      this.activeId = id;
    }
  }

  public getAllImages(): PageImage[] {
    return Array.from(this.map.values()).map((r) => r.pageImage);
  }

  private ensureFocusListener(el: HTMLImageElement, id: string): void {
    el.addEventListener("focus", () => {
      this.activeId = id;
    });
  }
}

export const imageRegistry = new ImageRegistry();

const POOR_ALT_REGEX =
  /^(image|photo|picture|graphic|img|chart|map|icon|screenshot|figure|drawing|illustration|placeholder|banner|logo|untitled|dsc_\d+|img_\d+|screenshot_\d+)$/i;

function clean(str: string | null | undefined, max = 200): string {
  if (!str) return "";
  return str.replace(/\s+/g, " ").trim().slice(0, max);
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  return true;
}

function findNearbyHeading(el: HTMLElement): string | null {
  // Check preceding headings in DOM
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 6 && cur; i++) {
    let prev = cur.previousElementSibling;
    while (prev) {
      if (prev instanceof HTMLElement) {
        if (/^H[1-6]$/.test(prev.tagName)) return clean(prev.textContent, 80);
        const childH = prev.querySelector("h1, h2, h3, h4, h5, h6");
        if (childH) return clean(childH.textContent, 80);
      }
      prev = prev.previousElementSibling;
    }
    cur = cur.parentElement;
  }

  // Check wrapping section / figure / article heading
  const container = el.closest("figure, article, section, [role='region'], main");
  const heading = container?.querySelector("h1, h2, h3, h4, h5, h6");
  return heading ? clean(heading.textContent, 80) : null;
}

function findCaption(el: HTMLElement): string | null {
  const figure = el.closest("figure");
  if (figure) {
    const figcaption = figure.querySelector("figcaption");
    if (figcaption) return clean(figcaption.textContent, 120);
  }
  const ariaDesc = el.getAttribute("aria-describedby");
  if (ariaDesc) {
    const descEl = document.getElementById(ariaDesc);
    if (descEl) return clean(descEl.textContent, 120);
  }
  return null;
}

function findNearbyText(el: HTMLElement): string {
  const parent = el.parentElement;
  if (!parent) return "";
  const parts: string[] = [];

  for (const node of Array.from(parent.childNodes)) {
    if (node === el) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clean(node.textContent, 80);
      if (t) parts.push(t);
    } else if (node instanceof HTMLElement && !node.contains(el)) {
      const t = clean(node.innerText, 80);
      if (t) parts.push(t);
    }
  }

  // Sibling paragraph
  let next = el.nextElementSibling;
  if (next instanceof HTMLElement && next.tagName === "P") {
    parts.push(clean(next.textContent, 80));
  }
  let prev = el.previousElementSibling;
  if (prev instanceof HTMLElement && prev.tagName === "P") {
    parts.push(clean(prev.textContent, 80));
  }

  return parts.join(" — ").slice(0, 180);
}

function classifyImage(
  el: HTMLImageElement,
  alt: string | null,
  ariaLabel: string | null,
  width: number,
  height: number
): { status: ImageAccessibilityStatus; reason: string } {
  // Check decorative attributes
  const role = el.getAttribute("role");
  if (role === "presentation" || role === "none" || el.getAttribute("aria-hidden") === "true") {
    return { status: "decorative", reason: "Marked with role='presentation' or aria-hidden" };
  }

  // Empty alt: alt=""
  if (alt === "") {
    // If tiny icon or no nearby content, it's decorative
    if (width < 64 && height < 64) {
      return { status: "decorative", reason: "Empty alt attribute (alt='') on small graphic" };
    }
    // Empty alt on a large image might be intentional or an oversight
    return { status: "decorative", reason: "Author set alt='' (indicates decorative element)" };
  }

  // Missing alt: no alt attribute and no aria-label
  if (alt === null && !ariaLabel) {
    return { status: "missing", reason: "Missing alt attribute and aria-label" };
  }

  const textToCheck = (ariaLabel || alt || "").trim();

  // Obviously poor alt text
  if (POOR_ALT_REGEX.test(textToCheck) || textToCheck.length < 5) {
    return { status: "poor", reason: `Inadequate generic label: "${textToCheck}"` };
  }

  // Filename as alt text
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(textToCheck)) {
    return { status: "poor", reason: `Filename used as alt text: "${textToCheck}"` };
  }

  return { status: "good", reason: `Descriptive text provided: "${textToCheck.slice(0, 50)}"` };
}

/**
 * Scan all images on the webpage and build PageImage records.
 */
export function scanPageImages(): {
  images: PageImage[];
  summary: ImageScanSummary;
  activeImageId: string | null;
} {
  imageRegistry.clear();
  const rawImages = Array.from(document.querySelectorAll("img"));
  let nextSeq = 1;

  for (const img of rawImages) {
    // Ignore invisible images
    if (!isVisible(img)) continue;

    const rect = img.getBoundingClientRect();
    const width = Math.round(img.naturalWidth || rect.width || img.width || 0);
    const height = Math.round(img.naturalHeight || rect.height || img.height || 0);

    // Skip tracking pixels (1x1 or 2x2)
    if (width > 0 && height > 0 && width <= 3 && height <= 3) {
      continue;
    }

    const src = img.src || img.getAttribute("src") || "";
    if (!src) continue;

    const alt = img.hasAttribute("alt") ? img.getAttribute("alt") : null;
    const ariaLabel = img.getAttribute("aria-label");

    const { status, reason } = classifyImage(img, alt, ariaLabel, width, height);

    const pageImage: PageImage = {
      id: `pg-img-${nextSeq++}`,
      src,
      alt,
      ariaLabel,
      width,
      height,
      nearbyText: findNearbyText(img),
      heading: findNearbyHeading(img),
      caption: findCaption(img),
      pageTitle: document.title || "(untitled)",
      pageUrl: location.href,
      accessibilityStatus: status,
      statusReason: reason,
      screenReaderAugmented: img.dataset.pageguideAugmented === "true",
    };

    imageRegistry.register(img, pageImage);
  }

  const images = imageRegistry.getAllImages();
  const summary: ImageScanSummary = {
    total: images.length,
    goodCount: images.filter((i) => i.accessibilityStatus === "good").length,
    missingCount: images.filter((i) => i.accessibilityStatus === "missing").length,
    poorCount: images.filter((i) => i.accessibilityStatus === "poor").length,
    decorativeCount: images.filter((i) => i.accessibilityStatus === "decorative").length,
    augmentedCount: images.filter((i) => i.screenReaderAugmented).length,
  };

  return {
    images,
    summary,
    activeImageId: imageRegistry.getActiveId(),
  };
}

/**
 * Extract image as a base64 Data URL (suitable for OpenAI Vision API).
 * Uses canvas extraction if possible, or background proxy if tainted by CORS.
 */
export async function extractImageDataUrl(imageId: string): Promise<string> {
  const record = imageRegistry.get(imageId);
  if (!record) {
    throw new Error(`Image ${imageId} is no longer on the page.`);
  }

  const img = record.element;

  // 1. Direct Data URL in src
  if (img.src && img.src.startsWith("data:image/")) {
    return img.src;
  }

  // 2. Offscreen Canvas Draw
  if (img.complete && img.naturalWidth > 0) {
    try {
      const canvas = document.createElement("canvas");
      const maxDim = 1024;
      let w = img.naturalWidth;
      let h = img.naturalHeight;

      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        if (dataUrl && dataUrl.length > 100) {
          return dataUrl;
        }
      }
    } catch {
      // Canvas tainted by CORS -> fallback to background fetch
    }
  }

  // 3. Fallback: Ask background script to fetch image (bypasses CORS using host_permissions)
  try {
    const res = await chrome.runtime.sendMessage({
      type: "FETCH_IMAGE_BLOB",
      url: img.src,
    });
    if (res?.ok && res.data?.dataUrl) {
      return res.data.dataUrl;
    }
  } catch (err) {
    console.warn("Background image fetch failed:", err);
  }

  // If external URL is a direct web link, return the URL itself for Vision API
  if (img.src.startsWith("http://") || img.src.startsWith("https://")) {
    return img.src;
  }

  throw new Error("Unable to capture image pixels for this image.");
}

/**
 * Augment the image in the live DOM so screen readers announce the description.
 */
export function augmentImage(
  imageId: string,
  description: string
): ImageAccessibilityRepair {
  const record = imageRegistry.get(imageId);
  if (!record) {
    throw new Error(`Image ${imageId} not found.`);
  }

  const el = record.element;

  // Make sure image can receive keyboard focus if desired
  if (el.tabIndex < 0) {
    el.tabIndex = 0;
  }

  // Apply rich accessible label with PageGuide marker
  const labelWithMarker = `${description} (PageGuide description available)`;
  el.setAttribute("aria-label", labelWithMarker);
  el.setAttribute("alt", description);
  el.dataset.pageguideAugmented = "true";

  const repairRecord: ImageAccessibilityRepair = {
    imageId,
    originalAlt: record.originalAlt,
    originalAriaLabel: record.originalAriaLabel,
    generatedDescription: description,
    appliedAt: Date.now(),
  };

  record.repairedRecord = repairRecord;
  record.pageImage.screenReaderAugmented = true;
  record.pageImage.generatedQuickDescription = description;

  recordAppliedRepair({
    id: `repair-img-${imageId}`,
    issueId: `issue-${imageId}`,
    elementId: imageId,
    attribute: "aria-label",
    previousValue: record.originalAriaLabel,
    newValue: labelWithMarker,
    confidence: 0.95,
    reason: "Vision AI contextual description",
    source: "ai-inferred",
  });

  return repairRecord;
}

/**
 * Restore original attributes on the image.
 */
export function restoreImage(imageId: string): boolean {
  const record = imageRegistry.get(imageId);
  if (!record) return false;

  const el = record.element;
  if (record.originalAlt === null) {
    el.removeAttribute("alt");
  } else {
    el.setAttribute("alt", record.originalAlt);
  }

  if (record.originalAriaLabel === null) {
    el.removeAttribute("aria-label");
  } else {
    el.setAttribute("aria-label", record.originalAriaLabel);
  }

  delete el.dataset.pageguideAugmented;
  record.pageImage.screenReaderAugmented = false;
  record.repairedRecord = undefined;
  return true;
}

/**
 * Move focus & scroll to image on webpage.
 */
export function focusImageElement(imageId: string): boolean {
  const record = imageRegistry.get(imageId);
  if (!record) return false;

  const el = record.element;
  if (el.tabIndex < 0) {
    el.tabIndex = -1;
  }

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus({ preventScroll: true });

  // Add high-contrast visual outline
  const prevOutline = el.style.outline;
  el.style.outline = "4px solid #3d9cfd";
  el.style.outlineOffset = "3px";
  window.setTimeout(() => {
    el.style.outline = prevOutline;
  }, 2800);

  imageRegistry.setActiveId(imageId);
  return true;
}
