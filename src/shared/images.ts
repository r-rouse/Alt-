/**
 * Shared domain types for PageGuide's Conversational Image Accessibility layer.
 */

export type ImageAccessibilityStatus =
  | "good"
  | "missing"
  | "poor"
  | "decorative"
  | "unknown";

export interface PageImage {
  id: string; // e.g. "pg-img-1"
  src: string;
  alt: string | null;
  ariaLabel: string | null;
  width: number;
  height: number;
  nearbyText: string;
  heading: string | null;
  caption: string | null;
  pageTitle: string;
  pageUrl: string;
  accessibilityStatus: ImageAccessibilityStatus;
  statusReason?: string;
  imageDataUrl?: string; // base64 Data URL for Vision API
  generatedQuickDescription?: string;
  generatedDetailedDescription?: string;
  screenReaderAugmented?: boolean;
}

export interface ImageConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ImageAccessibilityRepair {
  imageId: string;
  originalAlt: string | null;
  originalAriaLabel: string | null;
  generatedDescription: string;
  appliedAt: number;
}

export interface ImageScanSummary {
  total: number;
  goodCount: number;
  missingCount: number;
  poorCount: number;
  decorativeCount: number;
  augmentedCount: number;
}
