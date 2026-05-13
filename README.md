# Video Combine

私有化自用的一键多平台视频发布中台设计。

当前目标不是做公开 SaaS，而是先做一个给自媒体人自己使用的发布控制台：一次上传视频和文案，系统按平台生成发布任务，能通过官方 API 发布的自动发布，不能稳定走 API 的平台通过本地浏览器自动化辅助发布，并保留人工接管。

方案更新时间：2026-05-08

## 设计原则

- 私有化部署优先，账号凭证和浏览器登录态不上传第三方服务。
- 官方 API 优先，浏览器自动化只做兜底。
- 不绕过验证码、风控、平台审核和用户确认。
- 每个平台独立适配，统一任务入口和状态回传。
- 失败可重试，可人工接管，可留存日志和截图证据。
- 第一版服务自己，不追求多租户 SaaS、公开注册和复杂权限。

## 目标场景

你每天需要把同一条或相近版本的视频发布到多个平台：

- 抖音
- 微信视频号
- 快手
- 小红书
- TikTok
- Instagram Reels
- YouTube Shorts
- 可扩展：Bilibili、Facebook Reels、微博、百家号等

平台之间的差异主要在标题长度、话题格式、封面、时长、分辨率、账号登录方式、审核机制和定时发布能力。系统要做的是把这些差异收敛到一个统一发布流程里。

## 平台接入策略

| 平台 | 第一版方式 | 自动化程度 | 关键限制 |
| --- | --- | --- | --- |
| YouTube / Shorts | YouTube Data API | 高 | 需要 Google OAuth；未审核项目上传可见性可能受限；配额需以控制台实际计费为准。 |
| TikTok | Content Posting API | 中高 | Direct Post 需要用户授权、应用审核和发布 UX 合规；未审核客户端发布内容可见性受限。 |
| Instagram Reels | Instagram / Meta Graph API | 中高 | 需要专业账号、权限申请和媒体容器发布流程；媒体 URL、账号类型和权限容易踩坑。 |
| 抖音 | 抖音开放平台 API | 中高 | 需要申请“代替用户发布内容到抖音”能力，发布后仍有审核过程。 |
| 快手 | 快手开放平台 API，必要时浏览器兜底 | 中高 | 创建视频通常包含发起上传、上传视频、发布视频三个步骤；大文件需分片。 |
| 微信视频号 | Playwright 浏览器自动化 | 中低 | 当前更现实的是走视频号助手网页端；扫码、登录态、页面变化和人工确认必须保留。 |
| 小红书 | Playwright 浏览器自动化 | 中低 | 稳定公开内容发布 API 不适合作为第一版核心依赖；优先走创作平台网页自动化。 |
| Bilibili | biliup 或 `social-auto-upload` | 高 | 可作为第一批扩展平台，不影响主流程。 |

## 推荐总体架构

```mermaid
flowchart LR
    A[发布控制台] --> B[内容库]
    A --> C[发布任务 API]
    C --> D[任务队列]
    D --> E[视频处理器]
    D --> F[平台适配器]
    F --> G1[官方 API 平台]
    F --> G2[浏览器自动化平台]
    G2 --> H[本地 Playwright 浏览器]
    F --> I[状态查询与截图]
    I --> A
```

### 1. 发布控制台

控制台负责让你完成每天的发布工作：

- 上传视频、封面和字幕。
- 填写通用标题、描述、话题和发布时间。
- 选择要发布的平台和账号。
- 按平台微调标题、描述、标签、封面、可见范围。
- 查看上传中、待审核、已发布、失败、需人工处理等状态。
- 对失败任务执行重试或人工接管。

第一版不需要做复杂营销日历，但需要有清晰的任务列表和平台状态。

### 2. 内容库

内容库保存一条视频内容的主数据：

- 原始视频文件。
- 处理后的视频版本。
- 封面图。
- 字幕文件。
- 通用标题。
- 通用描述。
- 通用话题。
- 发布时间。
- 发布平台列表。
- 每个平台的覆盖配置。

