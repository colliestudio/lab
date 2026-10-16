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
