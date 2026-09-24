import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidSignatureError, type CreateLinkInput, type PaymentEvent, type PaymentProvider } from './types.ts';

export interface RazorpayConfig { keyId: string; keySecret: string; webhookSecret: string }

/**
 * Razorpay Payment Links (UPI, cards, netbanking) and Refunds.
 * Webhook events to enable in the dashboard: payment_link.paid,
 * payment_link.expired, refund.processed, refund.failed.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  constructor(private readonly cfg: RazorpayConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, path: string, body?: object): Promise<any> {
    const res = await this.fetchImpl(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Razorpay ${method} ${path} failed (${res.status}): ${data?.error?.description ?? 'unknown'}`);
      (err as any).permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }
    return data;
  }

  async createLink(i: CreateLinkInput) {
    // Razorpay requires expire_by at least 15 minutes out.
    const minExpiry = Date.now() + 16 * 60_000;
    const link = await this.call('POST', '/payment_links', {
      amount: i.amountPaise,
      currency: 'INR',
      description: i.description.slice(0, 2048),
      reference_id: i.referenceId,
      expire_by: Math.floor(Math.max(i.expireBy.getTime(), minExpiry) / 1000),
      customer: { name: i.customer.name, contact: '+' + i.customer.phone },
      notify: { sms: false, email: false },   // we notify over WhatsApp
      reminder_enable: false,
      notes: { reference_id: i.referenceId },
    });
    return { linkId: link.id as string, url: link.short_url as string };
  }

  async cancelLink(linkId: string) {
    await this.call('POST', `/payment_links/${linkId}/cancel`);
  }

  async refund(i: { paymentId: string; amountPaise: number; referenceId: string }) {
    const r = await this.call('POST', `/payments/${i.paymentId}/refund`, {
      amount: i.amountPaise,
      speed: 'normal',
      receipt: i.referenceId,
      notes: { reference_id: i.referenceId },
    });
    return { refundId: r.id as string, status: r.status === 'processed' ? 'processed' as const : 'pending' as const };
  }

  async transfer(i: { paymentId: string; accountId: string; amountPaise: number; holdUntil: Date; referenceId: string }) {
    const r = await this.call('POST', `/payments/${i.paymentId}/transfers`, {
      transfers: [{
        account: i.accountId,
        amount: i.amountPaise,
        currency: 'INR',
        notes: { reference_id: i.referenceId },
        // Held until the game is over, so cancellations can still be reversed before settlement.
        on_hold: true,
        on_hold_until: Math.floor(i.holdUntil.getTime() / 1000),
      }],
    });
    const t = r.items?.[0] ?? r;
    return { transferId: t.id as string };
  }

  async reverseTransfer(i: { transferId: string; amountPaise: number }) {
    await this.call('POST', `/transfers/${i.transferId}/reversals`, { amount: i.amountPaise });
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent[] {
    const sig = String(headers['x-razorpay-signature'] ?? '');
    const expected = createHmac('sha256', this.cfg.webhookSecret).update(rawBody).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new InvalidSignatureError('bad razorpay signature');
    }
    const body = JSON.parse(rawBody.toString('utf8'));
    return normaliseRazorpayEvent(body, String(headers['x-razorpay-event-id'] ?? ''));
  }
}

export function normaliseRazorpayEvent(body: any, headerEventId: string): PaymentEvent[] {
  const p = body?.payload ?? {};
  const link = p.payment_link?.entity;
  const payment = p.payment?.entity;
  const refund = p.refund?.entity;
  switch (body?.event) {
    case 'payment_link.paid':
      return [{
        eventId: headerEventId || `${link.id}:paid:${payment.id}`,
        type: 'link_paid', linkId: link.id, paymentId: payment.id, amountPaise: Number(payment.amount),
      }];
    case 'payment_link.expired':
      return [{ eventId: headerEventId || `${link.id}:expired`, type: 'link_expired', linkId: link.id }];
    case 'refund.processed':
    case 'refund.failed':
      return [{
        eventId: headerEventId || `${refund.id}:${body.event}`,
        type: body.event === 'refund.processed' ? 'refund_processed' : 'refund_failed',
        refundId: refund.id, paymentId: refund.payment_id,
      }];
    default:
      return [];
  }
}
