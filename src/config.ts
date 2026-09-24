export interface Config {
  port: number;
  baseUrl: string;
  databasePath: string;
  adminApiKey: string;
  devTools: boolean;             // simulator + fake payment pages
  consentPolicyVersion: string;
  whatsapp: {
    provider: 'console' | 'cloud';
    accessToken: string;
    phoneNumberId: string;
    appSecret: string;           // verifies X-Hub-Signature-256
    verifyToken: string;         // webhook subscription handshake
    graphVersion: string;
    templateLanguage: string;
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
    devTools: env('DEV_TOOLS', process.env.NODE_ENV === 'production' ? 'false' : 'true') === 'true',
    consentPolicyVersion: env('CONSENT_POLICY_VERSION', '2026-09'),
    whatsapp: {
      provider: env('WHATSAPP_PROVIDER', 'console') as 'console' | 'cloud',
      accessToken: env('WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
      appSecret: env('WHATSAPP_APP_SECRET'),
      verifyToken: env('WHATSAPP_VERIFY_TOKEN', 'dinqo-verify'),
      graphVersion: env('WHATSAPP_GRAPH_VERSION', 'v23.0'),
      templateLanguage: env('WHATSAPP_TEMPLATE_LANGUAGE', 'en'),
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
