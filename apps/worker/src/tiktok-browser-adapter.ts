import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { PublishTask } from "@video-combine/shared";
import type { PublishAdapterResult, PublisherAdapter } from "./publisher-adapter";

export const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video";
const MAX_TIKTOK_TAGS = 8;

export interface TikTokAutomation {
  publish(task: PublishTask): Promise<PublishAdapterResult>;
  saveDraft(task: PublishTask): Promise<PublishAdapterResult>;
}

export class TikTokBrowserAdapter implements PublisherAdapter {
  constructor(private readonly automation: TikTokAutomation = new PlaywrightTikTokAutomation()) {}

  publish(task: PublishTask): Promise<PublishAdapterResult> {
    return this.automation.publish(task);
  }

  saveDraft(task: PublishTask): Promise<PublishAdapterResult> {
    return this.automation.saveDraft(task);
  }
}

class PlaywrightTikTokAutomation implements TikTokAutomation {
  async publish(task: PublishTask): Promise<PublishAdapterResult> {
    return this.run(task, "publish");
  }

  async saveDraft(task: PublishTask): Promise<PublishAdapterResult> {
    return this.run(task, "save-draft");
  }

  private async run(task: PublishTask, mode: "publish" | "save-draft"): Promise<PublishAdapterResult> {
    let context: BrowserContext | undefined;
    let keepBrowserOpen = false;
    const screenshotPath = path.resolve(
      process.cwd(),
      "storage",
      "screenshots",
      `${task.id}-tiktok-${mode}.png`
    );

    try {
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await mkdir(profileDir(), { recursive: true });

      const executablePath = chromiumExecutablePath();
      const proxyServer = resolveTikTokProxyServer();
      context = await chromium.launchPersistentContext(profileDir(), {
        headless: false,
        viewport: { width: 1440, height: 960 },
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
        ...(executablePath ? { executablePath } : {})
      });
      const page = context.pages()[0] ?? (await context.newPage());
      await openUploadPage(page);

      if (await needsLogin(page)) {
        const savedScreenshotPath = await saveScreenshot(page, screenshotPath);
        keepBrowserOpen = true;
        return {
          status: "NEED_LOGIN",
          externalUrl: TIKTOK_UPLOAD_URL,
          ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
          errorMessage:
            "TikTok upload page did not show an authenticated session. Log in in the opened browser window, then retry publishing or saving a draft."
        };
      }

      await dismissTikTokGuidance(page);
      await uploadTikTokVideo(page, task.sourceVideoPath);
      await dismissTikTokGuidance(page);
      await fillTikTokCaption(page, buildTikTokCaption(task));
      await dismissTikTokGuidance(page);
      await waitForUploadReady(page);
      await dismissTikTokGuidance(page);

      const blockingError = await readTikTokBlockingError(page);
      if (blockingError) {
        const savedScreenshotPath = await saveScreenshot(page, screenshotPath);
        keepBrowserOpen = true;
        return {
          status: "NEED_MANUAL_ACTION",
          externalUrl: TIKTOK_UPLOAD_URL,
          ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
          errorMessage: blockingError
        };
      }

      const clicked = mode === "publish" ? await clickPost(page) : await clickSaveDraft(page);
      const savedScreenshotPath = await saveScreenshot(page, screenshotPath);
      if (mode === "save-draft") {
        await handleSaveDraftDialog(page);
      }

      if (!clicked) {
        keepBrowserOpen = true;
        return {
          status: "NEED_MANUAL_ACTION",
          externalUrl: TIKTOK_UPLOAD_URL,
          ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
          errorMessage:
            mode === "publish"
              ? "TikTok page was filled, but the Post button was not found. Confirm submission manually in the opened browser window."
              : "TikTok page was filled, but the Save draft button was not found. Confirm draft saving manually in the opened browser window."
        };
      }

      if (mode === "publish") {
        await handleContinueToPostDialog(page);
      }

      const confirmed = await waitForActionConfirmation(page, mode);
      if (!confirmed) {
        keepBrowserOpen = true;
        return {
          status: "NEED_MANUAL_ACTION",
          externalUrl: TIKTOK_UPLOAD_URL,
          ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
          errorMessage:
            mode === "publish"
              ? "TikTok Post was clicked, but no success confirmation was detected. Confirm the page result in the opened browser window."
              : "TikTok Save draft was clicked, but no success confirmation was detected. Confirm the draft result in the opened browser window."
        };
      }

      return mode === "publish"
        ? {
            status: "WAITING_REVIEW",
            externalUrl: TIKTOK_UPLOAD_URL,
            ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
            errorMessage: "TikTok publish action was submitted. Use the final platform page state as the source of truth."
          }
        : {
            status: "SAVED_DRAFT",
            externalUrl: TIKTOK_UPLOAD_URL,
            ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
            errorMessage: "TikTok draft save action was submitted."
          };
    } catch (error) {
      const savedScreenshotPath = context?.pages()[0]
        ? await saveScreenshot(context.pages()[0]!, screenshotPath)
        : undefined;
      const errorMessage = error instanceof Error ? error.message : "TikTok browser automation failed";
      if (errorMessage.includes("TikTok video upload did not finish") || isTikTokNavigationFailure(errorMessage)) {
        keepBrowserOpen = true;
      }
      return {
        status: "NEED_MANUAL_ACTION",
        externalUrl: TIKTOK_UPLOAD_URL,
        ...(savedScreenshotPath ? { lastScreenshotPath: savedScreenshotPath } : {}),
        errorMessage: errorMessage.includes("ProcessSingleton")
          ? "A TikTok automation browser window is already open. The same browser profile cannot run concurrently. Close the opened TikTok automation window, then retry saving a draft or publishing."
          : isTikTokNavigationFailure(errorMessage)
            ? `This environment cannot open the TikTok upload page; ${TIKTOK_UPLOAD_URL} timed out. Confirm local network, proxy, or DNS access to TikTok, then retry saving a draft or publishing.`
            : errorMessage
      };
    } finally {
      if (!keepBrowserOpen) {
        await context?.close().catch(() => undefined);
      }
    }
  }
}

