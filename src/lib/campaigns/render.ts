import type { CampaignPurpose } from "@prisma/client";
import { estimateSegments } from "@/lib/sms";
import { MMS_SAFE_BYTES } from "@/lib/files";

export const ORG_NAME = "T. Turner & Associates, LLC";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Light formatting: blank line = paragraph, **bold**, *italic*, bare links. */
export function formatBody(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((para) => {
      let html = escapeHtml(para);
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
      html = html.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" style="color:#0b1f5c">$1</a>');
      return `<p style="margin:0 0 16px">${html.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

export type EmailRenderInput = {
  subject: string;
  body: string;
  purpose: CampaignPurpose;
  flyer?: { url: string; title: string; mimeType: string } | null;
  unsubscribeUrl: string;
  mailingAddress?: string | null;
};

/** Email HTML (table layout for email-client compatibility). */
export function renderEmailHtml(input: EmailRenderInput): string {
  const flyer = input.flyer
    ? input.flyer.mimeType.startsWith("image/")
      ? `<p style="margin:0 0 16px"><img src="${escapeHtml(input.flyer.url)}" alt="${escapeHtml(input.flyer.title)}" style="max-width:100%;height:auto;border:0"></p>`
      : `<p style="margin:0 0 16px"><a href="${escapeHtml(input.flyer.url)}" style="color:#0b1f5c;font-weight:bold">View: ${escapeHtml(input.flyer.title)}${input.flyer.mimeType === "application/pdf" ? " (PDF)" : ""}</a></p>`
    : "";
  const isPromo = input.purpose !== "SERVICE";
  const footer = [
    escapeHtml(ORG_NAME),
    input.mailingAddress ? escapeHtml(input.mailingAddress) : "",
    isPromo
      ? `You're receiving this because you asked to hear about our services. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#555">Unsubscribe</a>`
      : `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#555">Email preferences</a>`,
  ]
    .filter(Boolean)
    .join("<br>");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;background:#f4f5f8;font-family:Georgia,'Times New Roman',serif;color:#1c2333">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#0b1f5c;color:#ffffff;padding:18px 24px;font-size:18px;letter-spacing:1px">TTURNER <span style="color:#d2a43f">CLIENT CONNECT</span></td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.55;font-family:Arial,Helvetica,sans-serif">${formatBody(input.body)}${flyer}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e6e8ee;color:#666;font-size:12px;line-height:1.5;font-family:Arial,Helvetica,sans-serif">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export const SMS_OPT_OUT_TEXT = "Reply STOP to opt out.";

export type SmsPreview = {
  text: string;
  segments: ReturnType<typeof estimateSegments>;
  media: "mms" | "link" | "none";
  mediaNote: string | null;
};

export function renderSms(input: {
  body: string;
  purpose: CampaignPurpose;
  flyer?: { title: string; mimeType: string; sizeBytes: number } | null;
  flyerLinkPlaceholder?: string;
}): SmsPreview {
  let text = `${ORG_NAME.replace(", LLC", "")}: ${input.body.trim()}`;
  let media: SmsPreview["media"] = "none";
  let mediaNote: string | null = null;
  if (input.flyer) {
    const mmsOk = input.flyer.mimeType.startsWith("image/") && input.flyer.sizeBytes <= MMS_SAFE_BYTES;
    if (mmsOk) {
      media = "mms";
      mediaNote = "Flyer image sent as a picture message (MMS).";
    } else {
      media = "link";
      text += `\nView flyer: ${input.flyerLinkPlaceholder ?? "[secure flyer link]"}`;
      mediaNote = input.flyer.mimeType === "application/pdf"
        ? "PDFs can't be sent by text, so a link is added instead."
        : "This image is too large for reliable MMS delivery, so a link is added instead.";
    }
  }
  // Opt-out language on every text, service or promotional.
  text += `\n${SMS_OPT_OUT_TEXT}`;
  return { text, segments: estimateSegments(text), media, mediaNote };
}
