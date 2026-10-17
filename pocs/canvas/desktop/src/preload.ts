import { contextBridge, ipcRenderer } from 'electron';

// The app's own pages (ui.html: switcher, Backend dialog, unreachable screen) talk to the main process
// through this. Pages from the backend never get it.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('shell', {
    boards: (): Promise<{ names: string[]; error?: string }> => ipcRenderer.invoke('ui:boards'),
    open: (name: string): Promise<void> => ipcRenderer.invoke('ui:open', name),
    create: (name: string): Promise<{ error?: string }> => ipcRenderer.invoke('ui:create', name),
    backend: (): Promise<string> => ipcRenderer.invoke('ui:backend'),
    setBackend: (value: string, force: boolean): Promise<{ ok?: true; error?: string; canForce?: boolean }> => ipcRenderer.invoke('ui:set-backend', value, force),
    retry: (): void => ipcRenderer.send('ui:retry'),
    close: (): void => ipcRenderer.send('ui:close'),
  });
}
