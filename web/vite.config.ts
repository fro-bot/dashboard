import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import {defineConfig} from 'vite'
import {VitePWA} from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Use injectManifest so we can ship a custom SW with the deny-by-default
      // fetch router (required for the stale-signal Workbox plugin in Unit 3).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',

      // Keep the hand-written web/public/manifest.webmanifest — do NOT generate one.
      // The <link rel="manifest"> stays in web/index.html (already present).
      manifest: false,

      // registerType omitted → defaults to 'prompt' (never silently reload).

      injectManifest: {
        // Exclude the SW itself and the manifest from the precache list.
        // The default globPatterns cover hashed JS/CSS/assets in web/dist.
        globIgnores: ['**/sw.js', '**/manifest.webmanifest', '**/registerSW.js'],

        // Rewrite the precache manifest entry for index.html → '/' so that
        // Workbox's install-time fetch hits GET / (which the Hono server serves
        // at 200) instead of GET /index.html (which has no route and 404s,
        // causing the SW to go redundant and never register).
        //
        // createHandlerBoundToURL in sw.ts MUST reference the same URL ('/').
        manifestTransforms: [
          (entries) => {
            const manifest = entries.map((entry) =>
              entry.url === 'index.html' ? {...entry, url: '/'} : entry,
            )
            return {manifest, warnings: []}
          },
        ],
      },
    }),
  ],
  root: '.',
  build: {
    outDir: 'dist',
    // Vite's default output uses hashed filenames for assets.
    // No inline scripts are emitted by default — all JS is external chunks
    // referenced via <script type="module" src="..."> tags, satisfying CSP.
    rollupOptions: {
      output: {
        // Ensure JS chunks use content-hash filenames
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
