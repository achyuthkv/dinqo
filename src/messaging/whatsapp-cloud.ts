import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMessage, MessagingProvider, SendRequest, SessionMessage, StatusUpdate } from './types.ts';
import { clip } from './types.ts';

export interface CloudConfig {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
}

/** Meta WhatsApp Business Platform, Cloud API. */
export class WhatsAppCloudProvider implements MessagingProvider {
  readonly name = 'whatsapp_cloud';
  constructor(private readonly cfg: CloudConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(req: SendRequest): Promise<{ providerMessageId: string }> {
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: req.to, ...toCloudPayload(req) };
    const res = await this.fetchImpl(
      `https://graph.facebook.com/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`WhatsApp send failed (${res.status}): ${data?.error?.message ?? 'unknown'}`);
      // 4xx other than rate limiting is permanent; don't retry it forever.
      (err as any).permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }
    return { providerMessageId: data.messages?.[0]?.id };
  }
}

export function toCloudPayload(req: SendRequest): Record<string, unknown> {
  if (req.form.type === 'template') {
    const t = req.form.message;
    const components: any[] = [];
    if (t.params.length) {
      components.push({ type: 'body', parameters: t.params.map((text) => ({ type: 'text', text })) });
    }
    if (t.otpCode) {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.otpCode }] });
    }
    (t.buttonPayloads ?? []).forEach((payload, i) =>
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }),
    );
    return { type: 'template', template: { name: t.name, language: { code: req.form.language }, components } };
  }
  return sessionPayload(req.form.message);
}

function sessionPayload(m: SessionMessage): Record<string, unknown> {
  const footer = 'footer' in m && m.footer ? { footer: { text: clip(m.footer, 60) } } : {};
  switch (m.kind) {
    case 'text':
      return { type: 'text', text: { body: clip(m.text, 4096), preview_url: true } };
    case 'buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clip(m.text, 1024) },
          ...footer,
          action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })) },
        },
      };
    case 'list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: clip(m.text, 1024) },
          ...footer,
          action: {
            button: clip(m.buttonLabel, 20),
            sections: [{
              title: 'Options',
              rows: m.rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: clip(r.title, 24),
                ...(r.description ? { description: clip(r.description, 72) } : {}),
              })),
            }],
          },
        },
      };
    case 'cta_url':
      return {
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: clip(m.text, 1024) },
          ...footer,
          action: { name: 'cta_url', parameters: { display_text: clip(m.label, 20), url: m.url } },
        },
      };
  }
}

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256(appSecret, rawBody). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Flattens a Cloud API webhook body into inbound messages and status updates. */
export function parseCloudWebhook(body: any): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      const names = new Map<string, string>(
        (v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]),
      );
      for (const m of v.messages ?? []) {
        const base = {
          providerMessageId: m.id,
          from: m.from,
          profileName: names.get(m.from),
          timestamp: new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString(),
        };
        if (m.type === 'text') messages.push({ ...base, type: 'text', text: m.text?.body ?? '' });
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          messages.push({ ...base, type: 'reply', payload: r?.id, text: r?.title });
        } else if (m.type === 'button') messages.push({ ...base, type: 'reply', payload: m.button?.payload, text: m.button?.text });
        else messages.push({ ...base, type: 'other' });
      }
      for (const s of v.statuses ?? []) {
        if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
        statuses.push({
          providerMessageId: s.id,
          status: s.status,
          error: s.errors?.map((e: any) => `${e.code}: ${e.title}`).join('; '),
        });
      }
    }
  }
  return { messages, statuses };
}
