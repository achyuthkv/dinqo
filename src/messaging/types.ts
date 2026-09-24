/** Channel-neutral outbound message shapes. Providers translate these. */
export interface Button { id: string; title: string }
export interface ListRow { id: string; title: string; description?: string }

export type SessionMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: Button[]; footer?: string }
  | { kind: 'list'; text: string; buttonLabel: string; rows: ListRow[]; footer?: string }
  | { kind: 'cta_url'; text: string; label: string; url: string; footer?: string };

/** Template form, required outside the 24h customer-service window. */
export interface TemplateMessage {
  name: string;
  params: string[];
  /** Quick-reply payloads, one per template button, in order. */
  buttonPayloads?: string[];
}

export type Category = 'utility' | 'marketing' | 'service';

export interface OutboundEnvelope {
  session: SessionMessage;
  /** Omit only for replies that can never be sent outside the window. */
  template?: TemplateMessage;
}

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  profileName?: string;
  timestamp: string;
  type: 'text' | 'reply' | 'other';
  text?: string;
  /** Id of the tapped button / list row, or template quick-reply payload. */
  payload?: string;
}

export interface StatusUpdate {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
}

export interface SendRequest {
  to: string;
  form: { type: 'session'; message: SessionMessage } | { type: 'template'; message: TemplateMessage; language: string };
}

export interface MessagingProvider {
  readonly name: string;
  send(req: SendRequest): Promise<{ providerMessageId: string }>;
}

export const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…');
