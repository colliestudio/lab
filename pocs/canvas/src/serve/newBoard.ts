import { ServeError, createBoard, importBoard } from './api';
import { boardHref } from './route';

// New board / Open / drop on a served board: the board in this tab is a file the service keeps, so each
// of them makes a new served board and opens it, never replaces this one.

const MAX_TRIES = 20;

/** Make a board named `base` (`base 2`, `base 3`… while the name is taken), empty or holding `text`. Returns the name. */
export async function createUnique(base: string, text: string | undefined, f: typeof fetch = fetch): Promise<string> {
  const make = (name: string) => (text === undefined ? createBoard(name, f) : importBoard(name, text, f));
  let stem = base.trim() || 'Untitled';
  for (let i = 1; i <= MAX_TRIES; i++) {
    const name = i === 1 ? stem : `${stem} ${i}`;
    try {
      return (await make(name)).name;
    } catch (e) {
      if (!(e instanceof ServeError)) throw e;
      if (e.status === 400 && stem !== 'Untitled') {
        // not a usable name (a file name with a slash or a dot first…): the file's text still imports
        stem = 'Untitled';
        i = 0;
        continue;
      }
      // 409 with a kind is the file's own fault (newer format), not a taken name
      if (e.status !== 409 || e.kind) throw e;
    }
  }
  throw new Error(`could not find a free name for "${stem}"`);
}

/**
 * Open the board `make` creates in a new tab. The tab opens first, in the click's gesture (browsers block a
 * window.open after an await), and is pointed at the board once it exists; when blocked, this tab goes
 * there (the current board is safe on the service, so nothing is lost). Rethrows `make`'s error.
 */
export async function openServedBoard(make: () => Promise<string>, win: Pick<Window, 'open' | 'location'> = window): Promise<string> {
  const tab = win.open('', '_blank');
  let name: string;
  try {
    name = await make();
  } catch (e) {
    tab?.close();
    throw e;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = boardHref(name);
  } else win.location.href = boardHref(name);
  return name;
}

/** A file name without its .canvas / .json extension. */
export const fileStem = (name: string) => name.replace(/\.(canvas|json)$/i, '').trim();
