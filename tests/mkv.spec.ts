import { expect, test } from "@playwright/test";

test("streams MKV audio and video through Mediabunny and seeks in both directions", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const rangeResponses: number[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "fetch"
      && decodeURIComponent(new URL(response.url()).pathname).endsWith("流式片段.mkv")) {
      rangeResponses.push(response.status());
    }
  });
  await page.goto("MKV/");
  await page.locator('[data-testid="video-card"][data-file-name="流式片段.mkv"]').click();
  const player = page.getByTestId("video-player");
  await expect(player).toHaveAttribute("src", /^blob:/u);
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  const metadata = await player.evaluate((video: HTMLVideoElement) => ({
    duration: video.duration,
    width: video.videoWidth,
    bufferedEnd: video.buffered.end(video.buffered.length - 1),
  }));
  expect(metadata.duration).toBeGreaterThan(64);
  expect(metadata.width).toBe(160);
  expect(metadata.bufferedEnd).toBeLessThan(30);
  await player.evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  await expect.poll(() => player.evaluate(
    (video: HTMLVideoElement & { webkitAudioDecodedByteCount: number }) => video.webkitAudioDecodedByteCount,
  )).toBeGreaterThan(0);

  await player.evaluate((video: HTMLVideoElement) => { video.currentTime = 45; });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) =>
    !video.seeking && video.readyState >= 2 && video.currentTime >= 45,
  )).toBe(true);
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.buffered.start(0))).toBeGreaterThan(30);

  await player.evaluate((video: HTMLVideoElement) => { video.currentTime = 3; });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) =>
    !video.seeking && video.readyState >= 2 && video.currentTime >= 3 && video.currentTime < 10,
  )).toBe(true);
  expect(rangeResponses.length).toBeGreaterThan(0);
  expect(rangeResponses.every((status: number) => status === 206)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("mkv-player.png") });
});

test("keeps playback and download available after an MKV thumbnail fails", async ({ page }) => {
  await page.goto("MKV/");
  const card = page.locator('[data-testid="video-card"][data-file-name="不支持编码.mkv"]');
  await expect.poll(() => card.evaluate((button: HTMLElement) =>
    button.closest("figure")?.classList.contains("is-broken"),
  )).toBe(true);
  await expect(card.getByTestId("video-play-action")).toBeVisible();
  await expect(card).toBeEnabled();
  await card.click();
  await expect(page.getByTestId("video-viewer")).toBeVisible();
  await expect(page.getByTestId("video-error")).toBeVisible();
  await expect(page.getByTestId("video-error")).toContainText("unrecognized codec");
  const download = page.getByTestId("download-current-video");
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute("download", "不支持编码.mkv");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  expect(file.suggestedFilename()).toBe("不支持编码.mkv");
  expect(await file.failure()).toBeNull();
});

test("reports mismatched MKV track lengths instead of stalling playback", async ({ page }) => {
  await page.goto("MKV/");
  await page.locator('[data-testid="video-card"][data-file-name="音轨提前结束.mkv"]').click();
  await expect(page.getByTestId("video-error")).toBeVisible();
  await expect(page.getByTestId("video-error")).toContainText("tracks end more than 20 seconds apart");
  await expect(page.getByTestId("download-current-video")).toHaveAttribute("download", "音轨提前结束.mkv");
});

test("cancels MKV loading and plays a long-GOP uppercase MKV without audio", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.goto("MKV/");
  await page.locator('[data-testid="video-card"][data-file-name="流式片段.mkv"]').evaluate(
    (button: HTMLButtonElement) => {
      button.click();
      const close = document.querySelector<HTMLButtonElement>('[data-testid="close-video-viewer"]');
      if (close === null) {
        throw new Error("Missing video close button");
      }
      close.click();
    },
  );
  await expect(page.getByTestId("video-viewer")).not.toBeVisible();
  const card = page.locator('[data-testid="video-card"][data-file-name="无声片段.MKV"]');
  await expect(card.locator("+ figcaption").getByTestId("video-file-link")).toHaveAttribute(
    "href", /%E6%97%A0%E5%A3%B0%E7%89%87%E6%AE%B5\.MKV$/u,
  );
  await card.click();
  const player = page.getByTestId("video-player");
  await expect(player).toHaveAttribute("src", /^blob:/u);
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await player.evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  await player.evaluate((video: HTMLVideoElement) => { video.playbackRate = 16; });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), {
    timeout: 10_000,
    intervals: [100],
  }).toBeGreaterThan(105);
  await player.evaluate((video: HTMLVideoElement) => { video.playbackRate = 1; });
  expect(await player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeLessThan(120);
  expect(await player.evaluate((video: HTMLVideoElement) => video.ended)).toBe(false);
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.buffered.start(0))).toBeGreaterThan(0);
  await page.getByTestId("next-video").click();
  await page.getByTestId("previous-video").click();
  await expect(page.getByTestId("current-video-name")).toHaveText("无声片段.MKV");
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("video-error")).not.toBeVisible();
  await page.getByTestId("close-video-viewer").click();
  await expect(player).not.toHaveAttribute("src");
  expect(errors).toEqual([]);
});