function chromiumExecutablePath(): string | undefined {
  const configuredPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (configuredPath) {
    return configuredPath;
  }

  return existsSync("/usr/bin/chromium-browser") ? "/usr/bin/chromium-browser" : undefined;
}

function profileDir(): string {
  return path.resolve(process.cwd(), "storage", "browser-profiles", "tiktok");
}

function resolveTikTokProxyServer(): string | undefined {
  return normalizeTikTokProxyServer(
    process.env.TIKTOK_PROXY_SERVER ??
      process.env.PLAYWRIGHT_PROXY_SERVER ??
      process.env.HTTPS_PROXY ??
      process.env.HTTP_PROXY
  );
}

export function normalizeTikTokProxyServer(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

async function openUploadPage(page: Page): Promise<void> {
  await pointBlankPageAtUploadUrl(page);

  await page
    .goto(TIKTOK_UPLOAD_URL, { waitUntil: "commit", timeout: 15_000 })
    .catch(() => undefined);

  const pageReady = await page
    .waitForFunction(
      () =>
        Boolean(document.querySelector("input[type='file']")) ||
        document.body.innerText.includes("Log in") ||
        document.body.innerText.includes("Select video"),
      undefined,
      { timeout: 60_000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!pageReady) {
    throw new Error(`TikTok upload page did not become ready. Current URL: ${page.url()}`);
  }
}

async function saveScreenshot(page: Page, screenshotPath: string): Promise<string | undefined> {
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10_000 });
    return screenshotPath;
  } catch {
    return undefined;
  }
}

async function pointBlankPageAtUploadUrl(page: Page): Promise<void> {
  if (page.url() !== "about:blank") {
    return;
  }

  await page
    .evaluate((url) => {
      window.location.href = url;
    }, TIKTOK_UPLOAD_URL)
    .catch(() => undefined);
  await page.waitForTimeout(1000);
}

export function isTikTokNavigationFailure(errorMessage: string): boolean {
  return (
    errorMessage.includes("tiktok.com") &&
    (errorMessage.includes("page.goto") ||
      errorMessage.includes("Timeout") ||
      errorMessage.includes("ERR_ABORTED") ||
      errorMessage.includes("did not become ready"))
  );
}

async function needsLogin(page: Page): Promise<boolean> {
  if (page.url().includes("/login")) {
    return true;
  }

  const fileInputs = await page.locator("input[type='file']").count().catch(() => 0);
  if (fileInputs > 0) {
    return false;
  }

  const loginText = await page.getByText(/Log in|Login/).count().catch(() => 0);
  return loginText > 0;
}

