import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";

// 两页：index.html 宠物窗（vanilla），client.html 主客户端（React）
export default defineConfig({
  // 发布时不扫描 public，防止把开发机的形象、Core 等私有素材嵌入 exe。
  publicDir: process.env.DESK_RELEASE === "1" ? false : "public",
  clearScreen: false,
  plugins: [react(), {
    name: "release-startup-script",
    writeBundle() {
      if (process.env.DESK_RELEASE === "1") copyFileSync(resolve(__dirname, "public/startup.js"), resolve(__dirname, "dist/startup.js"));
    },
  }],
  server: {
    port: 5180,
    strictPort: true,
    // 调试页直接读技能原文，避免再抄一份对照表。
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      input: {
        pet: resolve(__dirname, "index.html"),
        client: resolve(__dirname, "client.html"),
        petChat: resolve(__dirname, "pet-chat.html"),
      },
    },
  },
});
