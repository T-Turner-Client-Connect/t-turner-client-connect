import type { SocialPlatform } from "@prisma/client";
import { PLATFORM_LABELS, validPermalink } from "@/lib/social/rules";
import { ValidationError } from "./clients";

export function validatePermalinkOrThrow(platform: SocialPlatform, url: string) {
  if (!validPermalink(platform, url.trim())) throw new ValidationError(`Paste the https link to the live ${PLATFORM_LABELS[platform]} post.`);
}