async function uploadTikTokVideo(page: Page, sourceVideoPath: string): Promise<void> {
  if (!sourceVideoPath) {
    throw new Error("TikTok publishing requires a local video file.");
  }

  const absoluteVideoPath = path.resolve(sourceVideoPath);
  if (!existsSync(absoluteVideoPath)) {
    throw new Error(`TikTok video file does not exist: ${absoluteVideoPath}`);
  }

  const fileInput = page.locator("input[type='file']").first();
  await fileInput.waitFor({ state: "attached", timeout: 60_000 });
  await fileInput.setInputFiles(absoluteVideoPath, { timeout: 10_000 });
  await waitForEditor(page);
}

async function waitForEditor(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return (
        Boolean(document.querySelector("[contenteditable='true']")) ||
        text.includes("Caption") ||
        text.includes("Post") ||
        text.includes("Save draft")
      );
    },
    undefined,
    { timeout: 180_000 }
  );
}

async function fillTikTokCaption(page: Page, value: string): Promise<void> {
  if (!value.trim()) {
    return;
  }

  const editor = page.locator("[contenteditable='true']").first();
  await editor.waitFor({ state: "visible", timeout: 60_000 });
  await editor.click({ timeout: 10_000 });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(value, { delay: 5 });
}

async function waitForUploadReady(page: Page): Promise<void> {
  const ready = await page
    .waitForFunction(
    () => {
      const text = document.body.innerText;
      const hasEnabledSubmitAction = Array.from(document.querySelectorAll("button")).some((button) => {
        const label = button.innerText.trim();
        const isSubmitAction =
          /^(Post|Publish|Save draft|Save as draft)$/i.test(label) ||
          label === "\u53d1\u5e03" ||
          label === "\u4fdd\u5b58\u8349\u7a3f";
        const ariaDisabled = button.getAttribute("aria-disabled") === "true";
        const className = String(button.getAttribute("class") ?? "").toLowerCase();
        const visuallyDisabled = className.includes("disabled") || getComputedStyle(button).pointerEvents === "none";
        return isSubmitAction && !button.disabled && !ariaDisabled && !visuallyDisabled;
      });

      const uploadInProgress =
        /(\d+(?:\.\d+)?\s*%)|(\d+(?:\.\d+)?\s*MB\s*\/\s*\d+(?:\.\d+)?\s*MB)|remaining|uploading|processing|\u8fd8\u5269|\u4e0a\u4f20\u4e2d|\u5904\u7406\u4e2d/i.test(
          text
        );

      return hasEnabledSubmitAction && !uploadInProgress;
    },
    undefined,
    { timeout: 300_000 }
  )
    .then(() => true)
    .catch(() => false);

  if (!ready) {
    throw new Error(
      "TikTok video upload did not finish before the timeout. Keep the browser open until upload reaches 100%, then retry saving a draft or publishing."
    );
  }
}

async function readTikTokBlockingError(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const lowerText = bodyText.toLowerCase();
  if (lowerText.includes("couldn't upload") || lowerText.includes("upload failed")) {
    return "TikTok video upload failed. Check the platform message in the opened browser window, then choose the video again and retry.";
  }
  if (lowerText.includes("unsupported")) {
    return "TikTok rejected the current video file format or parameters. Confirm the video codec, duration, aspect ratio, and size meet platform requirements.";
  }
  if (bodyText.includes("Please try again later")) {
    return "TikTok says to try again later. Check the account or risk-control state in the opened browser window.";
  }

  return null;
}

async function clickPost(page: Page): Promise<boolean> {
  return clickByText(page, [/^Post$/i, /Publish/i]);
}

async function clickSaveDraft(page: Page): Promise<boolean> {
  return clickByText(page, [/Save draft/i, /Save as draft/i]);
}

async function dismissTikTokGuidance(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pageText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    const clickedTextButton = isTikTokGuidanceDialogText(pageText)
      ? await clickByText(page, [
          /^Got it$/i,
          /^Skip$/i,
          /^Next$/i,
          /^Done$/i,
          /^Not now$/i,
          /^Maybe later$/i,
          /^Start$/i,
          /^I understand$/i,
          /^\u6211\u77e5\u9053\u4e86$/,
          /^\u77e5\u9053\u4e86$/,
          /^\u8df3\u8fc7$/,
          /^\u4e0b\u4e00\u6b65$/,
          /^\u5b8c\u6210$/,
          /^\u7a0d\u540e$/
        ])
      : false;
    const clickedCloseButton = clickedTextButton ? false : await clickCloseLikeButton(page);
    if (!clickedTextButton && !clickedCloseButton) {
      return;
    }
    await page.waitForTimeout(500);
  }
}

