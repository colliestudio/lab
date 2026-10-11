import type { Decl, ToSandbox, FromSandbox } from './host';
export function createRuntime(plugin: unknown, post: (m: FromSandbox) => void): { handle(m: ToSandbox): Promise<void> };
export type { Decl };
