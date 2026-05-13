import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { PublishTask } from "@video-combine/shared";
import type { PublishAdapterResult, PublisherAdapter } from "./publisher-adapter";

const BILIBILI_UPLOAD_URL = "https://member.bilibili.com/platform/upload/video/frame";
const MAX_BILIBILI_TAGS = 10;

export interface BilibiliAutomation {
  publish(task: PublishTask): Promise<PublishAdapterResult>;
  saveDraft(task: PublishTask): Promise<PublishAdapterResult>;
}

export class BilibiliBrowserAdapter implements PublisherAdapter {
  constructor(private readonly automation: BilibiliAutomation = new PlaywrightBilibiliAutomation()) {}

  publish(task: PublishTask): Promise<PublishAdapterResult> {
    return this.automation.publish(task);
  }

  saveDraft(task: PublishTask): Promise<PublishAdapterResult> {
    return this.automation.saveDraft(task);
  }
}

class PlaywrightBilibiliAutomation implements BilibiliAutomation {
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
      `${task.id}-bilibili-${mode}.png`
    );

    try {
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await mkdir(profileDir(), { recursive: true });

      const executablePath = chromiumExecutablePath();
      context = await chromium.launchPersistentContext(profileDir(), {
        headless: false,
        viewport: { width: 1440, height: 960 },
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        ...(executablePath ? { executablePath } : {})
      });
      const page = context.pages()[0] ?? (await context.newPage());
      await openUploadPage(page);

      if (await needsLogin(page)) {
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        keepBrowserOpen = true;
        return {
          status: "NEED_LOGIN",
          externalUrl: BILIBILI_UPLOAD_URL,
          lastScreenshotPath: screenshotPath,
          errorMessage:
            "Bilibili 投稿页未检测到登录态。已打开独立浏览器窗口，请在该窗口登录后重新点击发布或保存草稿。"
        };
      }

      await uploadBilibiliVideo(page, task.sourceVideoPath);
      await fillFirst(page, [
        "input[placeholder*='标题']",
        "textarea[placeholder*='标题']",
        ".input-val input",
        ".title input"
      ], task.title);

      await selectBilibiliOriginalType(page);
      await fillBilibiliDescription(page, buildBilibiliDescription(task));
      await fillBilibiliTags(page, task.tags);
      await verifyBilibiliFields(page, task);
      await waitForUploadComplete(page);
      await ensureBilibiliCover(page, task.coverPath);

      const clicked = mode === "publish" ? await clickPublish(page) : await clickSaveDraft(page);
      if (!clicked) {
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        keepBrowserOpen = true;
        return {
          status: "NEED_MANUAL_ACTION",
          externalUrl: BILIBILI_UPLOAD_URL,
          lastScreenshotPath: screenshotPath,
          errorMessage:
            mode === "publish"
              ? "Bilibili 页面已填充内容，但没有定位到投稿按钮。请在打开的浏览器窗口手动确认提交。"
              : "Bilibili 页面已填充内容，但没有定位到保存草稿按钮。请在打开的浏览器窗口手动确认保存。"
        };
      }

      const confirmed = await waitForActionConfirmation(page, mode);
      const postActionBlockingError = await readBilibiliBlockingError(page);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      if (postActionBlockingError) {
        keepBrowserOpen = true;
        return {
          status: "NEED_MANUAL_ACTION",
          externalUrl: BILIBILI_UPLOAD_URL,
          lastScreenshotPath: screenshotPath,
          errorMessage: postActionBlockingError
        };
      }
      if (!confirmed) {
        keepBrowserOpen = true;
        return {
          status: "NEED_MANUAL_ACTION",
          externalUrl: BILIBILI_UPLOAD_URL,
          lastScreenshotPath: screenshotPath,
          errorMessage:
            mode === "publish"
              ? "Bilibili 已点击投稿按钮，但没有检测到平台提交成功反馈。请在打开的浏览器窗口确认页面结果。"
              : "Bilibili 已点击存草稿按钮，但没有检测到平台保存成功反馈。请在打开的浏览器窗口确认草稿箱结果。"
        };
      }

      return mode === "publish"
        ? {
            status: "WAITING_REVIEW",
            externalUrl: BILIBILI_UPLOAD_URL,
            lastScreenshotPath: screenshotPath,
            errorMessage: "Bilibili 已提交，等待平台审核或页面最终确认。"
          }
        : {
            status: "SAVED_DRAFT",
            externalUrl: BILIBILI_UPLOAD_URL,
            lastScreenshotPath: screenshotPath,
            errorMessage: "Bilibili 草稿保存动作已提交。"
        };
    } catch (error) {
      await context?.pages()[0]?.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      const errorMessage = error instanceof Error ? error.message : "Bilibili browser automation failed";
      return {
        status: "NEED_MANUAL_ACTION",
        externalUrl: BILIBILI_UPLOAD_URL,
        lastScreenshotPath: screenshotPath,
        errorMessage: errorMessage.includes("ProcessSingleton")
          ? "Bilibili 自动化浏览器窗口已经打开，当前同一个登录配置不能并发运行。请先关闭已打开的 Bilibili 自动化窗口，再重新保存草稿。"
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

async function openUploadPage(page: Page): Promise<void> {
  await page.goto(BILIBILI_UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2000);

  if (!page.url().includes("/platform/upload/video/frame") && !page.url().includes("passport.bilibili.com")) {
    await page.goto(BILIBILI_UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await page
    .waitForFunction(
      () =>
        Boolean(document.querySelector("input[type='file']")) ||
        Boolean(document.querySelector(".upload-area")) ||
        document.body.innerText.includes("登录") ||
        document.body.innerText.includes("扫码登录"),
      undefined,
      { timeout: 60_000 }
    )
    .catch(() => undefined);
}

function profileDir(): string {
  return path.resolve(process.cwd(), "storage", "browser-profiles", "bilibili");
}

async function needsLogin(page: Page): Promise<boolean> {
  if (page.url().includes("passport.bilibili.com")) {
    return true;
  }

  const fileInputs = await page.locator("input[type='file']").count().catch(() => 0);
  if (fileInputs > 0) {
    return false;
  }

  const loginText = await page.getByText(/登录|扫码登录|立即登录/).count().catch(() => 0);
  return loginText > 0;
}

async function uploadBilibiliVideo(page: Page, sourceVideoPath: string): Promise<void> {
  if (!sourceVideoPath) {
    throw new Error("Bilibili 发布需要先选择本地视频文件。");
  }

  const absoluteVideoPath = path.resolve(sourceVideoPath);
  if (!existsSync(absoluteVideoPath)) {
    throw new Error(`Bilibili 视频文件不存在: ${absoluteVideoPath}`);
  }

  await waitForUploadEntry(page);
  const uploadedByChooser = await uploadWithFileChooser(page, absoluteVideoPath);
  if (!uploadedByChooser) {
    await uploadWithInputFallback(page, absoluteVideoPath);
  }

  await waitForUploadEditor(page);
  await waitForEarlyUploadErrors(page);
  const blockingError = await readBilibiliUploadBlockingError(page);
  if (blockingError) {
    throw new Error(blockingError);
  }
}

async function selectBilibiliOriginalType(page: Page): Promise<void> {
  const originalType = page.locator("label:has-text('自制'), .bcc-radio:has-text('自制')").first();
  if ((await originalType.count().catch(() => 0)) === 0) {
    return;
  }

  await originalType.click({ timeout: 5000 }).catch(() => undefined);
}

async function waitForUploadComplete(page: Page): Promise<void> {
  const uploaded = await page
    .waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes("上传完成") && !text.includes("上传中...");
      },
      undefined,
      { timeout: 300_000 }
    )
    .then(() => true)
    .catch(() => false);

  const blockingError = await readBilibiliUploadBlockingError(page);
  if (blockingError) {
    throw new Error(blockingError);
  }

  if (!uploaded) {
    throw new Error("Bilibili 视频上传未在限定时间内完成。请在打开的浏览器窗口确认上传进度后重试。");
  }
}

async function ensureBilibiliCover(page: Page, coverPath?: string): Promise<void> {
  if (coverPath) {
    await uploadBilibiliCover(page, coverPath);
    return;
  }

  await waitForBilibiliCoverReady(page);
}

async function uploadBilibiliCover(page: Page, coverPath: string): Promise<void> {
  const absoluteCoverPath = path.resolve(coverPath);
  if (!existsSync(absoluteCoverPath)) {
    throw new Error(`Bilibili 封面文件不存在: ${absoluteCoverPath}`);
  }

  await waitForBilibiliCoverEditorAvailable(page);
  await page.getByText("封面设置").first().click({ timeout: 10_000 });
  const coverInput = page.locator("input[type='file'][accept*='image']").first();
  await coverInput.waitFor({ state: "attached", timeout: 10_000 });
  await coverInput.setInputFiles(absoluteCoverPath, { timeout: 10_000 });
  await page.waitForTimeout(2000);

  await page.locator(".cover-editor-content-right-bottom .submit").last().click({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  const confirmButton = page.locator(".cover-editor .bcc-button--primary:has-text('确定')").last();
  if ((await confirmButton.count().catch(() => 0)) > 0) {
    await confirmButton.click({ timeout: 5000 }).catch(() => undefined);
  }
  await waitForBilibiliCoverReady(page);
}

async function waitForBilibiliCoverEditorAvailable(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return text.includes("封面设置") && !text.includes("上传中...");
    },
    undefined,
    { timeout: 120_000 }
  );
}

async function waitForBilibiliCoverReady(page: Page): Promise<void> {
  const ready = await page
    .waitForFunction(
      () => {
        const text = document.body.innerText;
        return !(
          text.includes("智能封面生成中") ||
          text.includes("封面上传中") ||
          text.includes("封面生成中") ||
          text.includes("上传封面中")
        );
      },
      undefined,
      { timeout: 180_000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!ready) {
    throw new Error("Bilibili 封面仍在生成或上传中。请等待封面处理完成后再保存或发布。");
  }
}

async function waitForUploadEntry(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(document.querySelector("input[type='file']")) || Boolean(document.querySelector(".upload-area")),
    undefined,
    { timeout: 60_000 }
  );
}

async function uploadWithFileChooser(page: Page, absoluteVideoPath: string): Promise<boolean> {
  const uploadArea = page.locator(".upload-area").first();
  if ((await uploadArea.count().catch(() => 0)) === 0) {
    return false;
  }

  try {
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
    await uploadArea.click({ timeout: 10_000, force: true });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(absoluteVideoPath);
    return true;
  } catch {
    return false;
  }
}

async function uploadWithInputFallback(page: Page, absoluteVideoPath: string): Promise<void> {
  for (const selector of [
    ".bcc-upload-wrapper input[type='file']",
    "input[type='file'][name='buploader'][accept*='.mp4']",
    "input[type='file'][accept*='.mp4']",
    "input[type='file']"
  ]) {
    const fileInput = page.locator(selector).first();
    if ((await fileInput.count().catch(() => 0)) === 0) {
      continue;
    }
    await fileInput.setInputFiles(absoluteVideoPath, { timeout: 10_000 });
    return;
  }

  throw new Error("Bilibili 投稿页没有找到可用的视频文件上传控件。");
}

async function waitForUploadEditor(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return (
        text.includes("存草稿") ||
        text.includes("立即投稿") ||
        text.includes("文件内容无法被识别") ||
        Array.from(document.querySelectorAll("input,textarea")).some((element) => {
          const placeholder = element.getAttribute("placeholder") ?? "";
          return placeholder.includes("标题") || placeholder.includes("稿件");
        })
      );
    },
    undefined,
    { timeout: 180_000 }
  );
}

