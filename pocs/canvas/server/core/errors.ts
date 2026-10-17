/** A refused board operation; `status` is the HTTP code a transport answers with. */
export class DirError extends Error {
  constructor(
    readonly status: 400 | 404 | 405 | 409,
    msg: string,
  ) {
    super(msg);
    this.name = 'DirError';
  }
}

/** A board file the server cannot read as a canvas (not JSON, not a canvas). The file is left as it is. */
export class BoardFileError extends Error {
  constructor(name: string, cause: Error, existing = true) {
    super(
      existing
        ? `${name}.canvas is not a canvas file the server can read: ${cause.message}. The file is untouched.`
        : `the text for "${name}" is not a canvas file: ${cause.message}. No canvas was made.`,
    );
    this.name = 'BoardFileError';
  }
}

/** A board that exists in the folder but isn't on this Mac yet (iCloud evicted it); the download has been asked for. */
export class NotLocalError extends Error {
  constructor(name: string) {
    super(`${name}.canvas is in iCloud but not downloaded to this Mac yet; downloading now, try again in a moment`);
    this.name = 'NotLocalError';
  }
}

/** The board folder does not answer (macOS blocking the process, an offline volume): refused at once instead of hanging every request. */
export class FolderBlockedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FolderBlockedError';
  }
}
