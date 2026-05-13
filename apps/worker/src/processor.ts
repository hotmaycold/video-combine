import type { PrivatePublishingService } from "@video-combine/core";
import type { PublishTask } from "@video-combine/shared";
import { createPublisherAdapter } from "./adapter-factory";
import type { PublisherAdapter } from "./publisher-adapter";

export async function processPublishTask(
  service: PrivatePublishingService,
  taskId: string,
  adapter?: PublisherAdapter
): Promise<PublishTask> {
  return runTaskAction(service, taskId, "publish", adapter);
}

export async function savePublishTaskDraft(
  service: PrivatePublishingService,
  taskId: string,
  adapter?: PublisherAdapter
): Promise<PublishTask> {
  return runTaskAction(service, taskId, "saveDraft", adapter);
}

async function runTaskAction(
  service: PrivatePublishingService,
  taskId: string,
  action: "publish" | "saveDraft",
  adapter?: PublisherAdapter
): Promise<PublishTask> {
  const task = service.getPublishTask(taskId);
  const selectedAdapter = adapter ?? createPublisherAdapter(task.platform);

  if (task.status === "READY") {
    service.transitionTask(task.id, "QUEUED");
  }

  const queuedTask = service.getPublishTask(task.id);
  if (queuedTask.status !== "QUEUED") {
    throw new Error(`Task must be QUEUED before processing, got ${queuedTask.status}`);
  }

  service.transitionTask(task.id, "PUBLISHING");
  const result =
    action === "publish"
      ? await selectedAdapter.publish(service.getPublishTask(task.id))
      : await selectedAdapter.saveDraft(service.getPublishTask(task.id));

  if (result.status === "FAILED") {
    return service.markTaskFailed(task.id, result.errorMessage ?? "Adapter publish failed");
  }

  return service.transitionTask(task.id, result.status, {
    ...(result.externalPostId ? { externalPostId: result.externalPostId } : {}),
    ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(result.lastScreenshotPath ? { lastScreenshotPath: result.lastScreenshotPath } : {})
  });
}