文件第一版可以放本地磁盘，数据库里只保存路径和元数据。后续再替换为 S3、Cloudflare R2、阿里云 OSS 或 MinIO。

### 3. 视频处理器

视频处理器基于 FFmpeg 实现：

- 转换为 9:16 竖屏版本。
- 检查视频时长、分辨率、码率、文件大小。
- 生成封面候选帧。
- 按平台生成不同码率和分辨率版本。
- 可选：烧录字幕。
- 可选：横屏转竖屏背景模糊。

第一版只做必要校验和转码，不做复杂剪辑。

### 4. 平台适配器

每个平台实现同一组接口：

```ts
interface PublisherAdapter {
  platform: string;
  validate(task: PublishTask): Promise<ValidationResult>;
  prepare(task: PublishTask): Promise<PreparedAsset>;
  publish(task: PublishTask): Promise<PublishResult>;
  checkStatus(task: PublishTask): Promise<PublishStatus>;
  retry(task: PublishTask): Promise<PublishResult>;
}
```

官方 API 平台和浏览器自动化平台都用这套接口。上层任务系统不关心底层是 OAuth API 还是 Playwright。

### 5. 任务队列

任务队列负责稳定执行发布：

- 定时发布。
- 并发控制。
- 失败重试。
- 平台限流。
- 长任务状态轮询。
- 任务超时处理。
- 截图和日志留存。

推荐使用 Redis + BullMQ。Node.js 项目实现成本低，和 Playwright 也更自然。

### 6. 账号与凭证

账号分两类：

1. API 授权账号
   - YouTube
   - TikTok
   - Instagram
   - 抖音
   - 快手

2. 浏览器登录态账号
   - 微信视频号
   - 小红书
   - 其他没有稳定 API 的平台

凭证保存原则：

- OAuth token 加密存储。
- 浏览器 profile 按平台和账号隔离。
- 不保存明文密码。
- 首次登录通过本地扫码或手动登录完成。
- token 过期或登录态失效时，任务进入 `NEED_LOGIN` 状态。

## 推荐技术栈

| 模块 | 推荐技术 |
| --- | --- |
| 后端 API | Node.js + Fastify 或 NestJS |
| 前端 | React / Next.js |
| 队列 | Redis + BullMQ |
| 数据库 | PostgreSQL |
| 浏览器自动化 | Playwright |
| 视频处理 | FFmpeg |
| 文件存储 | 本地磁盘起步，后续可换 MinIO / OSS / R2 |
| 部署 | Docker Compose |
| 日志 | Pino + 文件日志 |
| 监控 | 第一版用任务状态表，后续接 Prometheus/Grafana |

如果要最快落地，建议使用 Node.js 全栈。Playwright、BullMQ、FFmpeg 调用和 Web 控制台都能在一个技术栈里完成。

## 当前开发版本

当前仓库已经具备第一版私有化骨架：

- npm workspace monorepo。
- TypeScript 共享领域模型。
- 内容记录和发布任务的内存服务。
- Fastify 本地 API。
- worker 发布处理器和平台适配器接口。
- React + Vite 私有控制台。
- Docker Compose 中的 PostgreSQL 和 Redis 预留服务。
- Vitest 覆盖平台模型、任务创建、API 路由和 worker 状态流。

当前还没有接真实平台 API，也没有持久化数据库。第一版实现先用内存服务验证任务流，下一阶段再接 PostgreSQL、Redis 队列、文件上传和真实平台适配器。

### 本地开发

安装依赖：

```bash
npm install
```

启动 API：

```bash
npm run dev:api
```

如果要调试 TikTok，且本机通过 Windows 侧 Clash/Mihomo 访问 TikTok，建议开启代理工具的 Allow LAN / 允许局域网连接，然后用带代理环境变量的脚本启动 API：

