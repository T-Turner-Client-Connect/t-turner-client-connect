import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TTurner Client Connect", template: "%s · TTurner Client Connect" },
  description: "Private client relationship manager for T. Turner & Associates, LLC.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#001452", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
