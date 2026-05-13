import {
  type ContentItem,
  type CreateContentInput,
  type CreatePublishTaskInput,
  type PublishTask,
  type PublishTaskStatus,
  assertTaskStatusTransition
} from "@video-combine/shared";

export interface PrivatePublishingService {
  createContent(input: CreateContentInput): ContentItem;
  getContent(id: string): ContentItem;
  listContents(): ContentItem[];
  createPublishTasks(contentId: string, inputs: CreatePublishTaskInput[]): PublishTask[];
  getPublishTask(id: string): PublishTask;
  listPublishTasks(): PublishTask[];
  updatePublishTask(id: string, patch: PublishTaskPatch): PublishTask;
  transitionTask(id: string, status: PublishTaskStatus, patch?: PublishTaskPatch): PublishTask;
  markTaskFailed(id: string, errorMessage: string): PublishTask;
  retryTask(id: string): PublishTask;
}

export type PublishTaskPatch = Partial<
  Pick<
    PublishTask,
    | "status"
    | "externalPostId"
    | "externalUrl"
    | "errorMessage"
    | "lastScreenshotPath"
    | "scheduledAt"
  >
>;

interface Store {
  contents: Map<string, ContentItem>;
  tasks: Map<string, PublishTask>;
  nextContentId: number;
  nextTaskId: number;
}

export function createPrivatePublishingService(): PrivatePublishingService {
  const store: Store = {
    contents: new Map(),
    tasks: new Map(),
    nextContentId: 1,
    nextTaskId: 1
  };

  return {
    createContent(input) {
      const now = new Date().toISOString();
      const item: ContentItem = {
        id: `cnt_${store.nextContentId++}`,
        title: input.title.trim(),
        description: input.description.trim(),
        tags: input.tags ?? [],
        sourceVideoPath: input.sourceVideoPath,
        status: "READY",
        createdAt: now,
        updatedAt: now,
        ...(input.coverPath ? { coverPath: input.coverPath } : {}),
        ...(input.subtitlePath ? { subtitlePath: input.subtitlePath } : {})
      };

      if (!item.title) {
        throw new Error("Content title is required");
      }

      if (!item.sourceVideoPath) {
        throw new Error("Content sourceVideoPath is required");
      }

      store.contents.set(item.id, item);
      return item;
    },

    getContent(id) {
      return getContentOrThrow(store, id);
    },

    listContents() {
      return [...store.contents.values()];
    },

    createPublishTasks(contentId, inputs) {
      const content = getContentOrThrow(store, contentId);
      const now = new Date().toISOString();

      return inputs.map((input) => {
        const task: PublishTask = {
          id: `tsk_${store.nextTaskId++}`,
          contentId: content.id,
          platform: input.platform,
          accountId: input.accountId,
          title: input.overrides?.title ?? content.title,
          description: input.overrides?.description ?? content.description,
          tags: input.overrides?.tags ?? content.tags,
          sourceVideoPath: content.sourceVideoPath,
          status: "READY",
          attempt: 1,
          createdAt: now,
          updatedAt: now,
          ...((input.overrides?.coverPath ?? content.coverPath)
            ? { coverPath: input.overrides?.coverPath ?? content.coverPath }
            : {}),
          ...(input.overrides?.scheduledAt ? { scheduledAt: input.overrides.scheduledAt } : {})
        };

        if (!task.accountId) {
          throw new Error(`Account id is required for ${input.platform}`);
        }

        store.tasks.set(task.id, task);
        return task;
      });
    },

    getPublishTask(id) {
      return getTaskOrThrow(store, id);
    },

    listPublishTasks() {
      return [...store.tasks.values()];
    },

    updatePublishTask(id, patch) {
      const existing = getTaskOrThrow(store, id);
      const updated: PublishTask = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString()
      };
      store.tasks.set(id, updated);
      return updated;
    },

    transitionTask(id, status, patch = {}) {
      const existing = getTaskOrThrow(store, id);
      assertTaskStatusTransition(existing.status, status);
      const updated: PublishTask = {
        ...existing,
        ...patch,
        status,
        updatedAt: new Date().toISOString()
      };
      store.tasks.set(id, updated);
      return updated;
    },

    markTaskFailed(id, errorMessage) {
      const existing = getTaskOrThrow(store, id);
      if (existing.status === "PUBLISHED" || existing.status === "CANCELLED") {
        throw new Error(`Cannot fail task from ${existing.status}`);
      }

      const updated: PublishTask = {
        ...existing,
        status: "FAILED",
        errorMessage,
        updatedAt: new Date().toISOString()
      };
      store.tasks.set(id, updated);
      return updated;
    },

    retryTask(id) {
      const existing = getTaskOrThrow(store, id);
      if (!["FAILED", "READY", "NEED_LOGIN", "NEED_MANUAL_ACTION"].includes(existing.status)) {
        throw new Error(`Cannot retry task from ${existing.status}`);
      }

      const { errorMessage, lastScreenshotPath, ...taskWithoutFailure } = existing;
      void errorMessage;
      void lastScreenshotPath;

      const updated: PublishTask = {
        ...taskWithoutFailure,
        status: "QUEUED",
        attempt: existing.attempt + 1,
        updatedAt: new Date().toISOString()
      };
      store.tasks.set(id, updated);
      return updated;
    }
  };
}

function getContentOrThrow(store: Store, id: string): ContentItem {
  const item = store.contents.get(id);
  if (!item) {
    throw new Error(`Content not found: ${id}`);
  }
  return item;
}

function getTaskOrThrow(store: Store, id: string): PublishTask {
  const task = store.tasks.get(id);
  if (!task) {
    throw new Error(`Publish task not found: ${id}`);
  }
  return task;
}
