import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      // Copies static PWA assets (manifest.json, sw.js, raw vanilla scripts/styles, and src/assets)
      // into dist/ so both Vite dev and production builds resolve all relative URLs cleanly.
      {
        name: 'copy-pwa-static-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) {
            return;
          }

          for (const file of ['manifest.json', 'sw.js', 'styles.css', 'fit-parser.js', 'app.js']) {
            const srcFile = path.resolve(__dirname, file);
            if (fs.existsSync(srcFile)) {
              fs.copyFileSync(srcFile, path.resolve(distDir, file));
            }
          }

          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
