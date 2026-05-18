import type { MetadataRoute } from 'next';

/**
 * PWA web manifest for the cortextOS dashboard.
 *
 * Today: static defaults matching `globals.css :root`. When #9 (per-org
 * overrides) + #10 (white-label env vars) ship, this will read from the
 * branding helper (`dashboard/src/lib/branding.ts`) so PWA install banners
 * + Android home icons + iOS splash colors all track the active brand.
 *
 * Next.js auto-discovers `app/manifest.ts` and serves it at `/manifest.webmanifest`.
 * No `metadata.manifest` reference needed in layout.tsx.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'cortextOS Dashboard',
    short_name: 'cortextOS',
    description: 'cortextOS agent orchestration dashboard',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF', // matches --background (light)
    theme_color: '#B8860B',      // matches --primary (light, gold)
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
