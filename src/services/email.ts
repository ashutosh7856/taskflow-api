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

  const from = process.env.EMAIL_FROM || "Danto <onboarding@resend.dev>";
  const action = input.actionUrl
    ? `<a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;margin-top:24px;padding:14px 22px;background:#181817;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;box-shadow:4px 4px 0 #ff5c35">${escapeHtml(input.actionLabel || "Open Danto")} &nbsp;→</a>`
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
        html: `<div style="background:#f2f0e9;padding:36px 18px;font-family:Arial,sans-serif;color:#181817"><div style="max-width:560px;margin:auto;overflow:hidden;background:#fffef9;border:1px solid #d4d0c5;border-radius:20px"><div style="padding:24px 30px;background:#181817;color:#ffffff"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="width:38px;height:38px;border-radius:12px;background:#d8ff63;color:#181817;text-align:center;font-size:24px;font-weight:900">d</td><td style="padding-left:12px;font-size:22px;font-weight:900;letter-spacing:-1px">danto</td></tr></table></div><div style="padding:34px 30px"><div style="font-family:monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#77736b">Danto notification</div><h1 style="font-size:28px;line-height:1.15;margin:12px 0 14px">${escapeHtml(input.title)}</h1><p style="font-size:16px;line-height:1.7;color:#56534d;margin:0">${escapeHtml(input.message)}</p>${action}<div style="height:1px;background:#e1ddd3;margin:34px 0 20px"></div><p style="margin:0;font-size:12px;line-height:1.6;color:#8a867d">Sent by Danto · Turn messy input into organized action.<br><a href="https://danto.app" style="color:#56534d">danto.app</a></p></div></div></div>`,
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
  const base = (process.env.FRONTEND_URL || "https://danto.app").replace(
    /\/$/,
    "",
  );
  return `${base}${path}`;
}
