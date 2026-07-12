/**
 * EMAIL.
 *
 * Why this matters more than it looks: one message to 1,832 members costs
 * NGN 8,244 by SMS. By email it costs roughly nothing.
 *
 * No DND register. No 160-character tax. No 8pm-8am MTN cutoff. No sender ID
 * paperwork with four telcos.
 *
 * So email is the DEFAULT and SMS is the fallback — send by email to everyone
 * who has one, and pay for SMS only for the people who do not.
 */
export type EmailResult = {
  ok: boolean;
  providerId?: string;
  error?: string;
};

export interface EmailProvider {
  name: string;
  send(to: string, from: string, subject: string, html: string, text: string):
    Promise<EmailResult>;
}

/** Resend. Free tier covers a small church outright. */
export class ResendProvider implements EmailProvider {
  name = "resend";
  private key = process.env.RESEND_API_KEY!;

  async send(to: string, from: string, subject: string, html: string, text: string) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.id) return { ok: true, providerId: j.id };
      return { ok: false, error: j.message || j.name || `HTTP ${r.status}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}

export class DryRunEmail implements EmailProvider {
  name = "dry-run";
  async send(): Promise<EmailResult> {
    return { ok: true, providerId: "dry_" + Math.random().toString(36).slice(2, 12) };
  }
}

export function emailProvider(): EmailProvider {
  if (!process.env.RESEND_API_KEY) return new DryRunEmail();
  return new ResendProvider();
}

/**
 * A church email is not a marketing email. No tracking pixels, no unsubscribe
 * footer written by a lawyer, no logo the size of a billboard. It should read
 * like a letter, because that is what it is.
 *
 * Plain text is generated alongside — many Nigerian members read mail on a
 * feature phone or a cheap Android client that renders HTML badly.
 */
export function renderEmail(church: string, body: string, brand = "#00C389") {
  const paras = body.trim().split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 18px;font-size:16px;line-height:1.7;color:#3A3F4B">${
      p.replace(/\n/g, "<br>")}</p>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${church}</title></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F8;padding:32px 16px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:${brand};height:4px;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="padding:32px 36px 8px">
      <div style="font-size:14px;font-weight:600;color:#12141A;letter-spacing:.02em">${church}</div>
    </td></tr>
    <tr><td style="padding:12px 36px 32px">${paras}</td></tr>
    <tr><td style="padding:20px 36px;border-top:1px solid #EDEEF1;background:#FAFBFC">
      <div style="font-size:12px;line-height:1.6;color:#8B92A0">
        You are receiving this because you are a member of ${church}.<br>
        To stop receiving these, reply to this email and tell us.
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = `${church}\n\n${body.trim()}\n\n---\nYou are receiving this because you are a member of ${church}. To stop receiving these, reply and tell us.`;

  return { html, text };
}