```bash
./scripts/run-api-tiktok-proxy.sh
```

脚本会从 WSL 的 `/etc/resolv.conf` 推导 Windows host IP，并默认使用 `http://<windows-host-ip>:8899`。也可以通过 `TIKTOK_PROXY_SERVER` 覆盖。Playwright 会优先使用 `TIKTOK_PROXY_SERVER`，其次使用 `PLAYWRIGHT_PROXY_SERVER`、`HTTPS_PROXY` 或 `HTTP_PROXY`。

启动 Web 控制台：

```bash
npm run dev:web
```

访问地址：

- API: <http://localhost:4000>
- Web: <http://localhost:5173>

验证命令：

```bash
npm test
npm run typecheck
npm run build
```

### 已实现接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | API 健康检查 |
| `GET` | `/platforms` | 获取平台接入配置 |
| `GET` | `/contents` | 获取内容列表 |
| `POST` | `/contents` | 创建内容记录 |
| `GET` | `/contents/:id` | 获取内容详情 |
| `POST` | `/contents/:id/publish-tasks` | 为内容创建平台发布任务 |
| `GET` | `/publish-tasks` | 获取发布任务列表 |
| `POST` | `/publish-tasks/:id/retry` | 重试发布任务 |
| `POST` | `/publish-tasks/:id/process` | 执行发布任务 |
| `POST` | `/publish-tasks/:id/save-draft` | 保存平台草稿任务 |
| `POST` | `/uploads?kind=video` | 上传本地视频到私有存储 |
| `POST` | `/uploads?kind=cover` | 上传本地封面到私有存储 |

### Bilibili 调试状态

Bilibili 已从本地模拟适配器切到真实浏览器适配器。它会使用 Playwright 打开 Bilibili 投稿页，并复用 `storage/browser-profiles/bilibili` 里的独立登录态。

第一次调试时建议只选择 Bilibili 一个平台，先点 **保存到平台草稿箱**。如果返回 `NEED_LOGIN`，系统会打开一个独立 Chromium 窗口，请在那个窗口登录 Bilibili，然后重新点击保存草稿或发布。其他浏览器里的 Bilibili 登录态不会自动共享到这个 profile。

状态语义：

- `WAITING_REVIEW`: Bilibili 投稿动作已提交，等待平台审核或页面最终确认。
- `SAVED_DRAFT`: Bilibili 草稿保存动作已提交。
- `NEED_LOGIN`: 独立 Bilibili profile 未登录。
- `NEED_MANUAL_ACTION`: 页面已打开但自动化无法可靠定位按钮或控件，需要人工接管。

### TikTok 调试状态

TikTok 已从本地模拟适配器切到真实 Playwright 浏览器适配器，保存草稿和创建发布都会打开 TikTok Studio 上传页：

```text
https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video
```

浏览器登录态使用独立 profile：`storage/browser-profiles/tiktok`。如果返回 `NEED_LOGIN`，请在自动打开的 Chromium 窗口里完成 TikTok 登录，然后回到控制台重试保存草稿或发布。其他浏览器里的 TikTok 登录态不会自动共享到这个 profile。

当前 TikTok 自动化已处理这些调试场景：

- 上传视频后会等待上传和处理状态结束，不能因为超时直接算完成。
- 图片/封面上传本身可正常使用，但保存草稿或发布必须等视频上传结束后再点。
- 如果页面出现新手引导、提示卡片或 onboarding 弹窗，会优先点击 `Got it`、`Skip`、`Next`、`Done`、`Not now` 等安全按钮尝试关闭。
- 发布时如果出现 `Continue to post?` / copyright check 未完成弹窗，会点击 `Post now` 继续发布。
- 保存草稿时如果出现二次确认弹窗，会点击 `Save draft`、`Confirm`、`OK` 或同义按钮继续保存。
- 如果页面已打开但按钮、登录态、风控或弹窗无法可靠处理，返回 `NEED_MANUAL_ACTION`，保留浏览器窗口供人工接管。

