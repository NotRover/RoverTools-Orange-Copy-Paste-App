import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,

  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // 4. Multi-page app: one entry per window
  build: {
    rollupOptions: {
      input: {
        // Main clipboard-history window
        main: path.resolve(__dirname, "src/components/app/index.html"),
        // Copy-confirmation popup shown after clipboard capture
        "copy-popup": path.resolve(
          __dirname,
          "src/components/copy-popup/copy-popup.html",
        ),
        // Quick-paste picker popup shown near the cursor
        "paste-popup": path.resolve(
          __dirname,
          "src/components/paste-popup/paste-popup.html",
        ),
        // Notification popup (toast)
        notification: path.resolve(
          __dirname,
          "src/components/notifications/notification.html",
        ),
        // Startup splash screen
        splash: path.resolve(__dirname, "src/components/splash/splash.html"),
      },
    },
  },
}));
