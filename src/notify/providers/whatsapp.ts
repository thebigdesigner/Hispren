/**
 * WHATSAPP.
 *
 * The way around bulk SMS, and it is better than bulk SMS.
 *
 * NO telco. NO sender ID. NO DND register. NO NCC approval. Meta does not care
 * that you are not a bank. And Nigerians LIVE on WhatsApp — a message from the
 * church lands in the same place their family does, not in the SMS folder they
 * stopped opening in 2019.
 *
 * TWO MODES:
 *
 *   MANUAL (works today, free, zero setup)
 *     A wa.me link. The secretary taps a name, WhatsApp opens with the message
 *     already written, she presses send. It goes from the CHURCH'S OWN number.
 *     One tap per person. For the 34 first-timers who need a call this Sunday,
 *     that is not a limitation — it is the right way to do it.
 *
 *   CLOUD API (a Meta business account, ~2 days)
 *     Real bulk. Templates must be approved by Meta, which takes a day.
 *     "Utility" templates (a service reminder, an appointment) are cheap.
 *     And anything sent inside a 24-hour SERVICE WINDOW — opened when the
 *     MEMBER messages the church first — is FREE and needs no template at all.
 */
import { EmailResult } from "./email";

/**
 * A wa.me link. Opens WhatsApp with the message pre-filled.
 * Works on a phone, works on desktop (WhatsApp Web). Costs nothing.
 */
export function waLink(phone: string, text: string): string {
  const n = phone.replace(/[^\d]/g, "");            // wa.me wants digits only
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export type WaResult = { ok: boolean; providerId?: string; error?: string };

export interface WaProvider {
  name: string;
  /** true when we can actually send in bulk without a human tapping. */
  bulk: boolean;
  send(to: string, body: string, template?: string): Promise<WaResult>;
}

/**
 * Meta's WhatsApp Cloud API. Direct — no BSP, no markup.
 * https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
 */
export class WhatsAppCloud implements WaProvider {
  name = "whatsapp-cloud";
  bulk = true;
  private token = process.env.WHATSAPP_TOKEN!;
  private phoneId = process.env.WHATSAPP_PHONE_ID!;

  async send(to: string, body: string, template?: string): Promise<WaResult> {
    const num = to.replace(/[^\d]/g, "");
    try {
      // Inside a 24-hour service window (the member messaged US first) we may
      // send free-form text and it is FREE. Outside it, Meta requires an
      // APPROVED TEMPLATE — there is no way around that, and it is the same
      // rule that stops WhatsApp becoming a spam channel.
      const payload = template
        ? {
            messaging_product: "whatsapp",
            to: num,
            type: "template",
            template: {
              name: template,
              language: { code: "en" },
              components: [{ type: "body",
                parameters: [{ type: "text", text: body }] }],
            },
          }
        : {
            messaging_product: "whatsapp",
            to: num,
            type: "text",
            text: { preview_url: false, body },
          };

      const r = await fetch(
        `https://graph.facebook.com/v21.0/${this.phoneId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.messages?.[0]?.id) {
        return { ok: true, providerId: j.messages[0].id };
      }
      return { ok: false, error: j.error?.message ?? `HTTP ${r.status}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}

/**
 * MANUAL. There is no API and there does not need to be one.
 *
 * The message is queued for a human to tap through. Nothing is "sent" here —
 * this provider exists so the rest of the system (suppression, consent,
 * frequency caps, the message log) works identically whether a message goes out
 * by API or by a secretary's thumb.
 */
export class WhatsAppManual implements WaProvider {
  name = "whatsapp-manual";
  bulk = false;
  async send(): Promise<WaResult> {
    return { ok: false, error: "queued for a human to send by hand" };
  }
}

export function waProvider(): WaProvider {
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID)
    return new WhatsAppCloud();
  return new WhatsAppManual();
}

/** Same thing. Both names are in use across the codebase. */
export const whatsappProvider = waProvider;
