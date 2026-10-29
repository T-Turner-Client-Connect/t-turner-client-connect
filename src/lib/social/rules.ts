import type { SocialPlatform } from "@prisma/client";

// Platform requirements checked before scheduling. These follow each
// platform's published publishing rules (as of late 2026) and apply to manual
// posting too, so problems are caught here rather than at the platform.

export type MediaInfo = { id: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; title: string };

export const PLATFORM_LABELS: Record<SocialPlatform, string> = { FACEBOOK: "Facebook", INSTAGRAM: "Instagram", TIKTOK: "TikTok" };

export const PLATFORM_HOME: Record<SocialPlatform, string> = {
  FACEBOOK: "https://www.facebook.com/",
  INSTAGRAM: "https://www.instagram.com/",
  TIKTOK: "https://www.tiktok.com/upload",
};

const LIMITS: Record<SocialPlatform, { caption: number; maxMedia: number }> = {
  FACEBOOK: { caption: 63206, maxMedia: 10 },
  INSTAGRAM: { caption: 2200, maxMedia: 10 },
  TIKTOK: { caption: 2200, maxMedia: 35 },
};

const isVideo = (m: MediaInfo) => m.mimeType.startsWith("video/");
const isImage = (m: MediaInfo) => m.mimeType.startsWith("image/");

export function validateTarget(platform: SocialPlatform, caption: string, media: MediaInfo[]): string[] {
  const errors: string[] = [];
  const name = PLATFORM_LABELS[platform];
  const limit = LIMITS[platform];
  if (caption.length > limit.caption) errors.push(`${name} captions can be up to ${limit.caption.toLocaleString()} characters (this one is ${caption.length.toLocaleString()}).`);
  if (media.length > limit.maxMedia) errors.push(`${name} allows up to ${limit.maxMedia} media items per post.`);
  if (media.some((m) => m.mimeType === "application/pdf")) errors.push(`${name} doesn't accept PDFs. Use an image version of the flyer.`);

  if (platform === "FACEBOOK" && !caption.trim() && media.length === 0) errors.push("Add a caption or media.");

  if (platform === "INSTAGRAM") {
    if (media.length === 0) errors.push("Instagram posts need at least one image or video.");
    if (media.some((m) => m.mimeType === "image/png")) errors.push("Instagram publishing accepts JPEG images. Export the flyer as JPG.");
    for (const m of media.filter(isImage)) {
      if (m.sizeBytes > 8 * 1024 * 1024) errors.push(`"${m.title}" is over Instagram's 8 MB image limit.`);
      if (m.width && m.height) {
        const ratio = m.width / m.height;
        if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) errors.push(`"${m.title}" is ${m.width}×${m.height}. Instagram feed images must be between 4:5 (portrait) and 1.91:1 (landscape).`);
      }
    }
    if (media.length > 1 && media.some(isVideo) && media.length > 10) errors.push("Instagram carousels hold up to 10 items.");
    const hashtags = (caption.match(/#\w+/g) ?? []).length;
    if (hashtags > 30) errors.push(`Instagram allows up to 30 hashtags (found ${hashtags}).`);
  }

  if (platform === "TIKTOK") {
    if (media.length === 0) errors.push("TikTok posts need a video or photos.");
    const videos = media.filter(isVideo);
    if (videos.length > 1) errors.push("TikTok posts take one video.");
    if (videos.length && media.length > 1) errors.push("Don't mix a video with photos on TikTok.");
    if (!videos.length && media.some((m) => m.mimeType === "image/png")) errors.push("TikTok photo posts accept JPEG (or WebP) images. Export the flyer as JPG.");
  }
  return errors;
}

/** Permalink sanity check when staff confirm a manual post. */
export function validPermalink(platform: SocialPlatform, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^www\.|^m\./, "");
    return platform === "FACEBOOK" ? /(^|\.)facebook\.com$|^fb\.watch$/.test(host) : platform === "INSTAGRAM" ? /(^|\.)instagram\.com$/.test(host) : /(^|\.)tiktok\.com$/.test(host);
  } catch {
    return false;
  }
}

export const TARGET_STATUS_LABELS = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REQUIRES_MANUAL_POSTING: "Requires manual posting",
  POSTED_MANUALLY: "Posted manually (confirmed by staff)",
  CANCELLED: "Cancelled",
} as const;

/** Direct publishing status per platform. Nothing is connected in this build. */
export function directPublishingStatus(connected: Set<SocialPlatform>) {
  return (Object.keys(PLATFORM_LABELS) as SocialPlatform[]).map((p) => ({
    platform: p,
    available: false,
    reason: connected.has(p)
      ? "Account connected — direct publishing adapter is enabled in the next stage after platform approval."
      : p === "TIKTOK"
        ? "Not connected. Needs a TikTok developer app with the Content Posting API and a passed audit (unaudited apps can only post privately)."
        : "Not connected. Needs a Meta app with Page/Instagram publishing permissions approved through App Review.",
  }));
}
