/** Where log lines go (the server prefixes the board's name). */
export type Log = (...m: unknown[]) => void;

/**
 * One live-doc connection: a browser, or the room relay standing for many. Binary frames only, in the
 * y-websocket protocol. A driver (WebSocket today) wraps its socket in this.
 */
export interface Conn {
  /** No-op when the connection is not open. */
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(fn: (data: Uint8Array) => void): void;
  onClose(fn: () => void): void;
}
