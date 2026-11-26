import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Configuration locale : plus aucune dépendance à l'outillage Emergent
// (@emergentbase/visual-edits, @emergentbase/overlay) ni au proxy de leur preview.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // lucide 1.x dropped brand logos; src/lib/lucide-react.tsx restores them on top of the real package.
      { find: /^lucide-react$/, replacement: path.resolve(__dirname, "./src/lib/lucide-react.tsx") },
      { find: "lucide-react-upstream", replacement: path.resolve(__dirname, "./node_modules/lucide-react") },
    ],
  },
  // Dépendances pré-groupées : évite un re-optimize en plein démarrage.
  optimizeDeps: {
    include: [
      "@base-ui/react/button",
      "@base-ui/react/checkbox",
      "@base-ui/react/dialog",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/merge-props",
      "@base-ui/react/popover",
      "@base-ui/react/select",
      "@base-ui/react/tabs",
      "@base-ui/react/use-render",
      "@tanstack/react-query",
      "class-variance-authority",
      "clsx",
      "@icons-pack/react-simple-icons",
      "lucide-react-upstream",
      "motion/react",
      "react",
      "react-dom/client",
      "react-router-dom",
      "sonner",
      "tailwind-merge",
    ],
  },
  server: {
    port: 5173,
    // Le front appelle toujours /api/* en relatif ; en dev Vite relaie vers FastAPI.
    proxy: {
      "/api": { target: "http://127.0.0.1:8001", changeOrigin: true },
    },
  },
});
