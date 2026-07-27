import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so every emitted asset URL is relative: the site works unchanged
// from a repo subpath (https://<user>.github.io/halfspace/) or from file://.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Keep DuckDB-WASM and the charting stack out of the critical path:
        // the skeleton must paint before either is parsed.
        advancedChunks: {
          groups: [
            { name: 'duckdb', test: /node_modules[\\/]@duckdb[\\/]/ },
            { name: 'vega', test: /node_modules[\\/]vega/ },
          ],
        },
      },
    },
  },
  worker: { format: 'es' },
});
