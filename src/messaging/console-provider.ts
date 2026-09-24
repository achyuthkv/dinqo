import { newId } from '../util/ids.ts';
import type { MessagingProvider, SendRequest } from './types.ts';

/** Development provider: "sends" by recording. The simulator reads the ledger. */
export class ConsoleProvider implements MessagingProvider {
  readonly name = 'console';
  readonly sent: SendRequest[] = [];
  constructor(private readonly log = false) {}

  async send(req: SendRequest): Promise<{ providerMessageId: string }> {
    this.sent.push(req);
    if (this.log) {
      const m = req.form.message as any;
      console.log(`[wa → ${req.to}] ${req.form.type === 'template' ? `template:${m.name}` : m.text ?? ''}`);
    }
    return { providerMessageId: newId('wamid') };
  }
}
