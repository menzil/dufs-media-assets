import { expect, test } from "@playwright/test";

test("uploads a file when dufs grants upload permission", async ({ page, request }, testInfo) => {
  const fileName = `upload-${Date.now()}-${testInfo.workerIndex}.txt`;
  const fileBody = "dufs media library upload integration";
  const encodedName = encodeURIComponent(fileName);
  const directory = "%E6%97%85%E8%A1%8C%E7%85%A7%E7%89%87/";
  const uploadedPath = `${directory}${encodedName}`;

  await page.goto(directory);
  try {
    await expect(page.getByTestId("upload-button")).toBeVisible();
    const reload = page.waitForEvent("load");
    await page.getByTestId("upload-input").setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(fileBody, "utf8"),
    });
    await reload;

    await expect(page.locator(`[data-testid="file-row"][data-file-name="${fileName}"]`)).toBeVisible();
    const logEntry = page.locator(`[data-testid="upload-log-entry"][data-file-name="${fileName}"]`);
    await expect(page.getByTestId("upload-log")).toBeVisible();
    await expect(logEntry).toHaveAttribute("data-status", "complete");
    await expect(logEntry).toContainText("Complete");
    await page.screenshot({ path: testInfo.outputPath("upload-log-desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 320, height: 720 });
    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasHorizontalOverflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("upload-log-mobile-320.png") });

    const uploaded = await request.get(uploadedPath);
    expect(uploaded.status()).toBe(200);
    expect(await uploaded.text()).toBe(fileBody);

    await page.getByTestId("clear-upload-log").click();
    await expect(page.getByTestId("upload-log")).toBeHidden();
  } finally {
    const cleanup = await request.delete(uploadedPath);
    expect(cleanup.status()).toBe(204);
  }
});
