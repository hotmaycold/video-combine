import type { Platform } from "@video-combine/shared";
import { BilibiliBrowserAdapter } from "./bilibili-browser-adapter";
import { LocalDeterministicAdapter } from "./local-deterministic-adapter";
import type { PublisherAdapter } from "./publisher-adapter";
import { TikTokBrowserAdapter } from "./tiktok-browser-adapter";

export function createPublisherAdapter(platform: Platform): PublisherAdapter {
  if (platform === "bilibili") {
    return new BilibiliBrowserAdapter();
  }
  if (platform === "tiktok") {
    return new TikTokBrowserAdapter();
  }

  return new LocalDeterministicAdapter();
}
