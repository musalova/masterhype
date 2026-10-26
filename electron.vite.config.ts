import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { browserslistToTargets } from 'lightningcss';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
    },
    // Android WebView può essere datato (Chrome 91 = Android 12):
    // lightningcss abbassa @layer/color-mix/oklch, esbuild il JS a ES2020.
    css: {
      transformer: 'lightningcss',
      lightningcss: { targets: browserslistToTargets(['chrome 91', 'electron 33']) },
    },
    // minify esplicito: electron-vite lo spegne di default nel renderer
    // (pensato per un'app che legge da disco locale), ma questo bundle viene
    // anche servito via Wi-Fi ai telefoni e impacchettato nell'APK — 3.5MB di
    // JS non minificato da parsare a ogni avvio su WebView di fascia bassa.
    build: { target: 'es2020', cssMinify: 'lightningcss', minify: 'esbuild' },
  },
});
