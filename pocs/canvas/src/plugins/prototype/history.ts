/** Where a Play session has been: the breadcrumb. Going to a page already on the path folds the loop back to it. */
export class History {
  path: string[];
  constructor(start: string) {
    this.path = [start];
  }
  get current() {
    return this.path[this.path.length - 1];
  }
  go(id: string) {
    const i = this.path.indexOf(id);
    if (i >= 0) this.path = this.path.slice(0, i + 1);
    else this.path.push(id);
  }
  back(): boolean {
    if (this.path.length < 2) return false;
    this.path.pop();
    return true;
  }
  jump(i: number) {
    if (i >= 0 && i < this.path.length) this.path = this.path.slice(0, i + 1);
  }
  restart() {
    this.path = this.path.slice(0, 1);
  }
  /** Drop pages that no longer exist (deleted while playing). */
  prune(exists: (id: string) => boolean) {
    const kept = this.path.filter(exists);
    this.path = kept.length ? kept : this.path.slice(0, 0);
  }
}