async function waitForEarlyUploadErrors(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => document.body.innerText.includes("文件内容无法被识别") || document.body.innerText.includes("上传失败"),
      undefined,
      { timeout: 8000 }
    )
    .catch(() => undefined);
}

async function readBilibiliUploadBlockingError(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (bodyText.includes("文件内容无法被识别")) {
    return "Bilibili 拒绝了当前视频文件：文件内容无法被识别。请重新选择完整未截断的视频文件后再保存草稿。";
  }

  if (bodyText.includes("上传失败")) {
    return "Bilibili 视频上传失败。请在打开的浏览器窗口查看平台提示，并重新选择视频后重试。";
  }

  return null;
}

async function readBilibiliBlockingError(page: Page): Promise<string | null> {
  const uploadError = await readBilibiliUploadBlockingError(page);
  if (uploadError) {
    return uploadError;
  }

  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (bodyText.includes("请求错误")) {
    return "Bilibili 提交时返回请求错误。请在打开的浏览器窗口查看页面提示，确认类型、分区、标签、封面和简介是否满足平台要求。";
  }
  if (bodyText.includes("请完善") || bodyText.includes("不能为空")) {
    return "Bilibili 投稿信息还不完整。请在打开的浏览器窗口补全平台提示的必填项后再提交。";
  }

  return null;
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    await locator.fill(value, { timeout: 5000 }).catch(async () => {
      await locator.click({ timeout: 5000 });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.type(value);
    });
    return true;
  }
  return false;
}