状态语义：

- `WAITING_REVIEW`: TikTok 发布动作已提交，等待平台审核或页面最终确认。
- `SAVED_DRAFT`: TikTok 草稿保存动作已提交。
- `NEED_LOGIN`: 独立 TikTok profile 未登录，或当前会话失效。
- `NEED_MANUAL_ACTION`: 页面已打开但需要人工完成登录、确认、风控或未知弹窗处理。

### 浏览器登录态约定

所有真实浏览器自动化平台都使用独立 profile 保存登录态：

- Bilibili: `storage/browser-profiles/bilibili`
- TikTok: `storage/browser-profiles/tiktok`
- 后续平台: `storage/browser-profiles/<platform>`

未接入真实浏览器适配器的平台不会再返回假成功；当平台配置为 `browser-automation` 但还没有专用适配器时，保存草稿和发布都会返回 `NEED_LOGIN`，并提供对应平台的发布入口链接，提示先在专用浏览器会话里注入登录态。

## 可复用开源项目

### social-auto-upload

仓库：<https://github.com/dreammis/social-auto-upload>

用途：

- 作为国内平台浏览器自动化的参考实现。
- 第一版可以把它作为子进程或 Python 包封装。
- 已提供抖音、快手、小红书、Bilibili 等 CLI 示例。

建议：

- 不直接把它当最终架构。
- 先封装为 `adapter`，只暴露登录检查和上传发布能力。
- 保留截图、日志和失败回放，方便页面变更后修复。

### biliup

仓库：<https://github.com/biliup/biliup>

用途：

- 如果要加 Bilibili，可以优先复用。
- 不影响第一版核心平台。

### Postiz

仓库：<https://github.com/gitroomhq/postiz-app>

用途：

- 参考海外社媒调度系统的产品形态。
- 参考账号连接、发布日历、队列和多平台状态 UI。

建议：

- 不建议直接基于 Postiz 改国内平台。
- 国内平台浏览器自动化和登录态管理会让改造成本变高。

## 核心数据模型

### `content_items`

保存一条内容的主记录。

| 字段 | 说明 |
| --- | --- |
| `id` | 内容 ID |
| `title` | 通用标题 |
| `description` | 通用描述 |
| `tags` | 通用标签 |
| `source_video_path` | 原始视频路径 |
| `cover_path` | 封面路径 |
| `subtitle_path` | 字幕路径 |
| `status` | 草稿、处理中、可发布、已归档 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### `platform_accounts`

保存平台账号信息。

| 字段 | 说明 |
| --- | --- |
| `id` | 账号 ID |
| `platform` | 平台 |
| `display_name` | 账号名称 |
| `auth_type` | `oauth` 或 `browser_profile` |
| `credential_ref` | 加密凭证引用 |
| `browser_profile_path` | 浏览器 profile 路径 |
| `status` | 正常、需登录、禁用 |

### `publish_tasks`

每个平台对应一条发布任务。

| 字段 | 说明 |
| --- | --- |
| `id` | 任务 ID |
| `content_id` | 内容 ID |
| `platform` | 平台 |
| `account_id` | 平台账号 |
| `title` | 平台标题 |
| `description` | 平台描述 |
| `tags` | 平台标签 |
| `scheduled_at` | 计划发布时间 |
| `status` | 任务状态 |
| `external_post_id` | 平台返回 ID |
| `external_url` | 发布链接 |
| `error_message` | 失败原因 |
| `last_screenshot_path` | 最近截图 |

### 任务状态

| 状态 | 含义 |
| --- | --- |
| `DRAFT` | 草稿 |
| `READY` | 已准备 |
| `PROCESSING_ASSET` | 视频处理中 |
| `QUEUED` | 等待发布 |
| `UPLOADING` | 上传中 |
| `PUBLISHING` | 发布中 |
| `WAITING_REVIEW` | 平台审核中 |
| `NEED_LOGIN` | 需要重新登录 |
| `NEED_MANUAL_ACTION` | 需要人工处理 |
| `PUBLISHED` | 已发布 |
| `FAILED` | 失败 |
| `CANCELLED` | 已取消 |

