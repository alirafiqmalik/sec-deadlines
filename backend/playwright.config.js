import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "popup.spec.js",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:48763/sec-deadlines/",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "python3 ../scripts/preview_venues.py",
    url: "http://127.0.0.1:48763/sec-deadlines/",
    timeout: 30000,
  },
});
