import type { CreatePublishTaskInput, Platform, PlatformProfile, PublishTask } from "@video-combine/shared";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export interface PlatformDraftOverride {
  title?: string;
  description?: string;
  tags?: string[];
}

export interface CreateDraftPayload {
  title: string;
  description: string;
  tags: string[];
  sourceVideoPath: string;
  coverPath?: string;
  platforms: Platform[];
  platformOverrides: Partial<Record<Platform, PlatformDraftOverride>>;
}

interface ContentResponse {
  id: string;
}

interface UploadResponse {
  path: string;
  originalName: string;
}

export async function fetchPlatforms(): Promise<PlatformProfile[]> {
  return request<PlatformProfile[]>("/platforms");
}

export async function fetchTasks(): Promise<PublishTask[]> {
  return request<PublishTask[]>("/publish-tasks");
}

export async function uploadLocalFile(file: File, kind: "video" | "cover"): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE_URL}/uploads?kind=${kind}`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error ?? response.statusText);
  }

  return response.json() as Promise<UploadResponse>;
}

export async function createDraftTasks(payload: CreateDraftPayload): Promise<PublishTask[]> {
  const contentPayload = {
    title: payload.title,
    description: payload.description,
    tags: payload.tags,
    sourceVideoPath: payload.sourceVideoPath,
    ...(payload.coverPath ? { coverPath: payload.coverPath } : {})
  };

  const content = await request<ContentResponse>("/contents", {
    method: "POST",
    body: JSON.stringify(contentPayload)
  });

  return request<PublishTask[]>(`/contents/${content.id}/publish-tasks`, {
    method: "POST",
    body: JSON.stringify({
      tasks: payload.platforms.map<CreatePublishTaskInput>((platform) => ({
        platform,
        accountId: `local-${platform}`,
        ...(payload.platformOverrides[platform]
          ? { overrides: payload.platformOverrides[platform] }
          : {})
      }))
    })
  });
}

export async function retryTask(taskId: string): Promise<PublishTask> {
  return request<PublishTask>(`/publish-tasks/${taskId}/retry`, {
    method: "POST"
  });
}

export async function processTask(taskId: string): Promise<PublishTask> {
  return request<PublishTask>(`/publish-tasks/${taskId}/process`, {
    method: "POST"
  });
}

export async function saveTaskDraft(taskId: string): Promise<PublishTask> {
  return request<PublishTask>(`/publish-tasks/${taskId}/save-draft`, {
    method: "POST"
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const requestInit: RequestInit = {
    ...init,
    ...(hasBody
      ? {
          headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {})
          }
        }
      : {})
  };
  const response = await fetch(`${API_BASE_URL}${path}`, requestInit);

  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error ?? response.statusText);
  }

  return response.json() as Promise<T>;
}
