import { describe, expect, it } from "vitest";
import {
  PLATFORM_PROFILES,
  assertPlatform,
  canTransitionTaskStatus,
  normalizePlatformList
} from "./index";

describe("shared platform model", () => {
  it("classifies official API and browser automation platforms", () => {
    expect(PLATFORM_PROFILES.youtube.publisherKind).toBe("official-api");
    expect(PLATFORM_PROFILES.douyin.publisherKind).toBe("official-api");
    expect(PLATFORM_PROFILES.xiaohongshu.publisherKind).toBe("browser-automation");
    expect(PLATFORM_PROFILES.wechat_channels.publisherKind).toBe("browser-automation");
    expect(PLATFORM_PROFILES.xiaohongshu.publishUrl).toContain("xiaohongshu.com");
  });

  it("normalizes platform ids and rejects unsupported values", () => {
    expect(normalizePlatformList(["youtube", "xiaohongshu"])).toEqual([
      "youtube",
      "xiaohongshu"
    ]);

    expect(() => assertPlatform("unknown")).toThrow("Unsupported platform: unknown");
  });

  it("guards publish task status transitions", () => {
    expect(canTransitionTaskStatus("READY", "QUEUED")).toBe(true);
    expect(canTransitionTaskStatus("QUEUED", "UPLOADING")).toBe(true);
    expect(canTransitionTaskStatus("PUBLISHING", "SAVED_DRAFT")).toBe(true);
    expect(canTransitionTaskStatus("PUBLISHED", "FAILED")).toBe(false);
  });
});
