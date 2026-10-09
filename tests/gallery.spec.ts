import { expect, type Locator, test } from "@playwright/test";

async function expectVideoFitsViewport(player: Locator): Promise<void> {
  const layout = await player.evaluate((video: HTMLVideoElement) => {
    const dialog = video.closest("dialog");
    if (dialog === null) {
      throw new Error("Video player is not inside a dialog");
    }
    const stage = video.parentElement;
    if (stage === null) {
      throw new Error("Video player does not have a stage container");
    }
    const bounds = video.getBoundingClientRect();
    const stageStyle = window.getComputedStyle(stage);
    return {
      availableHeight: stage.clientHeight
        - Number.parseFloat(stageStyle.paddingTop)
        - Number.parseFloat(stageStyle.paddingBottom),
      bottom: bounds.bottom,
      dialogClientHeight: dialog.clientHeight,
      dialogScrollHeight: dialog.scrollHeight,
      playerHeight: bounds.height,
      top: bounds.top,
      viewportHeight: window.innerHeight,
    };
  });
  expect(Math.abs(layout.playerHeight - layout.availableHeight)).toBeLessThanOrEqual(1);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.dialogScrollHeight).toBeLessThanOrEqual(layout.dialogClientHeight);
}

async function expectImageFillsAvailableHeight(image: Locator): Promise<void> {
  const layout = await image.evaluate((element: HTMLImageElement) => {
    const stage = element.parentElement;
    if (stage === null) {
      throw new Error("Image viewer does not have a stage container");
    }
    const bounds = element.getBoundingClientRect();
    const stageStyle = window.getComputedStyle(stage);
    return {
      availableHeight: stage.clientHeight
        - Number.parseFloat(stageStyle.paddingTop)
        - Number.parseFloat(stageStyle.paddingBottom),
      imageHeight: bounds.height,
    };
  });
  expect(
    Math.abs(layout.imageHeight - layout.availableHeight),
    `Image layout dimensions: ${JSON.stringify(layout)}`,
  ).toBeLessThanOrEqual(1);
}

test("renders a gallery and opens the image viewer", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  await expect(page.getByRole("heading", { name: "旅行照片", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "01 杭州", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Preview /u })).toHaveCount(2);
  await expect(page.getByTestId("upload-button")).toHaveCount(0);

  const firstImage = page.getByRole("img", { name: "山谷 清晨.png" });
  await expect(firstImage).toBeVisible();
  await expect.poll(async () => firstImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  expect(consoleErrors).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath("gallery.png"), fullPage: true });

  await page.getByRole("button", { name: "Preview 山谷 清晨.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("山谷 清晨.png", { exact: true })).toBeVisible();
  const imageActions = viewer.getByTestId("image-viewer-actions");
  await expect(imageActions.getByTestId("current-image-name")).toBeVisible();
  await expect(imageActions.getByTestId("download-current-image")).toBeVisible();
  await expect(imageActions.getByTestId("close-image-viewer")).toBeVisible();
  await expectImageFillsAvailableHeight(viewer.getByRole("img", { name: "山谷 清晨.png" }));

  await page.getByRole("button", { name: "Next image" }).click();
  await expect(viewer.getByText("海岸日落.png", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("viewer.png"), fullPage: true });

  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
});

test("uses the media library name and exposes date sorting", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByTestId("library-title")).toHaveText("Media Library");
  const sort = page.getByRole("combobox", { name: "Sort by" });
  await sort.selectOption("mtime");
  await expect(sort).toHaveValue("mtime");
  await expect(sort.locator('option[value="mtime"]')).toHaveText("Date");
});

test("persists image details in the URL and browser history", async ({ page }) => {
  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  const firstImage = page.locator('[data-testid="image-card"][data-file-name="山谷 清晨.png"]');
  await firstImage.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe("山谷 清晨.png");
  await expect(page.getByTestId("image-viewer")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("image-viewer")).toBeVisible();
  await page.getByTestId("next-image").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe("海岸日落.png");

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBeNull();
  await expect(page.getByTestId("image-viewer")).not.toBeVisible();

  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe("海岸日落.png");
  await expect(page.getByTestId("image-viewer")).toBeVisible();
});