async function fillBilibiliDescription(page: Page, value: string): Promise<boolean> {
  if (!value.trim()) {
    return true;
  }

  const richEditor = page.locator(".desc-container .ql-editor[contenteditable='true']").first();
  if ((await richEditor.count().catch(() => 0)) > 0) {
    await richEditor.click({ timeout: 5000 });
    await richEditor.fill(value, { timeout: 5000 }).catch(async () => {
      await richEditor.evaluate((element, nextValue) => {
        element.textContent = nextValue;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
      }, value);
    });
    return true;
  }

  return fillFirst(
    page,
    [
      "textarea[placeholder*='简介']",
      "textarea[placeholder*='描述']",
      "textarea[placeholder*='稿件']",
      ".desc textarea"
    ],
    value
  );
}

async function fillBilibiliTags(page: Page, tags: string[]): Promise<void> {
  const normalizedTags = normalizeBilibiliTags(tags);
  if (normalizedTags.length === 0) {
    return;
  }

  const tagInput = page
    .locator("#tag-container input[placeholder*='Enter'], #tag-container input.input-val")
    .first();
  await tagInput.waitFor({ state: "visible", timeout: 10_000 });

  for (const tag of normalizedTags) {
    const tagContainerText = await page.locator("#tag-container").innerText({ timeout: 5000 }).catch(() => "");
    if (tagContainerText.includes(tag)) {
      continue;
    }

    await tagInput.click({ timeout: 5000 });
    await tagInput.fill(tag);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
  }
}

