import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve';

/**
 * Production entry: serves the built UI from dist/ and hosts the bridge on one port.
 * Listens on 127.0.0.1 only; the bridge rejects WebSocket handshakes from other origins.
 *
 *   PORT=4173 SABLE_HOME=~/.sable tsx server/standalone.ts
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 4173);

const server = await startServer({ root, port });
console.log(`Sable is running at http://localhost:${server.port}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 10_000).unref();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