test("loops through images in the current directory", async ({ page }) => {
  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  const imageNames = await page.getByTestId("image-card").evaluateAll((cards: HTMLElement[]) =>
    cards.map((card: HTMLElement) => card.dataset.fileName ?? ""),
  );
  expect(imageNames.length).toBeGreaterThan(1);
  const firstName = imageNames[0] ?? "";
  const secondName = imageNames[1] ?? "";

  await page.getByTestId("loop-images").click();
  const viewer = page.getByTestId("image-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("current-image-name")).toHaveText(firstName);
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe(firstName);

  await expect.poll(
    () => viewer.getByTestId("current-image-name").textContent(),
    { timeout: 7000 },
  ).toBe(secondName);
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe(secondName);
  await expect(viewer.getByText(`2 / ${imageNames.length} · Looping`, { exact: true })).toBeVisible();
});

test("opens a video from a persistent URL and clears it on close", async ({ page }) => {
  const preview = encodeURIComponent("杭州片段.mp4");
  await page.goto(`%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/?preview=${preview}`);

  await expect(page.getByTestId("video-viewer")).toBeVisible();
  await expect.poll(async () => page.getByTestId("video-player").evaluate(
    (video: HTMLVideoElement) => video.readyState,
  )).toBeGreaterThanOrEqual(1);
  await page.getByTestId("close-video-viewer").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBeNull();
  await expect(page.getByTestId("video-viewer")).not.toBeVisible();
});

test("loads and plays a video", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  const playButton = page.locator('[data-testid="video-card"][data-file-name="杭州片段.mp4"]');
  const videoNames = await page.getByTestId("video-card").evaluateAll((cards: HTMLElement[]) =>
    cards.map((card: HTMLElement) => card.dataset.fileName ?? ""),
  );
  const currentIndex = videoNames.indexOf("杭州片段.mp4");
  expect(currentIndex).toBeGreaterThanOrEqual(0);
  const nextName = videoNames[(currentIndex + 1) % videoNames.length] ?? "";
  await expect(playButton).toBeVisible();
  await expect(playButton.getByTestId("video-upload-date")).toBeVisible();
  await expect(playButton.getByTestId("video-upload-date")).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  await expect(playButton.getByTestId("video-upload-date")).toHaveText(/^\d{4}-\d{2}-\d{2}$/u);
  const thumbnail = playButton.getByTestId("video-thumbnail");
  await expect.poll(async () => thumbnail.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => thumbnail.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);

  await playButton.click();
  const playerDialog = page.getByRole("dialog", { name: "Video player" });
  await expect(playerDialog).toBeVisible();
  await expect(playerDialog.getByText("杭州片段.mp4", { exact: true })).toBeVisible();
  await expect(page.getByTestId("previous-video")).toBeVisible();
  await expect(page.getByTestId("next-video")).toBeVisible();

  const downloadBounds = await page.getByTestId("download-current-video").boundingBox();
  const closeBounds = await page.getByTestId("close-video-viewer").boundingBox();
  const titleBounds = await page.getByTestId("current-video-name").boundingBox();
  if (downloadBounds === null || closeBounds === null || titleBounds === null) {
    throw new Error("Video player title, download button, or close button has no measurable layout");
  }
  expect(downloadBounds.x + downloadBounds.width).toBeLessThan(closeBounds.x);
  expect(Math.abs(titleBounds.y - downloadBounds.y)).toBeLessThanOrEqual(14);

  await page.getByTestId("next-video").click();
  await expect(page.getByTestId("current-video-name")).toHaveText(nextName);
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe(nextName);

  const player = page.getByTestId("video-player");
  await expect.poll(async () => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  await expectVideoFitsViewport(player);
  const currentTime = await player.evaluate(async (video: HTMLVideoElement) => {
    await video.play();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    video.pause();
    return video.currentTime;
  });
  expect(currentTime).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("video-player.png") });

  await page.getByRole("button", { name: "Close video player" }).click();
  await expect(playerDialog).not.toBeVisible();
  await expect(player).not.toHaveAttribute("src");
});

test("loops through the videos in the current directory", async ({ page }) => {
  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  const videoNames = await page.getByTestId("video-card").evaluateAll((cards: HTMLElement[]) =>
    cards.map((card: HTMLElement) => card.dataset.fileName ?? ""),
  );
  expect(videoNames.length).toBeGreaterThan(1);
  const firstName = videoNames[0] ?? "";
  const secondName = videoNames[1] ?? "";

  await page.getByTestId("loop-videos").click();
  const viewer = page.getByTestId("video-viewer");
  const player = page.getByTestId("video-player");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText(firstName, { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe(firstName);

  await player.dispatchEvent("ended");
  await expect(viewer.getByText(secondName, { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("preview")).toBe(secondName);
  await expect(viewer.getByText(`2 / ${videoNames.length} · Looping`, { exact: true })).toBeVisible();

  await page.getByTestId("previous-video").click();
  await expect(viewer.getByText(firstName, { exact: true })).toBeVisible();
});

test("shows the complete portrait video without scrolling", async ({ page }, testInfo) => {
  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  const playButton = page.locator('[data-testid="video-card"][data-file-name="竖屏片段.mp4"]');
  await playButton.click();

  const player = page.getByTestId("video-player");
  await expect.poll(async () => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  const dimensions = await player.evaluate((video: HTMLVideoElement) => ({
    height: video.videoHeight,
    width: video.videoWidth,
  }));
  expect(dimensions).toEqual({ height: 640, width: 360 });
  await expectVideoFitsViewport(player);
  await page.screenshot({ path: testInfo.outputPath("portrait-video-player.png") });
});

test("loads a Chrome-compatible MOV despite QuickTime MIME feature detection", async ({ page }, testInfo) => {
  await page.goto("%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/");

  const quickTimeSupport = await page.evaluate(() => document.createElement("video").canPlayType("video/quicktime"));
  expect(quickTimeSupport).toBe("");

  const playButton = page.locator('[data-testid="video-card"][data-file-name="Chrome兼容片段.mov"]');
  const thumbnail = playButton.getByTestId("video-thumbnail");
  await expect.poll(async () => thumbnail.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => thumbnail.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);

  await playButton.click();
  const player = page.getByTestId("video-player");
  await expect.poll(async () => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  const currentTime = await player.evaluate(async (video: HTMLVideoElement) => {
    await video.play();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    video.pause();
    return video.currentTime;
  });
  expect(currentTime).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("mov-player.png") });
});
