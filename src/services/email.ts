interface SendEmailInput {
  to: string;
  subject: string;
  title: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string;
}

export interface EmailResult {
  sent: boolean;
  id?: string;
  reason?: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });

export async function sendEmail(input: SendEmailInput): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey)
    return { sent: false, reason: "RESEND_API_KEY is not configured" };

  const from = process.env.EMAIL_FROM || "TaskFlow <onboarding@resend.dev>";
  const action = input.actionUrl
    ? `<a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;margin-top:20px;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(input.actionLabel || "Open TaskFlow")}</a>`
    : "";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: `<div style="background:#f6f7fb;padding:32px;font-family:Arial,sans-serif;color:#172033"><div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:32px"><div style="font-size:20px;font-weight:700;color:#2563eb;margin-bottom:24px">TaskFlow</div><h1 style="font-size:24px;margin:0 0 12px">${escapeHtml(input.title)}</h1><p style="font-size:16px;line-height:1.6;color:#475467">${escapeHtml(input.message)}</p>${action}<p style="margin-top:28px;font-size:12px;color:#98a2b3">This notification was sent by TaskFlow.</p></div></div>`,
      }),
    });
    const result = (await response.json()) as { id?: string; message?: string };
    if (!response.ok) {
      console.error(
        "Resend rejected an email:",
        result.message || response.statusText,
      );
      return { sent: false, reason: result.message || response.statusText };
    }
    return { sent: true, id: result.id };
  } catch (error) {
    console.error("Email delivery failed:", error);
    return { sent: false, reason: "Email provider could not be reached" };
  }
}

export function frontendUrl(path: string) {
  const base = (process.env.FRONTEND_URL || "http://localhost:5173").replace(
    /\/$/,
    "",
  );
  return `${base}${path}`;
}