## 发布流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant UI as 发布控制台
    participant API as 后端 API
    participant Q as 任务队列
    participant V as 视频处理器
    participant P as 平台适配器
    participant S as 平台

    U->>UI: 上传视频并选择平台
    UI->>API: 创建内容和发布任务
    API->>Q: 投递处理任务
    Q->>V: 生成平台视频版本
    V->>Q: 返回处理结果
    Q->>P: 执行平台发布
    P->>S: API 发布或浏览器自动化发布
    S->>P: 返回状态
    P->>API: 写入状态、链接、日志、截图
    UI->>API: 轮询任务状态
    API->>UI: 展示发布结果
```

## 浏览器自动化策略

微信视频号和小红书第一版按浏览器自动化设计。

关键点：

- 使用 Playwright persistent context 保存登录态。
- 每个平台每个账号单独一个 profile。
- 首次运行打开真实浏览器，让用户扫码或手动登录。
- 上传、填标题、填话题、选择封面、点击发布由脚本完成。
- 需要验证码、扫码确认、敏感提示时暂停，状态置为 `NEED_MANUAL_ACTION`。
- 暂停时保留浏览器窗口，让用户接管。
- 每个关键步骤截图，失败时保存 HTML 和截图。

不做的事情：

- 不破解验证码。
- 不模拟异常高频行为。
- 不批量注册账号。
- 不绕过平台审核。

## 官方 API 平台策略

### YouTube

使用 `videos.insert` 上传视频和元数据。

注意事项：

- 需要 OAuth scope，例如 `youtube.upload`。
- 未审核 API 项目上传的视频可见性可能受限。
- 文档和配额页关于 `videos.insert` 的计费信息存在历史差异，开发时以 Google Cloud 控制台实际扣费为准。
- Shorts 通常由视频比例、时长和平台识别决定，不应只依赖 API 参数。

### TikTok

当前调试路径使用 TikTok Studio 网页端浏览器自动化，官方 Content Posting API 作为后续更稳定的 API 接入方向。

注意事项：

- 网页端上传页需要走 `https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video`，并复用 `storage/browser-profiles/tiktok` 登录态。
- WSL 内访问 TikTok 通常需要显式代理；本机代理只监听 Windows `127.0.0.1` 时，Playwright 不能直接复用，需要开启代理工具的 Allow LAN / 允许局域网连接。
- 保存草稿和发布前必须等待视频上传及页面处理状态结束。
- 页面可能出现新手引导、保存草稿二次确认、copyright check 未完成继续发布等弹窗，自动化需要先处理这些弹窗再继续。
- Direct Post 流程需要查询创作者信息、初始化发布、上传视频。
- `upload_url` 有有效期，需要队列及时完成上传。
- 未审核客户端发布内容可见性受限。
- 需要严格遵守 TikTok 对导出页和用户同意的 UX 要求。

### Instagram Reels

使用 Instagram / Meta Graph API 内容发布能力。

注意事项：

- 需要专业账号和相应权限。
- 发布通常是创建媒体容器、等待处理、再调用 publish。
- 视频文件 URL 需要公网可访问，且满足 Meta 对文件类型、长度和响应头的要求。
- 第一版可以先做 Instagram 单账号，避免一开始处理复杂 Business Manager 场景。

### 抖音

使用抖音开放平台视频上传和创建视频接口。

注意事项：

- 需要申请 `video.create.bind` 等发布能力。
- 发布接口需要用户授权。
- 创建视频后会进入审核流程，审核期间可能只有自己可见。
- 标题、话题、@用户、POI、小程序锚点等都需要按平台规则处理。

### 快手

使用快手开放平台创建视频流程。

注意事项：

- 创建视频需要发起上传、上传视频、发布视频。
- 大文件建议走分片上传。
- 上传成功不等于发布成功，需要查询或确认最终状态。
- 若开放平台能力申请受限，可以临时用浏览器自动化兜底。

## MVP 范围

第一版建议只做这些能力：

1. 本地 Web 控制台。
2. 单用户使用。
3. 本地文件存储。
4. PostgreSQL 保存任务和账号。
5. Redis + BullMQ 处理队列。
6. FFmpeg 基础校验和封面抽帧。
7. YouTube API 适配器。
8. 抖音 API 或 `social-auto-upload` 适配器二选一。
9. 小红书 Playwright 适配器。
10. 微信视频号 Playwright 适配器。
11. 任务状态、日志、截图、失败重试。
12. 人工接管入口。

暂不做：

- 多团队权限。
- 收费订阅。
- 复杂数据分析。
- AI 文案生成。
- 自动评论私信。
- 大规模账号矩阵。
- 云端公开 SaaS。

## 建议目录结构

```text
video-combine/
  README.md
  apps/
    web/                 # 发布控制台
    api/                 # 后端 API
    worker/              # 队列 worker
  packages/
    adapters/            # 平台适配器
      youtube/
      tiktok/
      instagram/
      douyin/
      kuaishou/
      xiaohongshu/
      wechat-channels/
    video/               # FFmpeg 处理封装
    shared/              # 类型、工具、常量
  storage/
    uploads/             # 原始上传
    processed/           # 处理后视频
    covers/              # 封面
    screenshots/         # 自动化截图
    browser-profiles/    # 浏览器登录态
  docker-compose.yml
  .env.example
