import { randomBytes } from 'node:crypto';

/** Short, sortable-enough, prefixed ids: `evt_k3j9x0q1a2b3`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();
  return `${prefix}_${time}${rand}`;
}
