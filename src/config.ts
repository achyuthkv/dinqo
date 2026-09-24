export interface Config {
  port: number;
  baseUrl: string;
  databasePath: string;
  /** Bearer key for Dinqo staff scripts/automation (full platform access). */
  adminApiKey: string;
  /** Phones (E.164 digits) that log in to the console as Dinqo platform admins. */
  platformAdminPhones: string[];
  devTools: boolean;             // simulator + fake payment pages
  consentPolicyVersion: string;
  whatsapp: {
    provider: 'console' | 'cloud';
    accessToken: string;
    phoneNumberId: string;
    appSecret: string;           // verifies X-Hub-Signature-256
    verifyToken: string;         // webhook subscription handshake
    displayNumber: string;       // the shared Dinqo number players message, for wa.me join links
    graphVersion: string;
    templateLanguage: string;
    /** Outbound messages per second (Meta's Cloud API default is 80/s per number). */
    maxPerSecond: number;
    /** Parallel in-flight API calls. */
    sendConcurrency: number;
  };
  payments: {
    provider: 'fake' | 'razorpay';
    keyId: string;
    keySecret: string;
    webhookSecret: string;
  };
  /** Max marketing-category messages (availability polls + invitations) per player per rolling 7 days. */
  weeklyInviteCap: number;
}

const env = (k: string, d = ''): string => process.env[k] ?? d;

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = Number(env('PORT', '3000'));
  const base: Config = {
    port,
    baseUrl: env('BASE_URL', `http://localhost:${port}`),
    databasePath: env('DATABASE_PATH', './data/dinqo.db'),
    adminApiKey: env('ADMIN_API_KEY', 'dev-admin-key'),
    platformAdminPhones: env('PLATFORM_ADMIN_PHONES', '919845000000').split(',').map((s) => s.trim()).filter(Boolean),
    devTools: env('DEV_TOOLS', process.env.NODE_ENV === 'production' ? 'false' : 'true') === 'true',
    consentPolicyVersion: env('CONSENT_POLICY_VERSION', '2026-09'),
    whatsapp: {
      provider: env('WHATSAPP_PROVIDER', 'console') as 'console' | 'cloud',
      accessToken: env('WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
      appSecret: env('WHATSAPP_APP_SECRET'),
      verifyToken: env('WHATSAPP_VERIFY_TOKEN', 'dinqo-verify'),
      displayNumber: env('WHATSAPP_DISPLAY_NUMBER', '919000000000'),
      graphVersion: env('WHATSAPP_GRAPH_VERSION', 'v23.0'),
      templateLanguage: env('WHATSAPP_TEMPLATE_LANGUAGE', 'en'),
      maxPerSecond: Number(env('WHATSAPP_MAX_MPS', '60')),
      sendConcurrency: Number(env('WHATSAPP_SEND_CONCURRENCY', '32')),
    },
    payments: {
      provider: env('PAYMENTS_PROVIDER', 'fake') as 'fake' | 'razorpay',
      keyId: env('RAZORPAY_KEY_ID'),
      keySecret: env('RAZORPAY_KEY_SECRET'),
      webhookSecret: env('RAZORPAY_WEBHOOK_SECRET', 'dev-webhook-secret'),
    },
    weeklyInviteCap: Number(env('WEEKLY_INVITE_CAP', '6')),
  };
  return { ...base, ...overrides, whatsapp: { ...base.whatsapp, ...overrides.whatsapp }, payments: { ...base.payments, ...overrides.payments } };
}
