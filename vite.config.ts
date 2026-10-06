/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * TLS on the dev server, for testing on a real phone over the LAN.
 *
 * `getUserMedia` - the QR scanner in the restore flow - is gated on a
 * secure context, and `http://<lan-ip>:3000` is not one: only localhost
 * gets the exemption, so the camera is blocked on every other device on
 * the network. Vite has no `--https` flag (it was removed in v5); a
 * certificate is required, and this plugin generates and caches a
 * self-signed one.
 *
 * Opt-in rather than always on, because a self-signed certificate costs
 * something: the browser interstitial has to be clicked through on every
 * device, and `npm start` on this machine needs none of it. `npm run
 * dev:expose:https` sets the variable; everything else - plain `vite`,
 * `electron-dev`, the production build, CI - is untouched. (POSIX shell
 * syntax in that script, which is what this repo is developed on.)
 */
const devHttps = process.env.COINEDA_DEV_HTTPS === '1';

export default defineConfig({
  // Relative base: one build has to work from Electron's file:// window AND
  // from the /Coineda/ subpath on GitHub Pages. Combined with HashRouter this
  // means no server-side rewrites are ever needed.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    ...(devHttps ? [basicSsl()] : []),
    VitePWA({
      // autoUpdate + skipWaiting: a returning user must never be pinned to a
      // stale app shell, because there is no in-app update prompt to rescue them.
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.ico',
        'logo.svg',
        'apple-touch-icon.png',
        'logo192.png',
        'logo512.png',
        'maskable512.png',
      ],
      manifest: {
        name: 'Coineda',
        short_name: 'Coineda',
        description:
          'A free, open source, local-running crypto tracking and tax tool',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#03A678',
        background_color: '#ffffff',
        icons: [
          { src: 'logo192.png', type: 'image/png', sizes: '192x192' },
          { src: 'logo512.png', type: 'image/png', sizes: '512x512' },
          {
            // A SEPARATE, full-bleed image for the maskable slot. The
            // rounded tile cannot serve here: Android applies its own mask
            // to a maskable icon, so a pre-rounded one gets its corners cut
            // twice and the mark sits inside a shrunken, double-rounded
            // blob. The App Store export exists for exactly this - art that
            // bleeds past the safe area with no rim of its own.
            src: 'maskable512.png',
            type: 'image/png',
            sizes: '512x512',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        // Scoped to the app shell and its real built assets. The previous
        // '**/*.{js,css,html,ico,png,svg,ttf}' also swept up everything else
        // Vite copies from public/ into the build root - electron.js,
        // icons/{64x64,256x256,512x512,icon}.png (Electron-only) - into the
        // precache for no reason, and duplicated the favicon and app icons,
        // which
        // are already precached once via includeAssets above. Workbox only
        // tolerated that duplication because both copies happened to share
        // the same revision hash.
        globPatterns: ['assets/**/*.{js,css,ttf,woff2,svg}', 'index.html'],
        // CoinGecko is deliberately absent from runtimeCaching. fetchPrice in
        // src/helper/common.js already owns price caching in localStorage, with
        // a 15-minute TTL for spot prices and indefinite retention for
        // historical ones. A second cache with different expiry rules over the
        // same data would produce stale prices no one could explain.
        navigateFallback: 'index.html',
      },
    }),
  ],
  server: {
    // public/electron.js hardcodes http://localhost:3000 and the electron-dev
    // script waits on that port.
    port: 3000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Kept as `build` (not Vite's default `dist`) so electron-builder's
    // files: ["build/**/*"] and .gitignore need no changes.
    outDir: 'build',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    /**
     * Tests run in a NON-UTC timezone on purpose.
     *
     * This app is strict about UTC - a local reading can move an event
     * across a day boundary and, at year end, across a tax year - but on a
     * machine whose own zone is UTC, `getFullYear` and `getUTCFullYear`
     * return the same thing for every input, so a local-time slip is
     * invisible to every test. Pinning a zone with a real offset is what
     * makes that class of bug fail here instead of in somebody's report.
     *
     * New York rather than somewhere ahead of UTC because it is behind it:
     * a timestamp just after midnight UTC on 1 January falls in the
     * PREVIOUS year locally, which is the exact boundary that matters.
     */
    env: { TZ: 'America/New_York' },
  },
});
