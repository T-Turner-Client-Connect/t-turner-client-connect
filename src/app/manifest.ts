import type { MetadataRoute } from "next";

/**
 * Web app manifest (Android "Add to Home screen" / "Install"). The Home Screen label is
 * `short_name`; the full name stays "TTurner Client Connect". display "browser" opens the
 * shortcut in the normal browser, so sign-in and sessions work exactly as on the website.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TTurner Client Connect",
    short_name: "Client Connect",
    description: "Private client portal for T. Turner & Associates, LLC.",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: "#ffffff",
    theme_color: "#0a1a44",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
