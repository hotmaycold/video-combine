import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { createPrivatePublishingService } from "@video-combine/core";
import { PLATFORM_PROFILES } from "@video-combine/shared";
import { processPublishTask, savePublishTaskDraft } from "@video-combine/worker";

const DEFAULT_UPLOAD_FILE_SIZE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;

export function buildApi(): FastifyInstance {
  const service = createPrivatePublishingService();
  const app = Fastify({ logger: false });

  void app.register(cors, {
    origin: true
  });
  void app.register(multipart, {
    limits: {
      fileSize: uploadFileSizeLimitBytes(),
      files: 1
    },
    throwFileSizeLimit: true
  });

  app.get("/health", async () => ({
    ok: true,
    service: "video-combine-api"
  }));

  app.get("/platforms", async () => Object.values(PLATFORM_PROFILES));

  app.get("/contents", async () => service.listContents());

  app.post("/uploads", async (request, reply) => {
    const query = request.query as { kind?: "video" | "cover" };
    const kind = query.kind === "cover" ? "cover" : "video";
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({ error: "Upload file is required" });
    }

    const storageDir = path.resolve(
      process.cwd(),
      "storage",
      kind === "cover" ? "covers" : "uploads"
    );
    await mkdir(storageDir, { recursive: true });

    const filename = `${Date.now()}-${sanitizeFilename(file.filename)}`;
    const absolutePath = path.join(storageDir, filename);
    await pipeline(file.file, createWriteStream(absolutePath));
    if (file.file.truncated) {
      await unlink(absolutePath).catch(() => undefined);
      return reply.code(413).send({
        error: `Upload exceeded file size limit of ${uploadFileSizeLimitBytes()} bytes`
      });
    }

    return reply.code(201).send({
      path: absolutePath,
      originalName: file.filename,
      filename,
      kind
    });
  });

  app.post("/contents", async (request, reply) => {
    const body = request.body as {
      title?: string;
      description?: string;
      tags?: string[];
      sourceVideoPath?: string;
      coverPath?: string;
      subtitlePath?: string;
    };

    const content = service.createContent({
      title: body.title ?? "",
      description: body.description ?? "",
      tags: body.tags ?? [],
      sourceVideoPath: body.sourceVideoPath ?? "",
      ...(body.coverPath ? { coverPath: body.coverPath } : {}),
      ...(body.subtitlePath ? { subtitlePath: body.subtitlePath } : {})
    });

    return reply.code(201).send(content);
  });

  app.get("/contents/:id", async (request) => {
    const { id } = request.params as { id: string };
    return service.getContent(id);
  });

  app.post("/contents/:id/publish-tasks", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      tasks?: Parameters<typeof service.createPublishTasks>[1];
    };
    const tasks = service.createPublishTasks(id, body.tasks ?? []);
    return reply.code(201).send(tasks);
  });

  app.get("/publish-tasks", async () => service.listPublishTasks());

  app.post("/publish-tasks/:id/retry", async (request) => {
    const { id } = request.params as { id: string };
    return service.retryTask(id);
  });

  app.post("/publish-tasks/:id/process", async (request) => {
    const { id } = request.params as { id: string };
    return processPublishTask(service, id);
  });

  app.post("/publish-tasks/:id/save-draft", async (request) => {
    const { id } = request.params as { id: string };
    return savePublishTaskDraft(service, id);
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown API error";
    const statusCode = message.includes("not found") ? 404 : 400;
    return reply.code(statusCode).send({
      error: message
    });
  });

  return app;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function uploadFileSizeLimitBytes(): number {
  const configuredLimit = Number(process.env.UPLOAD_FILE_SIZE_LIMIT_BYTES);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : DEFAULT_UPLOAD_FILE_SIZE_LIMIT_BYTES;
}
