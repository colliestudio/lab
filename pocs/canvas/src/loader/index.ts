import './plugins.css';
import type { App } from '../core';
import { PluginHost } from './host';
import { mountPluginPanel } from './panel';
import { localApprovals, originTransport } from './sandbox';

export { PluginHost } from './host';

/** Runtime-loaded third-party plugins: the host (Workers in sandbox-origin frames, local approvals) + the panel. */
export function mountPluginLoader(app: App, bar: HTMLElement) {
  const host = new PluginHost(app, originTransport, localApprovals());
  const panel = mountPluginPanel(host, bar);
  void host.sync();
  return { host, panel };
}
