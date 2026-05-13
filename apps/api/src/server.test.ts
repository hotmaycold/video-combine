import { describe, expect, it } from "vitest";
import { stat, unlink } from "node:fs/promises";
import { buildApi } from "./server";

describe("private API", () => {
  it("creates content, creates tasks, lists tasks, and retries a task", async () => {
    const app = buildApi();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const contentResponse = await app.inject({
      method: "POST",
      url: "/contents",
      payload: {
        title: "API launch",
        description: "Created through API",
        tags: ["api"],
        sourceVideoPath: "/storage/uploads/api.mp4"
      }
    });
    expect(contentResponse.statusCode).toBe(201);
    const content = contentResponse.json();

    const taskResponse = await app.inject({
      method: "POST",
      url: `/contents/${content.id}/publish-tasks`,
      payload: {
        tasks: [
          { platform: "youtube", accountId: "account-youtube" },
          { platform: "wechat_channels", accountId: "account-video" }
        ]
      }
    });
    expect(taskResponse.statusCode).toBe(201);
    expect(taskResponse.json()).toHaveLength(2);

    const listResponse = await app.inject({ method: "GET", url: "/publish-tasks" });
    expect(listResponse.statusCode).toBe(200);
    const tasks = listResponse.json();
    expect(tasks[0]).toMatchObject({ platform: "youtube", status: "READY" });

    const retryResponse = await app.inject({
      method: "POST",
      url: `/publish-tasks/${tasks[0].id}/retry`
    });
    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toMatchObject({ status: "QUEUED", attempt: 2 });
  });

  it("processes publish tasks and saves platform drafts", async () => {
    const app = buildApi();

    const contentResponse = await app.inject({
      method: "POST",
      url: "/contents",
      payload: {
        title: "Process API launch",
        description: "Created through API",
        tags: ["api"],
        sourceVideoPath: "/storage/uploads/api.mp4"
      }
    });
    const content = contentResponse.json();

    const taskResponse = await app.inject({
      method: "POST",
      url: `/contents/${content.id}/publish-tasks`,
      payload: {
        tasks: [
          { platform: "youtube", accountId: "account-youtube" },
          { platform: "xiaohongshu", accountId: "account-xhs" }
        ]
      }
    });
    const tasks = taskResponse.json();

    const processResponse = await app.inject({
      method: "POST",
      url: `/publish-tasks/${tasks[0].id}/process`
    });
    expect(processResponse.statusCode).toBe(200);
    expect(processResponse.json()).toMatchObject({ status: "PUBLISHED" });

    const draftResponse = await app.inject({
      method: "POST",
      url: `/publish-tasks/${tasks[1].id}/save-draft`
    });
    expect(draftResponse.statusCode).toBe(200);
    expect(draftResponse.json()).toMatchObject({ status: "SAVED_DRAFT" });
  });

  it("stores video uploads larger than 1MB without truncating them", async () => {
    const app = buildApi();
    const boundary = "----video-combine-test-boundary";
    const videoBytes = Buffer.alloc(1_048_577, 1);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n`
      ),
      videoBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadResponse = await app.inject({
      method: "POST",
      url: "/uploads?kind=video",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload
    });

    expect(uploadResponse.statusCode).toBe(201);
    const body = uploadResponse.json();
    const uploadedStat = await stat(body.path);
    await unlink(body.path);
    expect(uploadedStat.size).toBe(videoBytes.length);
  });
});
