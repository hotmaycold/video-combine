# Private MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first private, local-only skeleton for a multi-platform video publishing control center.

**Architecture:** Use a Node.js monorepo with shared domain types, a core in-memory task service, a Fastify API, a worker processor with platform adapter boundaries, and a React dashboard shell. External platform publishing is represented by adapters so official APIs and browser automation can be added without changing the task API.

**Tech Stack:** TypeScript, npm workspaces, Vitest, Fastify, React, Vite, Docker Compose for optional PostgreSQL and Redis.

---

## File Map

- `package.json`: root workspace scripts and shared dev dependencies.
- `tsconfig.base.json`: shared TypeScript settings.
- `.gitignore`: local build, dependency, storage, and environment exclusions.
- `.env.example`: private deployment configuration template.
- `docker-compose.yml`: optional PostgreSQL and Redis services for later stages.
- `packages/shared`: platform names, task statuses, domain models, validation helpers.
- `packages/core`: in-memory repository and content/publish task service.
- `apps/api`: Fastify HTTP API over the core service.
- `apps/worker`: platform adapter interface and first processor.
- `apps/web`: private React dashboard shell.

## Tasks

### Task 1: Workspace and Test Baseline

- [x] Create npm workspace configuration.
- [x] Create TypeScript configuration.
- [x] Create tests for shared model validation and core task creation.
- [x] Run tests and confirm they fail because implementation files do not exist.

### Task 2: Shared Domain and Core Services

- [x] Implement platform constants, task status constants, and domain model types.
- [x] Implement content and publish task creation services.
- [x] Run shared and core tests until green.

### Task 3: API Boundary

- [x] Add Fastify API routes for health, platform list, content creation, task creation, task listing, and retry.
- [x] Add API tests using Fastify injection.
- [x] Run API tests until green.

### Task 4: Worker Boundary

- [x] Add publisher adapter interface.
- [x] Add deterministic local adapter behavior for first-stage private testing.
- [x] Add worker processor tests for manual-action and published paths.
- [x] Run worker tests until green.

### Task 5: Private Dashboard Shell

- [x] Add Vite React dashboard.
- [x] Show platform status matrix, draft composer, task queue, and manual-action guidance.
- [x] Build the web app successfully.

### Task 6: Verification

- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Update README if commands or structure differ from the design.