async function clickCloseLikeButton(page: Page): Promise<boolean> {
  for (const selector of [
    "button[aria-label='Close']",
    "button[aria-label='close']",
    "button[aria-label*='Close']",
    "button[aria-label*='close']"
  ]) {
    const locator = page.locator(selector).last();
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    await locator.click({ timeout: 2000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function handleSaveDraftDialog(page: Page): Promise<boolean> {
  const hasDialog = await page
    .waitForFunction(() => {
      return /Save draft\?|saved as a draft|discard.*changes|keep editing/i.test(document.body.innerText);
    }, undefined, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!hasDialog) {
    return false;
  }

  const clicked = await clickByText(page, [/^Save draft$/i, /^Confirm$/i, /^OK$/i, /^Yes$/i]);
  if (clicked) {
    await page.waitForTimeout(1000);
  }
  return clicked;
}

async function handleContinueToPostDialog(page: Page): Promise<boolean> {
  const hasDialog = await page
    .waitForFunction(() => {
      return /Continue to post\?|copyright check is incomplete|Post now/i.test(document.body.innerText);
    }, undefined, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!hasDialog) {
    return false;
  }

  const clicked = await clickByText(page, [/^Post now$/i]);
  if (clicked) {
    await page.waitForTimeout(1000);
  }
  return clicked;
}

async function waitForActionConfirmation(page: Page, mode: "publish" | "save-draft"): Promise<boolean> {
  const successPatterns =
    mode === "publish"
      ? ["Your video is being uploaded", "Your video has been posted", "posted"]
      : ["Draft saved", "Saved to drafts"];

  await page.waitForTimeout(1000);
  return page
    .waitForFunction(
      ({ patterns, actionMode }) => {
        const text = document.body.innerText;
        const url = location.href;
        if (patterns.some((pattern) => text.includes(pattern))) {
          return true;
        }
        if (actionMode === "save-draft") {
          return url.includes("draft") || url.includes("creator-center");
        }
        return url.includes("creator-center") || url.includes("content");
      },
      { patterns: successPatterns, actionMode: mode },
      { timeout: 15_000 }
    )
    .then(() => true)
    .catch(() => false);
}

async function clickByText(page: Page, labels: RegExp[]): Promise<boolean> {
  for (const label of labels) {
    const locator = page.getByText(label).last();
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    await locator.click({ timeout: 5000 });
    return true;
  }
  return false;
}

export function buildTikTokCaption(task: Pick<PublishTask, "title" | "description" | "tags">): string {
  const parts = [task.title.trim(), task.description.trim()].filter(Boolean);
  const tags = normalizeTikTokTags(task.tags);
  if (tags.length > 0) {
    parts.push(tags.map((tag) => `#${tag}`).join(" "));
  }
  return parts.join("\n\n");
}

export function normalizeTikTokTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const value = tag.replace(/^#+/, "").replace(/\s+/g, "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= MAX_TIKTOK_TAGS) {
      break;
    }
  }

  return normalized;
}

export function isTikTokUploadComplete(pageText: string, hasEnabledSubmitAction: boolean): boolean {
  return hasEnabledSubmitAction && !isTikTokUploadInProgress(pageText);
}

export function isTikTokContinueToPostDialogText(pageText: string): boolean {
  return /Continue to post\?|copyright check is incomplete|Post now/i.test(pageText);
}

export function isTikTokGuidanceDialogText(pageText: string): boolean {
  return /Welcome to TikTok Studio|quick tour|new feature|creator tools|Got it|Maybe later|\u65b0\u624b|\u5f15\u5bfc|\u77e5\u9053\u4e86|\u8df3\u8fc7|\u4e0b\u4e00\u6b65/i.test(
    pageText
  );
}

export function isTikTokSaveDraftDialogText(pageText: string): boolean {
  return /Save draft\?|saved as a draft|discard.*changes|keep editing/i.test(pageText);
}

function isTikTokUploadInProgress(pageText: string): boolean {
  return /(\d+(?:\.\d+)?\s*%)|(\d+(?:\.\d+)?\s*MB\s*\/\s*\d+(?:\.\d+)?\s*MB)|remaining|uploading|processing|\u8fd8\u5269|\u4e0a\u4f20\u4e2d|\u5904\u7406\u4e2d/i.test(
    pageText
  );
}
