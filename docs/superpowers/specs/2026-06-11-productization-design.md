# UltraCreator 产品化总设计

日期:2026-06-11
状态:已确认(用户于 brainstorm 中逐项确认)

## 0. 目标与范围

把 UltraCreator 从原型升级为正式产品,包含五个耦合的子系统,一份总设计、分阶段实施:

1. PostgreSQL 数据层(用户、会话、事件、artifact、消息队列落库)
2. 认证(本期仅 Google 登录,预留邮箱登录位置)
3. 任务持久化与自动恢复(关网页续跑 + 服务重启自动恢复,**核心需求**)
4. GCS 存储(重媒体归档 YOUR_PRIVATE_BUCKET、本地清理、签名 URL 回源)
5. 营销主页(未登录用户看到的英文 landing page)

### 用户已拍板的决策

| 决策点 | 结论 |
|---|---|
| 组织方式 | 一份总设计,分 5 阶段实施 |
| 认证方案 | Better Auth |
| 登录方式 | 本期仅 Google 登录;邮箱登录预留 UI 位置与数据模型,后续再加 |
| 服务重启时运行中的任务 | 自动恢复(队列落库 + 启动扫描 + 从中断阶段重跑) |
| GCS 范围 | 重媒体全部进桶,渲染完成校验后清理本地;小 JSON 与事件进 PG |
| 主页语言 | 英文优先,面向全球市场;无定价区块 |

### 不在本期范围

- 邮箱登录/注册的实际功能(仅预留)
- 邮件发送服务
- 多实例部署与任务争抢(假设单实例)
- i18n / 中文主页
- 定价与支付
- 既有开发期 workspaces 数据迁移(测试数据,直接弃用)

## 1. 总体架构与阶段划分

技术栈不变:Next.js 15(apps/web)+ Fastify 5(apps/server)+ packages/shared,pnpm monorepo。新增三个基础设施层:PostgreSQL(Drizzle ORM)、Better Auth、GCS 客户端(@google-cloud/storage)。

实施按依赖顺序分 5 个阶段,每阶段独立可验收:

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| ① 数据层+认证 | PG 接入、Drizzle、Better Auth(Google)、登录页、路由守卫、侧边栏用户区+退出 | 能用 Google 登录;未登录访问 `/s/*` 被拦截 |
| ② 会话归属落库 | 会话/事件/artifact 入 PG,会话列表按用户隔离,移除 localStorage 列表 | 换浏览器登录同账号能看到自己的全部会话 |
| ③ 任务自动恢复 | 消息队列落库,启动扫描恢复中断任务 | 任务跑一半 kill 服务再启动,任务自动续跑 |
| ④ GCS 存储 | 渲染完归档重媒体→校验→清本地;签名 URL 回源;缺失文件自动拉回 | 删掉本地 mp4 后前端仍能播放 |
| ⑤ 营销主页 | 未登录 `/` 显示英文 landing page | 未登录看到主页,登录后看到现有应用 |

ORM 选 Drizzle:SQL-first、轻量、Better Auth 有官方适配器,认证表与业务表共用一套 drizzle-kit migration。

## 2. 数据模型(PostgreSQL)

连接:`postgres://admin@localhost:5432/ultracreator`,经 `DATABASE_URL` 配置。

### Better Auth 生成的表

`user`、`session`(登录态)、`account`(一个用户可挂多个登录方式:Google 现在用,邮箱将来加,同邮箱自动归并)、`verification`。表结构由 Better Auth CLI 生成,纳入 drizzle migration。

### 业务表

业务会话表命名为 `creator_sessions`,避免与认证 `session` 表混淆。

```
creator_sessions
  id            uuid PK(即 sid)
  user_id       FK → user.id
  title         text(取首条用户消息截断)
  status        enum: idle | running | awaiting-gate | error | done
  current_phase text nullable(PhaseId)
  error         text nullable
  created_at / updated_at timestamptz

session_events                     —— 取代 workspaces/<sid>/logs/events.jsonl
  id            bigserial PK
  session_id    FK → creator_sessions.id
  seq           int(会话内递增;unique(session_id, seq))
  at            timestamptz
  event         jsonb(ServerEvent 原样)

artifacts                          —— 取代 workspaces/<sid>/artifacts/*.json + index.json
  id            bigserial PK
  session_id    FK → creator_sessions.id
  kind          text(ArtifactKind)
  version       int(unique(session_id, kind, version))
  data          jsonb(媒体文件仍存磁盘/GCS,JSON 中保存相对路径)
  derived_from  jsonb nullable
  stale         boolean default false
  created_at    timestamptz

session_messages                   —— 持久化消息队列,自动恢复的基础
  id            bigserial PK
  session_id    FK → creator_sessions.id
  payload       jsonb(UserMessage)
  status        enum: pending | processing | done | error
  created_at / started_at / finished_at timestamptz
```

