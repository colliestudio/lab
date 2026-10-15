// In-place text editing: turns an element already on the table into a plain-text editor and gives
// the text back when the user is done. Used for shape text and edge labels; anything that edits
// text where it sits (instead of a prompt() dialog) goes through here.

export interface InlineEditOpts {
  /** Text typed to start the edit: added at the end of the current text. */
  seed?: string;
  /** Enter commits (Shift+Enter = new line). Default: Enter = new line, ⌘/Ctrl+Enter commits. */
  enterCommits?: boolean;
  /** Let a press inside the editor reach the table (the table decides: caret, or a drag of the object). */
  dragThrough?: boolean;
  /** Escape cancels instead of committing. Default: commits (a click elsewhere commits too). */
  escapeCancels?: boolean;
  /** Called once with the text when the edit ends (not when it was cancelled). */
  onCommit(text: string): void;
  onCancel?(): void;
}

export interface InlineEdit {
  /** End the edit now. */
  close(commit?: boolean): void;
}

/** Selector for places where typing is text input, not a table shortcut. */
export const TEXT_INPUT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function inlineEdit(el: HTMLElement, opts: InlineEditOpts): InlineEdit {
  try {
    el.contentEditable = 'plaintext-only';
  } catch {
    /* older engines */
  }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.spellcheck = false;
  el.classList.add('cv-editing');
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  if (opts.seed) document.execCommand('insertText', false, opts.seed);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('pointerdown', stop);
    el.removeEventListener('paste', onPaste);
    // a trailing line break is how some engines show an empty last line
    const text = (el.innerText ?? el.textContent ?? '').replace(/\n$/, '');
    el.removeAttribute('contenteditable');
    el.classList.remove('cv-editing');
    if (commit) opts.onCommit(text);
    else opts.onCancel?.();
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(!opts.escapeCancels);
    } else if (e.key === 'Enter' && (opts.enterCommits ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish(true);
    }
  };
  const onBlur = () => finish(true);
  // a press inside the editor moves the caret: not a drag, not a deselect
  const stop = (e: Event) => e.stopPropagation();
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
  };
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
  if (!opts.dragThrough) el.addEventListener('pointerdown', stop);
  el.addEventListener('paste', onPaste);
  return { close: (commit = true) => finish(commit) };
}
