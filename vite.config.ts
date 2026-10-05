/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base: one build has to work from Electron's file:// window AND
  // from the /Coineda/ subpath on GitHub Pages. Combined with HashRouter this
  // means no server-side rewrites are ever needed.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
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
  },
});