写入策略:`session_events` 高频(agent.text 流式片段),事件日志组件做约 100ms 的批量缓冲后批插;SSE 重放改为按 `seq > Last-Event-Id` 查 PG。`creator_sessions.status/current_phase` 在每次状态迁移时更新,会话列表无需重放事件。

文件目录结构(uploads/composition/output)保持不变,仍由 WorkspaceManager 管理。

## 3. 认证(Better Auth,本期仅 Google)

- Better Auth 挂在 **Fastify** 上(`/api/auth/*` 路由),因为需要鉴权的 SSE 流和任务接口都在 Fastify 侧。登录态:httpOnly cookie + PG `session` 表。
- **同源改造**:前端现状是 `NEXT_PUBLIC_API_URL` 跨域直连 :3001。改为 Next rewrites 把 `/api/*` 代理到 Fastify,前后端同源,cookie 自然生效;生产环境用同域反向代理。
  - ⚠️ 风险:SSE 经 Next rewrites 的流式转发需要先验证(阶段①第一件事)。若有缓冲问题,退路是保持跨域直连 + `credentials: "include"` + CORS 白名单(localhost 不同端口属同站点,cookie 可送达)。
- **Fastify 守卫**:auth preHandler 解析 cookie → 注入 `userId`;全部 `/api/sessions*` 路由要求登录,并校验 `creator_sessions.user_id` 归属,非本人返回 404。
- **Web 守卫**:`/s/*` 未登录重定向 `/`;`/` 由服务端组件判断登录态:已登录 → 渲染现有应用首页(模式选择 + 侧边栏),未登录 → 渲染营销主页。
- **Google 配置**:clientId/secret 走 env。`accountLinking` 开启且 `trustedProviders: ["google"]`——未来加邮箱注册时,同邮箱自动并入既有用户(Google 邮箱已验证,以其为准,避免占号攻击)。
- **登录页 `/login`**:Google 按钮 + 预留邮箱表单位置(disabled / Coming soon),登录成功回跳原页面(`callbackURL`)。
- **侧边栏左下角用户区**:Google 头像 + 名字 + 邮箱,下拉菜单含"退出登录"(better-auth signOut → 回营销主页)。

## 4. 任务持久化与自动恢复

- 流程:用户发消息 → 插入 `session_messages`(pending)→ orchestrator 取出标记 processing → 跑阶段管线 → done/error。每个阶段开始/结束更新 `creator_sessions.status/current_phase`。
- **关网页续跑**(核心需求):任务在服务端运行,与浏览器连接无关——现架构已保证。本设计补齐两点:会话列表落库跟用户走;SSE 按 `Last-Event-Id` 从 PG 重放。重新进入会话即恢复完整输出流,运行中的任务继续推送。
- **服务重启恢复**:启动时扫描 `session_messages` 中 status ∈ (pending, processing) → 重新入队。已完成阶段的 artifact 在 PG,管线从中断阶段接着跑;阶段幂等(重跑产出新版本 artifact)。渲染子进程随服务死亡时,重跑 render 阶段。
- 恢复启动的阶段照常发 `phase.started` 等事件,前端无需特殊处理。
- 单实例假设:不做 `SELECT ... FOR UPDATE SKIP LOCKED` 等多实例争抢,留作未来扩展点(队列已落库,扩展成本低)。

## 5. GCS 存储层

