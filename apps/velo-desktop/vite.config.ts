import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@xterm") || id.includes("xterm")) {
              return "vendor-xterm";
            }
            if (id.includes("lucide-react")) {
              return "vendor-icons";
            }
            if (id.includes("react") || id.includes("scheduler")) {
              return "vendor-react";
            }
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
});
