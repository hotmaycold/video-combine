import { describe, expect, it } from "vitest";
import { createPrivatePublishingService } from "./index";

describe("private publishing service", () => {
  it("creates content and platform-specific publish tasks", () => {
    const service = createPrivatePublishingService();

    const content = service.createContent({
      title: "Launch video",
      description: "Daily multi-platform publish",
      tags: ["automation", "creator"],
      sourceVideoPath: "/storage/uploads/launch.mp4",
      coverPath: "/storage/covers/launch.jpg"
    });

    const tasks = service.createPublishTasks(content.id, [
      { platform: "youtube", accountId: "account-youtube" },
      {
        platform: "xiaohongshu",
        accountId: "account-xhs",
        overrides: { title: "小红书版本标题" }
      }
    ]);

    expect(content.id).toMatch(/^cnt_/);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.status).toBe("READY");
    expect(tasks[0]?.title).toBe("Launch video");
    expect(tasks[0]?.sourceVideoPath).toBe("/storage/uploads/launch.mp4");
    expect(tasks[1]?.title).toBe("小红书版本标题");
    expect(service.listPublishTasks()).toHaveLength(2);
  });

  it("marks failed tasks and creates a clean retry attempt", () => {
    const service = createPrivatePublishingService();
    const content = service.createContent({
      title: "Retry video",
      description: "Retry flow",
      tags: [],
      sourceVideoPath: "/storage/uploads/retry.mp4"
    });
    const [task] = service.createPublishTasks(content.id, [
      { platform: "youtube", accountId: "account-youtube" }
    ]);

    service.markTaskFailed(task!.id, "quota exceeded");
    const retry = service.retryTask(task!.id);

    expect(retry.status).toBe("QUEUED");
    expect(retry.attempt).toBe(2);
    expect(retry.errorMessage).toBeUndefined();
  });
});
