import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Version-skew protection: Netlify sets DEPLOY_ID for every build. When a
  // page from an older deploy talks to a newer one, Next.js reloads the page
  // instead of calling a form action that no longer exists.
  deploymentId: process.env.DEPLOY_ID || undefined,
  // Which Netlify deploy this build is (production, deploy-preview, branch-deploy)
  // and its own address — fixed at build time so the server always knows.
  env: {
    BUILD_CONTEXT: process.env.CONTEXT ?? "",
    BUILD_DEPLOY_URL: process.env.DEPLOY_PRIME_URL ?? "",
  },
  experimental: {
    // Mapped import rows and uploads go through Server Actions (Netlify caps bodies at ~6 MB).
    serverActions: { bodySizeLimit: "6mb" },
  },
  // Old addresses from the first release keep working.
  async redirects() {
    return [
      { source: "/login", destination: "/staff/login", permanent: false },
      { source: "/portal", destination: "/client", permanent: false },
      { source: "/portal/:path*", destination: "/client/:path*", permanent: false },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Nothing in the app should be indexed or cached by shared caches.
      { source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};

export default nextConfig;