```

## 实施路线

### 第 0 阶段：项目骨架

- 初始化 Node.js monorepo。
- 配置 Docker Compose。
- 启动 PostgreSQL 和 Redis。
- 建立 API、worker、web 三个应用。
- 建立统一任务表和状态枚举。

验收标准：

- 能创建内容记录。
- 能创建发布任务。
- worker 能消费任务并写回状态。

### 第 1 阶段：内容上传与视频处理

- Web 控制台上传视频。
- 后端保存文件和元数据。
- FFmpeg 检查时长、分辨率、格式。
- 抽取封面帧。
- 生成平台处理结果。

验收标准：

- 上传一条视频后，可以看到视频信息和封面。
- 不符合规格的视频能给出明确错误。

### 第 2 阶段：YouTube 适配器

- 接入 Google OAuth。
- 保存 refresh token。
- 上传视频到 YouTube。
- 写回平台 video id 和链接。

验收标准：

- 能从控制台发布一条公开视频或不公开视频到 YouTube。
- 失败时能看到 API 错误和重试入口。

### 第 3 阶段：浏览器自动化基座

- 封装 Playwright persistent context。
- 建立账号 profile 管理。
- 建立截图和日志系统。
- 建立人工接管机制。

验收标准：

- 能打开某个平台的登录页。
- 登录态能在下次任务复用。
- 需要人工操作时任务不会直接失败。

### 第 4 阶段：小红书和视频号

- 接入小红书创作平台发布流程。
- 接入视频号助手发布流程。
- 支持上传视频、填写标题描述、选择封面、提交发布。
- 页面结构变化时能通过截图定位问题。

验收标准：

- 两个平台至少各成功发布一条测试内容。
- 登录失效时进入 `NEED_LOGIN`。
- 验证码或扫码确认时进入 `NEED_MANUAL_ACTION`。

### 第 5 阶段：抖音和快手

优先尝试官方 API。若权限申请周期较长，先封装 `social-auto-upload`。

验收标准：

- 抖音和快手至少各有一种可用发布路径。
- 状态、失败原因、截图和重试行为统一。

### 第 6 阶段：TikTok 和 Instagram

- TikTok 接入 Content Posting API。
- Instagram 接入 Graph API 发布 Reels。
- 配置应用审核所需的回调、权限和隐私说明。

验收标准：

- TikTok 能完成授权和测试发布。
- Instagram 能完成 Reels 容器创建、处理轮询和发布。

## 配置规划

`.env` 建议包含：

```bash
DATABASE_URL=postgresql://video_combine:password@localhost:5432/video_combine
REDIS_URL=redis://localhost:6379
STORAGE_ROOT=./storage
APP_BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_PROXY_SERVER=

