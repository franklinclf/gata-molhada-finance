import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { openSqliteStore } from './store/sqlite-store.ts';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);
const server = createHttpServer({ store, version: config.version });

server.on('error', (error) => {
  console.error(`server error: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`listening on :${config.port} (version ${config.version}, schema ${store.schemaVersion()})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
