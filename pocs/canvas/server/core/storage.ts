export interface BoardInfo {
  name: string;
  /** ms since epoch */
  modified?: number;
  size?: number;
}

/**
 * Where boards live: a folder today, a cloud store later. Names are file stems ("checkout-flow"),
 * never paths. Everything is async, since cloud drivers are.
 */
export interface BoardStorage {
  /** false = one fixed board (bridge mode): create, rename and remove refuse. */
  readonly mutable: boolean;
  list(): Promise<BoardInfo[]>;
  /** undefined = missing. */
  read(name: string): Promise<string | undefined>;
  /** Atomic replace. */
  write(name: string, text: string): Promise<void>;
  /** Exclusive: false when the board exists. */
  create(name: string, text: string): Promise<boolean>;
  /** Moves the sidecars too. Throws when `to` exists. */
  rename(from: string, to: string): Promise<void>;
  /** The folder driver moves it to a trash folder. */
  remove(name: string): Promise<void>;
  /** The Yjs history sidecar: keeps identities across restarts. Deleting it is always safe (the board text wins). */
  readState(name: string): Promise<Uint8Array | undefined>;
  writeState(name: string, data: Uint8Array): Promise<void>;
  /** Edits from outside the server (an editor, git, iCloud). Debouncing is the board's job. Returns the unsubscribe. */
  watch(name: string, onChange: () => void): () => void;
  /** For status lines and logs only (a file path). */
  location?(name: string): string;
}