META_APP_ID=
META_APP_SECRET=

DOUYIN_CLIENT_KEY=
DOUYIN_CLIENT_SECRET=

KUAISHOU_APP_ID=
KUAISHOU_APP_SECRET=

ENCRYPTION_KEY=
```

## 安全和合规

必须遵守：

- 只发布你有权发布的视频、音乐、图片和文案。
- 遵守各平台的开放平台协议和社区规范。
- 不做验证码破解、批量注册、黑产接口和异常高频行为。
- 不把账号密码和浏览器 profile 上传到第三方。
- 浏览器自动化只用于降低重复劳动，不用于绕过平台限制。

建议：

- 使用单独的发布机器或本地服务器。
- 每个平台账号单独 profile。
- 定期备份数据库和 `storage`。
- 敏感凭证加密存储。
- 发布前保留人工预览。

## 第一版验收标准

当以下目标达成，就算第一版可用：

- 可以在本地打开发布控制台。
- 可以上传一条视频并创建多个平台发布任务。
- 可以看到每个平台独立状态。
- YouTube 至少能通过官方 API 发布。
- 小红书和视频号至少能通过浏览器自动化半自动发布。
- 登录失效、验证码、页面变化不会静默失败。
- 每次失败都有日志、截图和可操作的下一步。
- 能手动重试单个平台，不影响其他平台结果。

## 风险清单

| 风险 | 影响 | 处理方式 |
| --- | --- | --- |
| 小红书、视频号页面改版 | 自动化失效 | 保留截图、HTML 快照和人工接管；适配器独立维护。 |
| 平台 API 权限申请失败 | 无法官方发布 | 先用浏览器自动化或半自动流程兜底。 |
| OAuth token 过期 | 发布失败 | 自动 refresh，失败后进入 `NEED_LOGIN`。 |
| 平台审核延迟 | 状态不确定 | 增加 `WAITING_REVIEW`，定时轮询或人工确认。 |
| 视频规格不符合 | 上传失败 | 发布前用 FFmpeg 校验并提示。 |
| 多平台文案限制不同 | 发布失败或效果差 | 每个平台允许单独覆盖标题、描述和话题。 |
| 风控或验证码 | 自动化中断 | 不破解，暂停并让用户接管。 |

## 后续增强

第一版稳定后再考虑：

- 发布日历。
- 批量导入内容。
- 多账号矩阵。
- AI 平台文案改写。
- 自动生成封面。
- 自动字幕。
- 发布后数据回收。
- 评论和私信统一管理。
- 移动端控制台。
- 浏览器自动化录制和回放工具。

## 参考资料

- YouTube Data API `videos.insert`: <https://developers.google.com/youtube/v3/docs/videos/insert>
- YouTube Data API Quota Calculator: <https://developers.google.com/youtube/v3/determine_quota_cost>
- TikTok Content Posting API Direct Post: <https://developers.tiktok.com/doc/content-posting-api-reference-direct-post>
- Instagram Content Publishing: <https://developers.facebook.com/docs/instagram-api/guides/content-publishing>
- 抖音开放平台创建视频: <https://partner.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create>
- 快手开放平台创建视频: <https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo.html>
- social-auto-upload: <https://github.com/dreammis/social-auto-upload>
- biliup: <https://github.com/biliup/biliup>
- Postiz: <https://github.com/gitroomhq/postiz-app>
