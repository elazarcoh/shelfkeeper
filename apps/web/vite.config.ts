import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { joinBase, normalizeBase } from './src/lib/base-path'

// BASE_PATH (e.g. /mylibrary) serves the app under that URL prefix; unset, it is served at the root.
const base = normalizeBase(process.env.BASE_PATH)
const escapedBase = base.replace(/[.]/g, '\\.')
const proxied = ['/trpc', '/media', '/admin/backups/upload', '/admin/backups/file', '/maintenance']

export default defineConfig({
  base,
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'My Library',
        short_name: 'Library',
        theme_color: '#18181b',
        background_color: '#18181b',
        display: 'standalone',
        // Android wants PNGs to offer "Install"; the share sheet then lists the app (#54)
        icons: [
          { src: joinBase(base, '/icon.svg'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: joinBase(base, '/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: joinBase(base, '/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: joinBase(base, '/icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // a shared link or text opens Add from shelf, which reads it (features/shelf/share-target.ts)
        share_target: { action: joinBase(base, '/books/shelf'), method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
      },
      workbox: {
        navigateFallbackDenylist: ['trpc', 'health', 'media', 'maintenance', 'admin/backups/(file|upload)'].map((p) => new RegExp(`^${escapedBase}${p}`)),
        // covers this phone has shown stay for the offline copy (#62); online, a changed picture still comes in behind the cached one
        runtimeCaching: [
          {
            urlPattern: new RegExp(`${escapedBase}media/`),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'covers', expiration: { maxEntries: 3000, maxAgeSeconds: 180 * 24 * 60 * 60 }, cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // the server (run with the same BASE_PATH) accepts the prefixed paths as they are
    proxy: Object.fromEntries(proxied.map((p) => [joinBase(base, p), 'http://localhost:3000'])),
  },
})
