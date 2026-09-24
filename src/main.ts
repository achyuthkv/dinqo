import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { buildServer } from './http/server.ts';

const config = loadConfig();
if (process.env.NODE_ENV === 'production') {
  const problems = [
    config.adminApiKey === 'dev-admin-key' && 'ADMIN_API_KEY is the default',
    config.devTools && 'DEV_TOOLS must be false (the simulator bypasses webhook signatures)',
    config.whatsapp.provider === 'cloud' && !config.whatsapp.appSecret && 'WHATSAPP_APP_SECRET is required',
    config.payments.provider !== 'razorpay' && 'PAYMENTS_PROVIDER must be razorpay',
    config.whatsapp.displayNumber === '919000000000' && 'WHATSAPP_DISPLAY_NUMBER must be the real Dinqo number (used in join links)',
    config.platformAdminPhones.join(',') === '919845000000' && 'PLATFORM_ADMIN_PHONES must list the Dinqo team numbers',
  ].filter(Boolean);
  if (problems.length) {
    console.error('Refusing to start in production:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}
const app = createApp(config);
app.boot();
app.jobs.start(1000);

const server = buildServer(app);
server.listen(config.port, () => {
  console.log(`Dinqo listening on ${config.baseUrl}`);
  console.log(`  organiser console: ${config.baseUrl}/admin`);
  if (config.devTools) console.log(`  WhatsApp simulator: ${config.baseUrl}/dev/simulator`);
  console.log(`  messaging: ${app.messaging.name} · payments: ${app.payments.name}`);
});

const shutdown = () => {
  app.jobs.stop();
  server.close(() => { app.db.close(); process.exit(0); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
