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
        const { customOf } = await import('./services/custom');
        const bridge = attachBridge(server.httpServer as any);
        server.httpServer.once('close', () => bridge.dispose());
        // The person's stylesheet (Customize Sable), served as the desktop app serves it.
        const custom = customOf(bridge.app);
        server.middlewares.use((req, res, next) => {
          if (!custom.serveStyles(req, res)) next();
        });
      } catch (err) {
        server.config.logger.error(`[sable] bridge failed to start: ${(err as Error).stack}`);
      }
    },
  };
}
