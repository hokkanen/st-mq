export default {
  root: 'chart', // Sets the project root to the 'chart' directory
  server: {
    host: '0.0.0.0', // Equivalent to --host 0.0.0.0
    port: 1234, // Equivalent to --port 1234 for dev server
    allowedHosts: true, // Disables host checking to allow custom domain names
  },
  preview: {
    host: '0.0.0.0', // Equivalent to --host 0.0.0.0 for preview
    port: 12345, // Equivalent to --port 12345 for preview
    allowedHosts: true, // Disables host checking to allow custom domain names
  },
  build: {
    outDir: '../dist', // Outputs build to the parent directory's dist folder (relative to root)
    emptyOutDir: true, // Clears the output directory before building
  },
};
