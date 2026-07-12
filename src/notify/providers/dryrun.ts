/**
 * DRY RUN.
 *
 * Active whenever TERMII_API_KEY is unset. Every message is written to the
 * database and shown in the UI, and nothing leaves the building.
 *
 * This is not a stub. It means the entire notification system — the suppression
 * layer, consent, quiet hours, frequency caps, the GSM-7 counter, the credit
 * wallet — is fully exercised and demonstrable to a church BEFORE a single
 * sender ID is approved. When the sender ID lands, you set one env var and the
 * same code starts actually sending.
 */
import { SmsProvider, SendResult, Route } from "./index";

export class DryRunProvider implements SmsProvider {
  name = "dry-run";

  async send(to: string, _from: string, _body: string, route: Route): Promise<SendResult> {
    // Simulate what the real world would do, so the demo is honest:
    // on the generic route, a DND number is silently dropped by the network.
    if (route === "generic" && to.endsWith("0")) {
      return { ok: false, error: "simulated: DND number on the generic route" };
    }
    return {
      ok: true,
      providerId: "dry_" + Math.random().toString(36).slice(2, 12),
      cost: 0,
    };
  }

  async checkDnd(phone: string) {
    // deterministic, so a demo behaves the same way twice
    return { isDnd: phone.endsWith("0"), network: "MTN" };
  }

  async senderIds() {
    return [{ sender_id: "DRY-RUN", status: "active" }];
  }
}