async function verifyBilibiliFields(page: Page, task: PublishTask): Promise<void> {
  const missingFields: string[] = [];
  const description = task.description.trim();
  if (description) {
    const editorText = await page
      .locator(".desc-container .ql-editor[contenteditable='true']")
      .first()
      .innerText({ timeout: 5000 })
      .catch(() => "");
    if (!editorText.includes(description)) {
      missingFields.push("简介");
    }
  }

  const tagContainerText = await page.locator("#tag-container").innerText({ timeout: 5000 }).catch(() => "");
  for (const tag of normalizeBilibiliTags(task.tags)) {
    if (!tagContainerText.includes(tag)) {
      missingFields.push(`标签:${tag}`);
    }
  }

  if (missingFields.length > 0) {
    throw new Error(`Bilibili 字段未成功填入：${missingFields.join("、")}。请在打开的浏览器窗口手动确认。`);
  }
}

async function clickPublish(page: Page): Promise<boolean> {
  return clickByText(page, [/立即投稿/, /发布/, /提交/]);
}

async function clickSaveDraft(page: Page): Promise<boolean> {
  return clickByText(page, [/存草稿/, /保存草稿/, /暂存/]);
}

async function waitForActionConfirmation(page: Page, mode: "publish" | "save-draft"): Promise<boolean> {
  const successPatterns =
    mode === "publish"
      ? ["提交成功", "投稿成功", "已提交", "等待审核"]
      : ["保存成功", "已保存", "已存入草稿", "稿件保存成功"];

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
          return url.includes("upload-manager") || (text.includes("稿件管理") && text.includes("草稿"));
        }
        return (
          url.includes("upload-manager") ||
          (text.includes("稿件管理") && (text.includes("审核") || text.includes("全部稿件")))
        );
      },
      { patterns: successPatterns, actionMode: mode },
      { timeout: 12_000 }
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

export function buildBilibiliDescription(task: Pick<PublishTask, "description" | "tags">): string {
  const tags = normalizeBilibiliTags(task.tags);
  const description = task.description.trim();
  if (tags.length === 0) {
    return description;
  }

  return description ? `${description}\n\n${tags.map((tag) => `#${tag}`).join(" ")}` : tags.map((tag) => `#${tag}`).join(" ");
}

export function normalizeBilibiliTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const value = tag.replace(/^#+/, "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= MAX_BILIBILI_TAGS) {
      break;
    }
  }

  return normalized;
}

export function isBilibiliCoverBusyText(text: string): boolean {
  return isCoverBusy(text);
}

function isCoverBusy(text: string): boolean {
  return (
    text.includes("智能封面生成中") ||
    text.includes("封面上传中") ||
    text.includes("封面生成中") ||
    text.includes("上传封面中")
  );
}
