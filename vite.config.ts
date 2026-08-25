import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages 部署在 /TrimTail/ 子路径，使用相对 base 保证任意仓库名可用
export default defineConfig({
  base: "./",
  plugins: [react()],
});
