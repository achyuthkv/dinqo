export interface CreateLinkInput {
  referenceId: string;          // our payment id
  amountPaise: number;
  description: string;
  customer: { name?: string; phone: string };
  expireBy: Date;
}

export type PaymentEvent =
  | { eventId: string; type: 'link_paid'; linkId: string; paymentId: string; amountPaise: number }
  | { eventId: string; type: 'link_expired'; linkId: string }
  | { eventId: string; type: 'refund_processed' | 'refund_failed'; refundId: string; paymentId: string };

export interface PaymentProvider {
  readonly name: string;
  createLink(input: CreateLinkInput): Promise<{ linkId: string; url: string }>;
  cancelLink(linkId: string): Promise<void>;
  refund(input: { paymentId: string; amountPaise: number; referenceId: string }): Promise<{ refundId: string; status: 'pending' | 'processed' }>;
  /** Route: move part of a captured payment to a community's linked account, held until `holdUntil`. */
  transfer(input: { paymentId: string; accountId: string; amountPaise: number; holdUntil: Date; referenceId: string }): Promise<{ transferId: string }>;
  /** Route: pull money back from a community's transfer (before refunding the player). */
  reverseTransfer(input: { transferId: string; amountPaise: number }): Promise<void>;
  /** Verifies the signature and normalises the webhook. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent[];
}

export class InvalidSignatureError extends Error {}
