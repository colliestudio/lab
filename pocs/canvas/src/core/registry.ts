/**
 * An ordered set of things plugins register (dock buttons, main-menu rows). Registering an id again
 * replaces the earlier one in place; the disposer removes it, unless it was replaced since.
 */
export class Registry<T extends { id: string; section?: string; order?: number }> {
  private items: T[] = [];
  private listeners = new Set<() => void>();

  add(item: T): () => void {
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    this.emit();
    return () => {
      const at = this.items.indexOf(item);
      if (at < 0) return;
      this.items.splice(at, 1);
      this.emit();
    };
  }

  /** Items by section (in the order given; unlisted sections go before the last listed one), then `order`, then registration order. */
  list(sections: string[] = []): T[] {
    const last = Math.max(0, sections.length - 1);
    const rank = (s?: string) => {
      const i = s ? sections.indexOf(s) : -1;
      return i >= 0 ? i : sections.length > 1 ? last - 0.5 : 0;
    };
    return this.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => rank(a.item.section) - rank(b.item.section) || (a.item.order ?? a.index) - (b.item.order ?? b.index) || a.index - b.index)
      .map((x) => x.item);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
