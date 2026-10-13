import { buildEmulator } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await buildEmulator({ config, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`Payriff emulator at ${config.publicUrl}/api/v3, control API at ${config.publicUrl}/_emulator`);
