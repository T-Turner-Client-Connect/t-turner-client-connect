import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TTurner Client Connect", template: "%s · TTurner Client Connect" },
  description: "Private client relationship manager for T. Turner & Associates, LLC.",
  robots: { index: false, follow: false },
  // Home Screen name on iPhone (otherwise iOS uses the page's title, e.g. "Two-step verification").
  // capable: false keeps the shortcut opening in the normal browser, so sign-in works exactly as today.
  appleWebApp: { title: "Client Connect", capable: false },
  applicationName: "TTurner Client Connect",
};

export const viewport: Viewport = { themeColor: "#0a1a44", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
