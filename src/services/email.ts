export interface EmailBrand {
  name: string;
  color?: string | null;
  logoUrl?: string | null;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  title: string;
  message: string;
  /** Hidden inbox preview text. Defaults to the first line of the message. */
  preheader?: string;
  /** Small label above the title, e.g. "Password reset". */
  eyebrow?: string;
  /** One-time code shown large and copyable (OTP emails). */
  code?: string;
  /** Short label/value rows, e.g. [["Board", "Website"], ["Due", "May 3"]]. */
  details?: Array<[string, string]>;
  actionLabel?: string;
  actionUrl?: string;
  /** Muted note under the button, e.g. "Didn't request this? Ignore it." */
  footnote?: string;
  /** Sender branding for client-facing emails. Defaults to Danto. */
  brand?: EmailBrand;
  /** Show "Sent with Danto" credit when another brand is used. */
  showCredit?: boolean;
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

const INK = "#181817";
const ACID = "#d8ff63";
const PAPER = "#f2f0e9";
const SITE = "https://danto.app";
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Picks readable text (black or white) for a hex background. */
function contrastText(hex: string) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? INK : "#ffffff";
}

function paragraphs(message: string) {
  return message
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.65;color:#44423d">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

export function renderEmail(input: SendEmailInput) {
  const brand = input.brand || { name: "Danto", color: INK };
  const isDanto = !input.brand;
  const accent = brand.color || INK;
  const buttonText = contrastText(accent);
  const preheader = escapeHtml(
    input.preheader || input.message.split("\n")[0].slice(0, 140),
  );

  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" height="32" style="display:block;height:32px;max-width:180px;border:0">`
    : isDanto
      ? `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="width:34px;height:34px;border-radius:10px;background:${ACID};color:${INK};text-align:center;font:900 20px/34px ${FONT}">d</td><td style="padding-left:10px;font:850 21px ${FONT};letter-spacing:-0.8px;color:${INK}">danto</td></tr></table>`
      : `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="width:34px;height:34px;border-radius:10px;background:${accent};color:${buttonText};text-align:center;font:900 17px/34px ${FONT}">${escapeHtml(brand.name.slice(0, 1).toUpperCase())}</td><td style="padding-left:10px;font:800 18px ${FONT};color:${INK}">${escapeHtml(brand.name)}</td></tr></table>`;

  const code = input.code
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 22px"><tr><td align="center" style="background:${PAPER};border:1px dashed #c9c5ba;border-radius:14px;padding:22px 12px"><div style="font:800 36px/1 'SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:10px;color:${INK}">${escapeHtml(input.code)}</div><div style="margin-top:10px;font:500 12px ${FONT};color:#8a867d">Expires in 15 minutes · single use</div></td></tr></table>`
    : "";

  const details = input.details?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px 0 20px;border:1px solid #e6e2d8;border-radius:12px;border-collapse:separate">${input.details
        .map(
          ([label, value], index) =>
            `<tr><td style="padding:11px 16px;font:600 13px ${FONT};color:#8a867d;${index ? "border-top:1px solid #efece4;" : ""}width:38%">${escapeHtml(label)}</td><td style="padding:11px 16px;font:700 14px ${FONT};color:${INK};${index ? "border-top:1px solid #efece4;" : ""}">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const button =
    input.actionUrl && input.actionLabel
      ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 6px"><tr><td style="border-radius:999px;background:${accent}"><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;padding:14px 26px;font:800 15px ${FONT};color:${buttonText};text-decoration:none;border-radius:999px">${escapeHtml(input.actionLabel)} &rarr;</a></td></tr></table><p style="margin:12px 0 0;font:500 12px/1.6 ${FONT};color:#9a968c">Button not working? Paste this link into your browser:<br><a href="${escapeHtml(input.actionUrl)}" style="color:#6b675f;word-break:break-all">${escapeHtml(input.actionUrl)}</a></p>`
      : "";

  const footnote = input.footnote
    ? `<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #efece4;font:500 13px/1.6 ${FONT};color:#8a867d">${escapeHtml(input.footnote)}</p>`
    : "";

  const credit =
    isDanto || input.showCredit !== false
      ? `<a href="${SITE}/?ref=email" style="color:#8a867d;text-decoration:none">${isDanto ? "Danto · Client portals that keep projects moving" : "Sent with Danto"}</a>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${PAPER}"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px">
<tr><td style="padding:0 6px 18px">${logo}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1ddd3;border-radius:22px;overflow:hidden">
<div style="height:6px;background:${isDanto ? ACID : accent};border-radius:22px 22px 0 0"></div>
<div style="padding:34px 32px 32px">
${input.eyebrow ? `<div style="font:700 11px ${FONT};letter-spacing:1.6px;text-transform:uppercase;color:#8a867d;margin-bottom:10px">${escapeHtml(input.eyebrow)}</div>` : ""}
<h1 style="margin:0 0 16px;font:850 26px/1.2 ${FONT};letter-spacing:-0.6px;color:${INK}">${escapeHtml(input.title)}</h1>
${paragraphs(input.message)}
${code}${details}${button}${footnote}
</div></td></tr>
<tr><td align="center" style="padding:22px 10px 0;font:500 12px/1.7 ${FONT};color:#9a968c">${credit}${credit ? "<br>" : ""}You're receiving this because of activity on your account or project.</td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendEmail(input: SendEmailInput): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey)
    return { sent: false, reason: "RESEND_API_KEY is not configured" };

  const defaultFrom = process.env.EMAIL_FROM || "Danto <hello@danto.app>";
  // Client-facing mail shows the freelancer's business as the sender name
  // while still sending from the verified Danto address.
  const address = defaultFrom.match(/<([^>]+)>/)?.[1] || defaultFrom;
  const from = input.brand
    ? `${input.brand.name.replace(/[<>"]/g, "")} via Danto <${address}>`
    : defaultFrom;

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
        html: renderEmail(input),
        text: [
          input.title,
          "",
          input.message,
          input.code ? `\nYour code: ${input.code}` : "",
          ...(input.details || []).map(([k, v]) => `${k}: ${v}`),
          input.actionUrl
            ? `\n${input.actionLabel || "Open"}: ${input.actionUrl}`
            : "",
          input.footnote ? `\n${input.footnote}` : "",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
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
