import { createContext, useContext } from "react";
import type { Comment, Doc, Level } from "../../src/model.ts";
import type { GetFile, NewComment } from "./boot.ts";

export interface ViewerCtx {
  doc: Doc;
  getFile: GetFile;
  level: Level;
  setLevel: (l: Level) => void;
  theme: "light" | "dark";
  focus: string | null;
  setFocus: (sectionId: string | null) => void;
  /** Scroll to (and open) the diff of a file; file-tree rows call this. */
  revealFile: (path: string) => void;
  api?: string;
  /** api: comments go to the server (serve / server); local: kept in this browser, shared via "Copy feedback". */
  commentMode: "api" | "local";
  comments: Comment[];
  addComment: (c: Omit<NewComment, "author">) => Promise<void>;
  removeComment: (id: string) => void;   // local mode only
  /** Clipboard with a select-and-copy fallback (file:// and plain HTTP may have no clipboard API). */
  copy: (text: string, what: string) => void;
}

export const Ctx = createContext<ViewerCtx>(null!);
export const useViewer = () => useContext(Ctx);
