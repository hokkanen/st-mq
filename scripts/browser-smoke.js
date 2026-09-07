// Compatibility entrypoint: all browser checks use the maintained, isolated
// simulation/provider fixture. Optional argument: Firefox BiDi WebSocket URL.
// No existing household server is contacted or changed.
if (process.argv[3]) throw new Error('Browser smoke now starts its own isolated server. Omit the old server-URL argument.');
await import('./browser-chart-smoke.js');
