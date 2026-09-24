import type { Category } from './types.ts';

/**
 * Template registry. These are the message templates to submit for approval in
 * WhatsApp Manager; `name`, param order and button order must match exactly.
 * They are used only when the player's 24h customer-service window is closed.
 */
export interface TemplateDef {
  name: string;
  category: Exclude<Category, 'service'>;
  body: string;             // {{n}} placeholders, 1-based
  buttons?: string[];       // quick replies (payloads are set per send)
}

export const TEMPLATES: Record<string, TemplateDef> = {
  dinqo_availability_poll: {
    name: 'dinqo_availability_poll',
    category: 'marketing',
    // Template params cannot contain newlines, so {{3}} is a "; "-separated list.
    body: 'Hi {{1}} 👋 {{2}} is playing this week: {{3}}\n\nTap below to mark the games you can make.',
    buttons: ['Mark availability', 'Not this week'],
  },
  dinqo_game_invite: {
    name: 'dinqo_game_invite',
    category: 'marketing',
    body: '🏓 {{1}} has invited you to play\n\n*{{2}}*\n📍 {{3}}\n🗓 {{4}}\n🎾 {{5}}\n💰 {{6}}\n\nWant to play?',
    buttons: ["Yes, I'm in", 'Not this time'],
  },
  dinqo_payment_pending: {
    name: 'dinqo_payment_pending',
    category: 'utility',
    body: 'Your spot for *{{1}}* on {{2}} is held until {{3}}.\n\nComplete payment of {{4}} to confirm: {{5}}',
  },
  dinqo_booking_confirmed: {
    name: 'dinqo_booking_confirmed',
    category: 'utility',
    body: "You're confirmed ✅\n\n*{{1}}*\n📍 {{2}}\n🗓 {{3}}\n\nWe'll remind you before the game.",
  },
  dinqo_hold_expired: {
    name: 'dinqo_hold_expired',
    category: 'utility',
    body: 'Your held spot for *{{1}}* on {{2}} was released because payment was not completed.',
    buttons: ['Try again'],
  },
  dinqo_waitlist_offer: {
    name: 'dinqo_waitlist_offer',
    category: 'utility',
    body: 'A spot just opened up for *{{1}}* on {{2}} 🎉\n\nIt is reserved for you until {{3}}. Would you like it?',
    buttons: ["Yes, I'm in", 'No, pass'],
  },
  dinqo_event_reminder: {
    name: 'dinqo_event_reminder',
    category: 'utility',
    body: 'Reminder: *{{1}}*\n📍 {{2}}\n🗓 {{3}}\n\nSee you on court!',
    buttons: ["Can't make it"],
  },
  dinqo_cancellation_update: {
    name: 'dinqo_cancellation_update',
    category: 'utility',
    body: 'Your registration for *{{1}}* on {{2}} is cancelled. {{3}}',
  },
  dinqo_refund_update: {
    name: 'dinqo_refund_update',
    category: 'utility',
    body: 'Refund update for *{{1}}*: {{2}}',
  },
  dinqo_event_cancelled: {
    name: 'dinqo_event_cancelled',
    category: 'utility',
    body: 'Sorry — *{{1}}* on {{2}} has been cancelled by the organiser. {{3}}',
  },
};
