import type { Plugin } from 'vite';

/** Attaches the Sable bridge to Vite's dev server (single process, single port). */
export function bridgePlugin(): Plugin {
  return {
    name: 'sable-bridge',
    apply: 'serve',
    async configureServer(server) {
      if (!server.httpServer) return;
      // Development only: the scripted Demo agent (headless checks and UI work without quota).
      // The standalone server and the desktop app never set this, so they never offer it.
      process.env.SABLE_DEMO ??= '1';
      try {
        const { attachBridge } = await import('./bridge');
        const bridge = attachBridge(server.httpServer as any);
        // No desktop shell here, so the updater reports `unsupported` (Settings › About says so).
        const { registerUpdates } = await import('./services/update');
        registerUpdates(bridge.app);
        server.httpServer.once('close', () => bridge.dispose());
      } catch (err) {
        server.config.logger.error(`[sable] bridge failed to start: ${(err as Error).stack}`);
      }
    },
  };
}
