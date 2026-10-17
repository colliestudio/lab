import { FolderBlockedError } from '../core/errors';

// A folder macOS (TCC) or a dead volume refuses to answer does not fail: the read just never returns, and
// each stuck call holds one of libuv's four threads until nothing in the process can touch a file. This
// guard gives every folder call a deadline. After a miss, calls fail at once (no new call goes to the
// folder) until a probe, or the stuck call itself, comes back.

export interface IoGuardOptions {
  /** What the folder is called in the message. */
  dir: string;
  /** Deadline of one call. */
  timeoutMs: number;
  /** A cheap call that touches the folder (a readdir): the guard re-tries it while blocked. */
  probe: () => Promise<unknown>;
  /** Said when the folder stops answering and when it answers again. */
  log?: (msg: string) => void;
  /** While blocked, a new probe at most this often (default 15 s)... */
  probeEveryMs?: number;
  /** ...and never more than this many stuck at once (default 2; the pool has 4 threads). */
  maxProbes?: number;
}

export const blockedMessage = (dir: string, timeoutMs: number, node = process.execPath) =>
  `the data folder ${dir} did not answer within ${Math.round(timeoutMs / 100) / 10} s. On macOS this is a missing permission: grant ${node} Full Disk Access (System Settings > Privacy & Security > Full Disk Access), then restart the service. Otherwise check that the folder's volume is online.`;

export class IoGuard {
  private since = 0;
  private lastProbe = 0;
  private probes = 0;

  constructor(private o: IoGuardOptions) {}

  get blocked() {
    return this.since > 0;
  }

  private error() {
    return new FolderBlockedError(blockedMessage(this.o.dir, this.o.timeoutMs));
  }

  private unblock() {
    if (!this.since) return;
    this.since = 0;
    this.o.log?.(`the data folder ${this.o.dir} answers again`);
  }

  private maybeProbe() {
    const now = Date.now();
    if (this.probes >= (this.o.maxProbes ?? 2) || now - this.lastProbe < (this.o.probeEveryMs ?? 15_000)) return;
    this.lastProbe = now;
    this.probes++;
    const done = () => {
      this.probes--;
      this.unblock();
    };
    void this.o.probe().then(done, done);
  }

  /** Run a folder call under the deadline; a call that comes back late (even with an error) means the folder answers. */
  run<T>(op: () => Promise<T>): Promise<T> {
    if (this.since) {
      this.maybeProbe();
      return Promise.reject(this.error());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.since = Date.now();
        this.lastProbe = this.since;
        this.o.log?.(this.error().message);
        reject(this.error());
      }, this.o.timeoutMs);
      op().then(
        (v) => {
          clearTimeout(timer);
          if (settled) return this.unblock();
          settled = true;
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          if (settled) return this.unblock();
          settled = true;
          reject(e);
        },
      );
    });
  }
}
