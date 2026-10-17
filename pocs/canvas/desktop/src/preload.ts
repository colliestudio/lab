import { contextBridge, ipcRenderer } from 'electron';

// The app's own pages (ui.html: switcher, Backend dialog, unreachable screen, icon) talk to the main process
// through this. Pages from the backend never get it.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('shell', {
    canvases: (): Promise<{ names: string[]; popped: string[]; error?: string }> => ipcRenderer.invoke('ui:canvases'),
    open: (name: string, popout: boolean): Promise<void> => ipcRenderer.invoke('ui:open', name, popout),
    create: (name: string, popout: boolean): Promise<{ error?: string }> => ipcRenderer.invoke('ui:create', name, popout),
    backend: (): Promise<string> => ipcRenderer.invoke('ui:backend'),
    setBackend: (value: string, force: boolean): Promise<{ ok?: true; error?: string; canForce?: boolean }> => ipcRenderer.invoke('ui:set-backend', value, force),
    retry: (): void => ipcRenderer.send('ui:retry'),
    close: (): void => ipcRenderer.send('ui:close'),
  });
}
