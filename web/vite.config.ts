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
