// SMS segment estimates. GSM-7 messages fit 160 characters in one segment
// (153 per segment when split); anything with other characters (emoji,
// curly quotes…) uses UCS-2: 70 per segment, 67 when split.

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

export type SegmentEstimate = { encoding: "GSM-7" | "UCS-2"; characters: number; segments: number };

export function estimateSegments(text: string): SegmentEstimate {
  const chars = Array.from(text);
  const isGsm = chars.every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
  if (isGsm) {
    const units = chars.reduce((n, c) => n + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
    return { encoding: "GSM-7", characters: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
  }
  // UCS-2 counts UTF-16 code units (emoji take two).
  const units = text.length;
  return { encoding: "UCS-2", characters: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}
