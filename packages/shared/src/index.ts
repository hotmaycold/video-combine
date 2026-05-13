export const PLATFORMS = [
  "youtube",
  "tiktok",
  "instagram",
  "douyin",
  "kuaishou",
  "wechat_channels",
  "xiaohongshu",
  "bilibili"
] as const;

export type Platform = (typeof PLATFORMS)[number];

export type PublisherKind = "official-api" | "browser-automation" | "external-cli";

export interface PlatformProfile {
  id: Platform;
  label: string;
  publisherKind: PublisherKind;
  requiresManualFallback: boolean;
  publishUrl: string;
}

export const PLATFORM_PROFILES: Record<Platform, PlatformProfile> = {
  youtube: {
    id: "youtube",
    label: "YouTube Shorts",
    publisherKind: "official-api",
    requiresManualFallback: false,
    publishUrl: "https://studio.youtube.com"
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    publisherKind: "browser-automation",
    requiresManualFallback: true,
    publishUrl: "https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video"
  },
  instagram: {
    id: "instagram",
    label: "Instagram Reels",
    publisherKind: "official-api",
    requiresManualFallback: false,
    publishUrl: "https://www.instagram.com"
  },
  douyin: {
    id: "douyin",
    label: "抖音",
    publisherKind: "official-api",
    requiresManualFallback: false,
    publishUrl: "https://creator.douyin.com/creator-micro/content/upload"
  },
  kuaishou: {
    id: "kuaishou",
    label: "快手",
    publisherKind: "official-api",
    requiresManualFallback: true,
    publishUrl: "https://cp.kuaishou.com/article/publish/video"
  },
  wechat_channels: {
    id: "wechat_channels",
    label: "微信视频号",
    publisherKind: "browser-automation",
    requiresManualFallback: true,
    publishUrl: "https://channels.weixin.qq.com/platform/post/create"
  },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "小红书",
    publisherKind: "browser-automation",
    requiresManualFallback: true,
    publishUrl: "https://creator.xiaohongshu.com/publish/publish"
  },
  bilibili: {
    id: "bilibili",
    label: "Bilibili",
    publisherKind: "external-cli",
    requiresManualFallback: false,
    publishUrl: "https://member.bilibili.com/platform/upload/video/frame"
  }
};

export const PUBLISH_TASK_STATUSES = [
  "DRAFT",
  "READY",
  "PROCESSING_ASSET",
  "QUEUED",
  "UPLOADING",
  "PUBLISHING",
  "WAITING_REVIEW",
  "NEED_LOGIN",
  "NEED_MANUAL_ACTION",
  "SAVED_DRAFT",
  "PUBLISHED",
  "FAILED",
  "CANCELLED"
] as const;

export type PublishTaskStatus = (typeof PUBLISH_TASK_STATUSES)[number];

export interface ContentItem {
  id: string;
  title: string;
  description: string;
  tags: string[];
  sourceVideoPath: string;
  coverPath?: string;
  subtitlePath?: string;
  status: "DRAFT" | "READY" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface CreateContentInput {
  title: string;
  description: string;
  tags?: string[];
  sourceVideoPath: string;
  coverPath?: string;
  subtitlePath?: string;
}

export interface PublishTaskOverrides {
  title?: string;
  description?: string;
  tags?: string[];
  coverPath?: string;
  scheduledAt?: string;
}

export interface CreatePublishTaskInput {
  platform: Platform;
  accountId: string;
  overrides?: PublishTaskOverrides;
}

export interface PublishTask {
  id: string;
  contentId: string;
  platform: Platform;
  accountId: string;
  title: string;
  description: string;
  tags: string[];
  sourceVideoPath: string;
  coverPath?: string;
  scheduledAt?: string;
  status: PublishTaskStatus;
  attempt: number;
  externalPostId?: string;
  externalUrl?: string;
  errorMessage?: string;
  lastScreenshotPath?: string;
  createdAt: string;
  updatedAt: string;
}

export function assertPlatform(value: string): asserts value is Platform {
  if (!PLATFORMS.includes(value as Platform)) {
    throw new Error(`Unsupported platform: ${value}`);
  }
}

export function normalizePlatformList(values: string[]): Platform[] {
  return values.map((value) => {
    assertPlatform(value);
    return value;
  });
}

const ALLOWED_TRANSITIONS: Record<PublishTaskStatus, PublishTaskStatus[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["PROCESSING_ASSET", "QUEUED", "CANCELLED"],
  PROCESSING_ASSET: ["QUEUED", "FAILED", "CANCELLED"],
  QUEUED: ["UPLOADING", "PUBLISHING", "FAILED", "CANCELLED"],
  UPLOADING: ["PUBLISHING", "FAILED", "NEED_LOGIN", "NEED_MANUAL_ACTION"],
  PUBLISHING: ["WAITING_REVIEW", "SAVED_DRAFT", "PUBLISHED", "FAILED", "NEED_LOGIN", "NEED_MANUAL_ACTION"],
  WAITING_REVIEW: ["PUBLISHED", "FAILED", "NEED_MANUAL_ACTION"],
  NEED_LOGIN: ["QUEUED", "FAILED", "CANCELLED"],
  NEED_MANUAL_ACTION: ["QUEUED", "PUBLISHED", "FAILED", "CANCELLED"],
  SAVED_DRAFT: [],
  PUBLISHED: [],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: []
};

export function canTransitionTaskStatus(
  from: PublishTaskStatus,
  to: PublishTaskStatus
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTaskStatusTransition(
  from: PublishTaskStatus,
  to: PublishTaskStatus
): void {
  if (!canTransitionTaskStatus(from, to)) {
    throw new Error(`Invalid publish task transition: ${from} -> ${to}`);
  }
}
