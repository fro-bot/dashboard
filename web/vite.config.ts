import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import {defineConfig} from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
