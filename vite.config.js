import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'chart'), // Absolute path to the root dir
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
      output: { // Disable file name hashing to prevent breaking update fetches
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
