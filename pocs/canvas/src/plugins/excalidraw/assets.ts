// Before Excalidraw loads: its fonts come from our origin (vite.config.ts serves/copies them), not esm.sh.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';
