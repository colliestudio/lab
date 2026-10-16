import * as z from 'zod/mini';
import type { DocView } from './doc';
import type { LogActor } from './log';
import type { DispatchResult } from './store';

// How a plugin describes what an agent can do, at the place it registers the command or view: what it
// does, which args it takes, an example. The bridge builds its tools, help and validation from these
// and knows no plugin by name. Browser- and Node-safe: only zod/mini and types.

export type ArgSchema = z.ZodMiniObject;

/** What an adapter sees: the doc as it is now (a getter, so it is fresh after a dispatch) and who asks. */
export interface AgentCtx {
  readonly doc: DocView;
  actor: LogActor;
}

/**
 * One CLI spelling of a command or view. `verb` can be two words ('chess move'); `pos` names the
 * positional args in order; `rest` names the arg that takes all remaining words (joined, or an array
 * for an array arg); `set` fixes args for this spelling (add-column sets `type: 'group'`).
 */
export interface CliForm {
  verb: string;
  pos?: string[];
  rest?: string;
  set?: Record<string, unknown>;
  /** Args that keep the word `none` as text (a fill of "none" means see-through) instead of becoming null. */
  keepNone?: string[];
  /** Flag name to arg name when they differ (`--in` for `drawing`). */
  alias?: Record<string, string>;
  /** Builds the args itself from the words and flags (for verbs that wrap their input, like `draw box`). */
  compose?(words: string[], flags: Record<string, string>): Record<string, unknown>;
}

export interface CommandSpec<S extends ArgSchema = ArgSchema> {
  /** What it does and when to use it, one or two sentences. */
  description: string;
  /** `z.strictObject`: unknown keys are errors. */
  args: S;
  /** Must parse with `args`; shown in help and in every validation error. */
  example: z.input<S>;
  /** Named MCP tool (only the established names; naming policy is a separate task). */
  tool?: string;
  cli?: CliForm[];
  /** Agent args to command args when they differ (renames, a default board). May redirect: `{ command, args }`. */
  toCommand?(a: z.output<S>, ctx: AgentCtx): unknown;
  /** What the caller gets back (default `{ id: select[0], changed }`). */
  result?(r: DispatchResult, a: z.output<S>, ctx: AgentCtx): unknown;
  /** Text for MCP and the CLI; JSON when absent. */
  text?(v: unknown): string;
}

export interface ViewSpec<S extends ArgSchema = ArgSchema> {
  description: string;
  args: S;
  example?: z.input<S>;
  tool?: string;
  cli?: CliForm[];
  /** `undefined` means "not yet", which is what `wait` polls on. */
  read(doc: DocView, a: z.output<S>, actor: LogActor): unknown;
  wait?: true;
  /** Text after a wait times out. */
  waiting?: string;
  text?(v: unknown): string;
}

export const nodeRef = (description = 'node id, or its title (a unique prefix/substring is enough)') => z.string().check(z.meta({ description, format: 'canvas-node' }));

/** Typing helpers: they keep `toCommand` and `result` typed by the schema. */
export const command = <S extends ArgSchema>(s: CommandSpec<S>) => s as unknown as CommandSpec;
export const view = <S extends ArgSchema>(s: ViewSpec<S>) => s as unknown as ViewSpec;

/** What plugin CLI extras (bot, sync-backlog) talk to; bridge/client.ts implements it. */
export interface AgentApi {
  run(name: string, args: object): Promise<{ result: unknown; text?: string }>;
  view<T = any>(name: string, args?: object): Promise<T>;
  wait<T = any>(name: string, args?: object, timeoutS?: number): Promise<T | undefined>;
  log(n?: number): Promise<{ text: string }[]>;
}

/** Returned by `toCommand` to run a different command (diagram.add with a source runs diagram.addConnected). */
export class Redirect {
  constructor(
    readonly command: string,
    readonly args: unknown,
  ) {}
}
export const redirect = (command: string, args: unknown) => new Redirect(command, args);

/** A command line verb a plugin adds that is not just a command call (it reads a file, runs a loop). Node-only; lives in the plugin's cli.ts. */
export interface CliExtra {
  verb: string;
  usage: string;
  /** Default actor name when `--as` is not given. */
  as?: string;
  /** Acts as a tool (its edits are logged under that name) rather than as an agent. */
  kind?: 'tool';
  run(api: AgentApi, input: { pos: string[]; flags: Record<string, string>; rest: string[]; say(line: string): void }): Promise<void>;
}
