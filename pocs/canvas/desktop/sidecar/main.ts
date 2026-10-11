// canvas-bridge: the desktop app's sidecar binary.
//   canvas-bridge [file.canvas …]   the service (started by the app; JSON control lines on stdio)
//   canvas-bridge mcp               stdio MCP shim to the running app's endpoint
if (process.argv[2] === 'mcp') {
  const { runShim } = await import('./shim');
  await runShim();
} else {
  await import('./service');
}
export {};
