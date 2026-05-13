import type { PublishTask, PublishTaskStatus } from "@video-combine/shared";

export interface PublishAdapterResult {
  status: Extract<
    PublishTaskStatus,
    "PUBLISHED" | "SAVED_DRAFT" | "WAITING_REVIEW" | "NEED_LOGIN" | "NEED_MANUAL_ACTION" | "FAILED"
  >;
  externalPostId?: string;
  externalUrl?: string;
  errorMessage?: string;
  lastScreenshotPath?: string;
}

export interface PublisherAdapter {
  publish(task: PublishTask): Promise<PublishAdapterResult>;
  saveDraft(task: PublishTask): Promise<PublishAdapterResult>;
}
