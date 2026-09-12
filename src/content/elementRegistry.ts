/**
 * Stable Element Registry for PageGuide
 *
 * Maps stable PageGuide IDs (pg-1, pg-2, ...) to live DOM elements and their
 * serializable semantic representations.
 *
 * Key guarantees:
 * 1. Element IDs remain stable across re-parses during the page session.
 * 2. Elements already in the DOM keep their assigned IDs.
 * 3. Does NOT send raw HTMLElement instances to the LLM; provides clean
 *    serializable semantic element summaries.
 * 4. Resilient recovery via Map lookup + DOM [data-pageguide-id] fallback.
 */

export type ElementType =
  | "link"
  | "button"
  | "input"
  | "select"
  | "checkbox"
  | "radio"
  | "image"
  | "heading"
  | "section"
  | "other";

export interface PageGuideElement {
  id: string;
  element: HTMLElement;
  type: ElementType;
  accessibleName: string;
  text: string;
  href?: string;
  role?: string;
  nearbyHeading?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  visible: boolean;
}

export type SemanticElementInfo = Omit<PageGuideElement, "element">;

export class ElementRegistry {
  private map = new Map<string, PageGuideElement>();
  private elementToId = new WeakMap<HTMLElement, string>();
  private nextId = 1;

  /**
   * Soft clear: prunes stale elements removed from DOM while preserving
   * existing active IDs and nextId sequence counter.
   */
  clear(): void {
    for (const [id, record] of this.map.entries()) {
      if (!document.contains(record.element)) {
        this.map.delete(id);
      }
    }
  }

  /**
   * Hard reset (used on cross-page navigation or unload).
   */
  hardClear(): void {
    this.map.clear();
    this.nextId = 1;
  }

  /**
   * Register an element. Reuses existing ID if element is already known,
   * guaranteeing stable IDs across multiple re-parses.
   */
  register(el: HTMLElement, partial?: Partial<PageGuideElement>): string {
    let id = this.elementToId.get(el);

    if (!id && el.dataset.pageguideId) {
      const candidate = el.dataset.pageguideId;
      const existing = this.map.get(candidate);
      if (!existing || existing.element === el || !document.contains(existing.element)) {
        id = candidate;
      }
    }

    if (!id) {
      while (this.map.has(`pg-${this.nextId}`)) {
        this.nextId++;
      }
      id = `pg-${this.nextId++}`;
    }

    this.elementToId.set(el, id);
    el.dataset.pageguideId = id;

    const existingRecord = this.map.get(id);
    const updatedRecord: PageGuideElement = {
      id,
      element: el,
      type: partial?.type || existingRecord?.type || "other",
      accessibleName: partial?.accessibleName ?? existingRecord?.accessibleName ?? "",
      text: partial?.text ?? existingRecord?.text ?? "",
      href: partial?.href ?? existingRecord?.href,
      role: partial?.role ?? existingRecord?.role,
      nearbyHeading: partial?.nearbyHeading ?? existingRecord?.nearbyHeading,
      ariaLabel: partial?.ariaLabel ?? existingRecord?.ariaLabel,
      title: partial?.title ?? existingRecord?.title,
      disabled: partial?.disabled ?? existingRecord?.disabled,
      visible: partial?.visible ?? existingRecord?.visible ?? true,
    };

    this.map.set(id, updatedRecord);
    return id;
  }

  registerWithId(el: HTMLElement, id: string, partial?: Partial<PageGuideElement>): string {
    const normalized = id.startsWith("pg-") ? id : `pg-${id}`;
    this.elementToId.set(el, normalized);
    el.dataset.pageguideId = normalized;

    const existingRecord = this.map.get(normalized);
    const updatedRecord: PageGuideElement = {
      id: normalized,
      element: el,
      type: partial?.type || existingRecord?.type || "other",
      accessibleName: partial?.accessibleName ?? existingRecord?.accessibleName ?? "",
      text: partial?.text ?? existingRecord?.text ?? "",
      href: partial?.href ?? existingRecord?.href,
      role: partial?.role ?? existingRecord?.role,
      nearbyHeading: partial?.nearbyHeading ?? existingRecord?.nearbyHeading,
      ariaLabel: partial?.ariaLabel ?? existingRecord?.ariaLabel,
      title: partial?.title ?? existingRecord?.title,
      disabled: partial?.disabled ?? existingRecord?.disabled,
      visible: partial?.visible ?? existingRecord?.visible ?? true,
    };

    this.map.set(normalized, updatedRecord);
    return normalized;
  }

  /**
   * Returns HTMLElement for backward compatibility with actions, repair engine, etc.
   */
  get(id: string): HTMLElement | undefined {
    const normalized = id.startsWith("pg-") ? id : `pg-${id}`;
    const record = this.map.get(normalized);
    if (record) {
      if (document.contains(record.element)) {
        return record.element;
      }
      this.map.delete(normalized);
    }
    // Fallback search by dataset attribute if node was re-rendered in-place
    try {
      const found = document.querySelector<HTMLElement>(
        `[data-pageguide-id="${CSS.escape(normalized)}"]`
      );
      if (found && document.contains(found)) {
        this.elementToId.set(found, normalized);
        return found;
      }
    } catch {}
    return undefined;
  }

  getRecord(id: string): PageGuideElement | undefined {
    const normalized = id.startsWith("pg-") ? id : `pg-${id}`;
    const record = this.map.get(normalized);
    if (record && document.contains(record.element)) {
      return record;
    }
    return undefined;
  }

  getSemantic(id: string): SemanticElementInfo | undefined {
    const record = this.getRecord(id);
    if (!record) return undefined;
    const { element, ...semantic } = record;
    return semantic;
  }

  getAllSemantic(): SemanticElementInfo[] {
    const list: SemanticElementInfo[] = [];
    for (const [id, record] of this.map.entries()) {
      if (document.contains(record.element)) {
        const { element, ...semantic } = record;
        list.push(semantic);
      } else {
        this.map.delete(id);
      }
    }
    return list;
  }

  size(): number {
    return this.map.size;
  }

  entries(): Array<[string, HTMLElement]> {
    const out: Array<[string, HTMLElement]> = [];
    for (const [id, record] of this.map) {
      if (document.contains(record.element)) {
        out.push([id, record.element]);
      } else {
        this.map.delete(id);
      }
    }
    return out;
  }
}

export const elementRegistry = new ElementRegistry();
