import './plugins.css';
import type { App } from '../core';
import { PluginHost } from './host';
import { mountPluginPanel } from './panel';
import { iframeTransport, localApprovals } from './sandbox';

export { PluginHost } from './host';

/** Runtime-loaded third-party plugins: the host (sandboxed iframes, local approvals) + the panel. */
export function mountPluginLoader(app: App, bar: HTMLElement) {
  const host = new PluginHost(app, iframeTransport, localApprovals());
  const panel = mountPluginPanel(host, bar);
  void host.sync();
  return { host, panel };
}
