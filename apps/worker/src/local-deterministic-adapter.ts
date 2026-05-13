import { PLATFORM_PROFILES } from "@video-combine/shared";
import type { PublishTask } from "@video-combine/shared";
import type { PublishAdapterResult, PublisherAdapter } from "./publisher-adapter";

export class LocalDeterministicAdapter implements PublisherAdapter {
  async publish(task: PublishTask): Promise<PublishAdapterResult> {
    const profile = PLATFORM_PROFILES[task.platform];

    if (profile.publisherKind === "browser-automation") {
      return {
        status: "NEED_LOGIN",
        externalUrl: profile.publishUrl,
        errorMessage: `Log in to ${profile.label} in its dedicated browser session, then retry this task. The platform login state should be saved in storage/browser-profiles/${task.platform}.`
      };
    }

    return {
      status: "PUBLISHED",
      externalPostId: `local_${task.platform}_${task.id}`,
      externalUrl: `https://${task.platform}.local/posts/${task.id}`
    };
  }

  async saveDraft(task: PublishTask): Promise<PublishAdapterResult> {
    const profile = PLATFORM_PROFILES[task.platform];

    if (profile.publisherKind === "browser-automation") {
      return {
        status: "NEED_LOGIN",
        externalUrl: profile.publishUrl,
        errorMessage: `Log in to ${profile.label} in its dedicated browser session, then retry saving this draft. The platform login state should be saved in storage/browser-profiles/${task.platform}.`
      };
    }

    return {
      status: "SAVED_DRAFT",
      externalPostId: `draft_${task.platform}_${task.id}`,
      externalUrl: profile.publishUrl,
      errorMessage: `${profile.label} 草稿箱任务已保存到本地队列，真实平台草稿保存将在自动化适配器接入后执行。`
    };
  }
}
