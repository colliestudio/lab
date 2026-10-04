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
  comments: Comment[];
  addComment: (c: Omit<NewComment, "author">) => Promise<void>;
}

export const Ctx = createContext<ViewerCtx>(null!);
export const useViewer = () => useContext(Ctx);
