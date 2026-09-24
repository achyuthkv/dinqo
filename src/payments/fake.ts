import { createHmac } from 'node:crypto';
import { newId } from '../util/ids.ts';
import { normaliseRazorpayEvent } from './razorpay.ts';
import { InvalidSignatureError, type CreateLinkInput, type PaymentEvent, type PaymentProvider } from './types.ts';

/**
 * Local stand-in for Razorpay. Links point at /dev/pay/:linkId; "paying" there
 * posts a Razorpay-shaped, signed webhook through the real webhook endpoint.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly links = new Map<string, { amountPaise: number; description: string; status: 'created' | 'paid' | 'cancelled' }>();
  readonly refunds: { refundId: string; paymentId: string; amountPaise: number }[] = [];
  failNextRefund = false;

  constructor(private readonly baseUrl: string, private readonly webhookSecret: string) {}

  async createLink(i: CreateLinkInput) {
    const linkId = newId('plink');
    this.links.set(linkId, { amountPaise: i.amountPaise, description: i.description, status: 'created' });
    return { linkId, url: `${this.baseUrl}/dev/pay/${linkId}` };
  }

  async cancelLink(linkId: string) {
    const l = this.links.get(linkId);
    if (l && l.status === 'created') l.status = 'cancelled';
  }

  async refund(i: { paymentId: string; amountPaise: number }) {
    if (this.failNextRefund) {
      this.failNextRefund = false;
      throw Object.assign(new Error('fake refund failure'), { permanent: false });
    }
    const refundId = newId('rfnd');
    this.refunds.push({ refundId, paymentId: i.paymentId, amountPaise: i.amountPaise });
    return { refundId, status: 'processed' as const };
  }

  /** Builds the signed webhook Razorpay would send when a link is paid. */
  paidWebhook(linkId: string, amountPaise?: number): { body: Buffer; headers: Record<string, string> } {
    const l = this.links.get(linkId);
    if (l) l.status = 'paid';
    const payload = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: linkId, status: 'paid' } },
        payment: { entity: { id: newId('pay'), amount: amountPaise ?? l?.amountPaise ?? 0, method: 'upi' } },
      },
    };
    return this.sign(payload);
  }

  sign(payload: object): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify(payload));
    return {
      body,
      headers: {
        'x-razorpay-signature': createHmac('sha256', this.webhookSecret).update(body).digest('hex'),
        'x-razorpay-event-id': newId('evt_rzp'),
      },
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent[] {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (headers['x-razorpay-signature'] !== expected) throw new InvalidSignatureError('bad signature');
    return normaliseRazorpayEvent(JSON.parse(rawBody.toString('utf8')), String(headers['x-razorpay-event-id'] ?? ''));
  }
}
