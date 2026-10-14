export const DEV_APP_ORIGINS: string[];
export const PERMISSIONS_POLICY: string;
export function originRegex(pattern: string): string;
export function parseConnect(value: string | null | undefined): string[];
export interface FrameResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export function frameHost(opts?: { appOrigins?: string[] }): {
  serve(pathname: string, search?: string): FrameResponse;
  appOrigins: string[];
  workerBoot: string;
  pageBoot: string;
};
