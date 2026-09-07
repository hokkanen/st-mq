import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const themeSource = fs.readFileSync(resolve(__dirname, 'chart/theme.js'), 'utf8');
const themeFile = `theme-${createHash('sha256').update(themeSource).digest('hex').slice(0, 12)}.js`;

export default defineConfig({
  root: resolve(__dirname, 'chart'), // Absolute path to the root dir
  plugins: [{
    name: 'early-theme-bootstrap',
    // A classic external script runs before CSS and obeys the server's strict
    // CSP. Emit it unchanged instead of deferring it with the dashboard module.
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: themeFile, source: themeSource });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        return context.server ? html : html.replace('src="/theme.js"', `src="/${themeFile}"`);
      },
    },
  }],
  server: {
    host: '0.0.0.0', // Allow LAN access
    port: 1212,
    proxy: { '/api': 'http://127.0.0.1:1234' },
    fs: {
      allow: (() => { // Redefine accessible folders due to HASSIO symlink to outside dir
        const allow = [
          resolve(__dirname, 'chart'), // Root path (needed because this list overwrites defaults)
        ];
        const sharePath = resolve(__dirname, 'share');
        if (fs.existsSync(sharePath) && fs.lstatSync(sharePath).isSymbolicLink()) {
          allow.push(resolve(__dirname, '..', 'share', 'st-mq')); // HASSIO path behind symlink to outside dir
        } else {
          allow.push(resolve(__dirname, 'share', 'st-mq')); // Standard path (needed because this list overwrites defaults)
        }
        return allow;
      })(),
    },
  },
  preview: {
    host: '0.0.0.0', // Allow LAN access
    port: 1234,
  },
  build: {
    outDir: resolve(__dirname, 'dist'), // Set build directory
    emptyOutDir: true, // Clean build directory before building
    rollupOptions: {
      output: { // Fresh HTML must load matching assets after an upgrade.
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
});