- 库:官方 `@google-cloud/storage`;桶:`YOUR_PRIVATE_BUCKET`(env `GCS_BUCKET`);凭证:`apps/server/secrets/gcp-service-account.json`,**加入 .gitignore 绝不入库**,经 `GOOGLE_APPLICATION_CREDENTIALS` 引用。
- **对象键约定**(确定性映射,无需文件注册表):`users/<userId>/sessions/<sid>/<workspace 内相对路径>`。
- **归档时机**:`render.done` 后台触发。上传范围:成品 mp4/srt、配音与音乐音频、生成图、用户上传件(即"重媒体")。逐文件用 GCS 返回的 size/crc32c 校验,**校验通过才删本地**;失败保留本地、指数退避重试,不阻塞用户(本地文件还在,照常可看)。
- **文件服务**:`GET /api/sessions/:sid/files/*`:本地命中 → 现有流式返回(含 Range);本地 miss → 按键约定查 GCS → 存在则 302 重定向到 V4 签名 URL(15 分钟 TTL);都没有 → 404。签名 URL 原生支持 Range,`<video>` 拖动无碍;签名过期后播放器重新请求本接口换新签名。
- **拉回机制**:WorkspaceManager 增加 `ensureLocal(relPath)`——阶段重跑(用户微调后重渲染等)所需文件本地缺失时,自动从 GCS 下载回本地。
- **删除会话**:同时清理 PG 行(级联)、本地 workspace、GCS 前缀 `users/<uid>/sessions/<sid>/`。
- 营销主页自身的静态资源走 Next `/public`,不进桶。

## 6. 前端改造

- **营销主页**(未登录 `/`,英文):
  - sticky header:logo、锚点导航(Features / FAQ)、Sign in CTA
  - hero:标题/副标题/主 CTA(Get started → /login)/产品界面视觉
  - features:以六阶段管线为卖点(prompt → research → design → script → voiceover → compose/render),配合现有 seed gallery 的视觉素材
  - FAQ:手风琴组件
  - footer:链接、版权
  - 无定价区块。视觉延续应用现有设计语言;实现阶段使用 frontend-design 技能保证质感。
- **登录页 `/login`**:Google 登录按钮 + disabled 的邮箱表单位。
- **侧边栏**:会话列表改为 `GET /api/sessions`(返回当前用户的 id/title/status/createdAt,按时间倒序);删除 `uc.sessions.v1` localStorage 逻辑;底部新增用户区(头像/名/邮箱/退出下拉)。
- **会话标题**:首条用户消息截断后写入 `creator_sessions.title`(原 localStorage 同款逻辑移到服务端,创建后首条消息时落库)。
- 新增 API:`GET /api/sessions`(列表);现有 `POST /api/sessions`、`DELETE` 等全部加归属。

## 7. 安全与密钥

- 新增 env(`.env`,已 gitignore):
  - `DATABASE_URL=postgres://admin@localhost:5432/ultracreator`
  - `BETTER_AUTH_SECRET`(随机生成)
  - `BETTER_AUTH_URL`(应用对外地址)
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  - `GCS_BUCKET=YOUR_PRIVATE_BUCKET`
  - `GOOGLE_APPLICATION_CREDENTIALS=apps/server/secrets/gcp-service-account.json`
- ⚠️ Google OAuth secret 与 GCP service account key 曾在聊天中明文出现,建议正式上线前在 Google Console 轮换一次。本设计保证密钥只存在于 gitignore 的文件中。
- 前端永远拿不到桶路径,只经签名 URL(临时凭证)访问。
- 上传接口沿用现有 multipart 校验;所有会话资源接口都有归属校验。

## 8. 错误处理

- PG 不可达:服务启动即失败,明确报错;运行中连接池错误 → 503。
- GCS 上传失败:本地不删、退避重试,不影响用户观看(本地仍在)。
- 本地与 GCS 双 miss:404 + 明确错误信息。
- 未登录/越权:401(未登录)/404(越权),前端统一跳转登录或主页。
- 阶段执行错误:沿用现有 `phase.error` 事件机制。
- 签名 URL 过期:播放器重新请求文件接口换取新签名。

## 9. 测试策略

沿用 vitest + 现有 fake 模式:

- **单元测试**:GCS 抽象为 StorageGateway 接口,测试用内存实现;路由测试注入 fake 登录态;orchestrator 测试用 fake 队列存储。
- **集成测试**:连本地真实 PG 的独立库 `ultracreator_test`,setup 跑 drizzle migration,teardown 清库。覆盖:事件批量写入与 SSE 重放、消息队列状态机、归属隔离。
- **自动恢复**:专门的集成测试模拟"处理中消息 + 进程重启"(重建 orchestrator 实例),断言任务从中断阶段续跑。
- **Google OAuth 全流程**:依赖真实 Google 回调,留人工验证清单。
- 现有测试(orchestrator、phases、routes)随接口改造同步更新,文件级事件日志/Artifact 存储的测试改为对应 PG 实现或接口 fake。
