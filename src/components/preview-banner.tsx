import { isPreviewDeploy } from "@/lib/integrations";

/** Shown on Netlify preview sites so nobody mistakes a test copy (with its own data) for the real site. */
export function PreviewBanner() {
  if (!isPreviewDeploy()) return null;
  return (
    <div role="status" className="bg-red-700 px-4 py-2 text-center text-sm font-semibold text-white" data-testid="preview-banner">
      PREVIEW SITE — a test copy with its own separate data. Nothing done here changes the real Client Connect, and emails are not sent. Use client.tturnerassociates.com for real work.
    </div>
  );
}
