import { describe, expect, it } from "vitest";
import { createPrivatePublishingService } from "@video-combine/core";
import type { PublishTask } from "@video-combine/shared";
import { processPublishTask, savePublishTaskDraft } from "./processor";
import {
  BilibiliBrowserAdapter,
  buildBilibiliDescription,
  isBilibiliCoverBusyText,
  normalizeBilibiliTags,
  type BilibiliAutomation
} from "./bilibili-browser-adapter";
import { createPublisherAdapter } from "./adapter-factory";
import {
  TIKTOK_UPLOAD_URL,
  isTikTokGuidanceDialogText,
  isTikTokNavigationFailure,
  isTikTokSaveDraftDialogText,
  isTikTokContinueToPostDialogText,
  isTikTokUploadComplete,
  normalizeTikTokProxyServer
} from "./tiktok-browser-adapter";

describe("worker publish processor", () => {
  it("publishes official API tasks through the local deterministic adapter", async () => {
    const service = createPrivatePublishingService();
    const content = service.createContent({
      title: "Worker video",
      description: "Worker test",
      tags: [],
      sourceVideoPath: "/storage/uploads/worker.mp4"
    });
    const [task] = service.createPublishTasks(content.id, [
      { platform: "youtube", accountId: "account-youtube" }
    ]);

    const result = await processPublishTask(service, task!.id);

    expect(result.status).toBe("PUBLISHED");
    expect(result.externalUrl).toContain("youtube.local");
  });

  it("marks browser automation placeholders as needing platform login", async () => {
    const service = createPrivatePublishingService();
    const content = service.createContent({
      title: "Manual video",
      description: "Browser task",
      tags: [],
      sourceVideoPath: "/storage/uploads/manual.mp4"
    });
    const [task] = service.createPublishTasks(content.id, [
      { platform: "xiaohongshu", accountId: "account-xhs" }
    ]);

    const result = await processPublishTask(service, task!.id);

    expect(result.status).toBe("NEED_LOGIN");
    expect(result.errorMessage).toContain("Log in to");
    expect(result.errorMessage).toContain("retry");
  });

  it("marks browser automation draft placeholders as needing platform login", async () => {
    const service = createPrivatePublishingService();
    const content = service.createContent({
      title: "Draft video",
      description: "Save draft test",
      tags: [],
      sourceVideoPath: "/storage/uploads/draft.mp4"
    });
    const [task] = service.createPublishTasks(content.id, [
      { platform: "xiaohongshu", accountId: "account-xhs" }
    ]);

    const result = await savePublishTaskDraft(service, task!.id);

    expect(result.status).toBe("NEED_LOGIN");
    expect(result.externalUrl).toContain("xiaohongshu.com");
    expect(result.errorMessage).toContain("retry saving this draft");
  });

  it("routes bilibili tasks through an injected browser automation adapter", async () => {
    const service = createPrivatePublishingService();
    const content = service.createContent({
      title: "Bilibili video",
      description: "Bilibili flow",
      tags: ["bili"],
      sourceVideoPath: "/storage/uploads/bili.mp4"
    });
    const [task] = service.createPublishTasks(content.id, [
      { platform: "bilibili", accountId: "account-bili" }
    ]);
    const automation: BilibiliAutomation = {
      async publish(input: PublishTask) {
        return {
          status: "WAITING_REVIEW",
          externalUrl: "https://member.bilibili.com/platform/upload/video/frame",
          errorMessage: input.sourceVideoPath
        };
      },
      async saveDraft() {
        return {
          status: "SAVED_DRAFT",
          externalUrl: "https://member.bilibili.com/platform/upload/video/frame"
        };
      }
    };

    const result = await processPublishTask(service, task!.id, new BilibiliBrowserAdapter(automation));

    expect(result.status).toBe("WAITING_REVIEW");
    expect(result.errorMessage).toBe("/storage/uploads/bili.mp4");
  });

  it("routes tiktok tasks through a browser automation adapter", () => {
    const adapter = createPublisherAdapter("tiktok");

    expect(adapter.constructor.name).toBe("TikTokBrowserAdapter");
  });

  it("uses the TikTok Studio video upload page", () => {
    expect(TIKTOK_UPLOAD_URL).toBe("https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video");
  });

  it("does not treat an in-progress TikTok upload as ready to submit", () => {
    expect(isTikTokUploadComplete("44.32MB/71.6MB 61.91% remaining 4s", true)).toBe(false);
    expect(isTikTokUploadComplete("Video details are ready", true)).toBe(true);
  });

  it("classifies TikTok aborted navigation as a navigation failure", () => {
    expect(
      isTikTokNavigationFailure(
        "page.goto: net::ERR_ABORTED; navigating to https://www.tiktok.com/tiktokstudio/upload"
      )
    ).toBe(true);
  });

  it("normalizes explicit TikTok proxy servers for Playwright", () => {
    expect(normalizeTikTokProxyServer("127.0.0.1:8899")).toBe("http://127.0.0.1:8899");
    expect(normalizeTikTokProxyServer("socks5://proxy.local:7890")).toBe("socks5://proxy.local:7890");
    expect(normalizeTikTokProxyServer("")).toBeUndefined();
  });

  it("detects the TikTok continue-to-post copyright check dialog", () => {
    expect(
      isTikTokContinueToPostDialogText(
        "Continue to post? The copyright check is incomplete. Posting your video now will stop the check. Post now"
      )
    ).toBe(true);
    expect(isTikTokContinueToPostDialogText("Draft saved")).toBe(false);
  });

  it("detects TikTok onboarding guidance that can block form actions", () => {
    expect(isTikTokGuidanceDialogText("Welcome to TikTok Studio. Take a quick tour. Got it")).toBe(true);
    expect(isTikTokGuidanceDialogText("Video details are ready")).toBe(false);
  });

  it("detects TikTok save-draft confirmation dialogs", () => {
    expect(isTikTokSaveDraftDialogText("Save draft? Your video will be saved as a draft. Cancel Save draft")).toBe(true);
    expect(isTikTokSaveDraftDialogText("Save draft")).toBe(false);
  });

  it("formats bilibili description and tags for browser fields", () => {
    const task = {
      description: "统一发布文案",
      tags: ["#自媒体", "短视频", "自媒体", " ", "自动化"]
    } as PublishTask;

    expect(buildBilibiliDescription(task)).toBe("统一发布文案\n\n#自媒体 #短视频 #自动化");
    expect(normalizeBilibiliTags(task.tags)).toEqual(["自媒体", "短视频", "自动化"]);
  });

  it("detects bilibili cover work that must finish before submit", () => {
    expect(isBilibiliCoverBusyText("智能封面生成中... 59%")).toBe(true);
    expect(isBilibiliCoverBusyText("封面上传中...")).toBe(true);
    expect(isBilibiliCoverBusyText("封面设置")).toBe(false);
  });
});
