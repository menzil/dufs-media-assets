import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  webServer: [
    {
      command: "cargo run --manifest-path dufs/Cargo.toml -- tests/fixtures/data --assets dist -p 5097",
      url: "http://127.0.0.1:5097/__dufs__/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "cargo run --manifest-path dufs/Cargo.toml -- tests/fixtures/data --assets dist --path-prefix files -p 5098",
      url: "http://127.0.0.1:5098/files/__dufs__/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "cargo run --manifest-path dufs/Cargo.toml -- tests/fixtures/data --assets dist -A -p 5099",
      url: "http://127.0.0.1:5099/__dufs__/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  use: {
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /upload\.spec\.ts/u,
      use: {
        baseURL: "http://127.0.0.1:5097/",
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "mobile",
      testIgnore: /upload\.spec\.ts/u,
      use: {
        baseURL: "http://127.0.0.1:5097/",
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-320",
      testIgnore: /upload\.spec\.ts/u,
      use: {
        baseURL: "http://127.0.0.1:5097/",
        viewport: { width: 320, height: 720 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "path-prefix",
      testIgnore: /upload\.spec\.ts/u,
      use: {
        baseURL: "http://127.0.0.1:5098/files/",
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "upload",
      testMatch: /upload\.spec\.ts/u,
      use: {
        baseURL: "http://127.0.0.1:5099/",
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
