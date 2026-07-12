/**
 * Termii. https://v4.api.termii.com
 *
 * THE ROUTE IS THE WHOLE DECISION:
 *
 *   generic  Promotional. Will NOT deliver to a DND-registered number — at all.
 *            MTN additionally blocks it 8pm–8am WAT. A Saturday-night service
 *            reminder to an MTN number simply never arrives, and nobody is told.
 *
 *   dnd      Transactional. Reaches DND numbers, no time restriction.
 *            Termii must ACTIVATE it on the account and WHITELIST the sender ID.
 *
 * DND registration is widespread in Nigeria. A church on the generic route is
 * silently failing to reach a large share of its own congregation.
 */
import { SmsProvider, SendResult, Route } from "./index";

const BASE = process.env.TERMII_BASE_URL ?? "https://v4.api.termii.com";

export class TermiiProvider implements SmsProvider {
  name = "termii";
  private key = process.env.TERMII_API_KEY!;

  async send(to: string, from: string, body: string, route: Route): Promise<SendResult> {
    try {
      const r = await fetch(`${BASE}/api/sms/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.key,
          to: to.replace(/^\+/, ""),      // Termii wants 2348031234567, no plus
          from,
          sms: body,
          type: "plain",
          channel: route,                 // 'generic' | 'dnd'
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (j.code === "ok" || j.message_id) {
        return { ok: true, providerId: j.message_id, balance: j.balance };
      }
      return { ok: false, error: j.message || `HTTP ${r.status}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * The DND register. Worth one API call per number, cached — a 3,000-member
   * church would otherwise burn 3,000 calls every campaign.
   */
  async checkDnd(phone: string): Promise<{ isDnd: boolean; network?: string }> {
    try {
      const url = `${BASE}/api/check/dnd?api_key=${this.key}` +
                  `&phone_number=${encodeURIComponent(phone.replace(/^\+/, ""))}`;
      const r = await fetch(url);
      const j: any = await r.json().catch(() => ({}));
      return { isDnd: j?.dnd_active === true, network: j?.network };
    } catch {
      // If we cannot tell, assume DND. Assuming NOT-DND means using the generic
      // route on a DND number, which fails silently. Fail toward the safe route.
      return { isDnd: true };
    }
  }

  async senderIds() {
    try {
      const r = await fetch(`${BASE}/api/sender-id?api_key=${this.key}`);
      const j: any = await r.json().catch(() => ({}));
      return (j.content ?? []).map((s: any) => ({
        sender_id: s.sender_id, status: s.status,
      }));
    } catch { return []; }
  }
}
