# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] - 2026-02-25

### Fixed

#### 多应用 access_token 缓存 Bug
- **修复同企业多应用 token 互相覆盖**：`getWecomAccessToken()` 缓存 key 从 `corpId` 改为 `corpId:corpSecret`，同一企业下不同自建应用（各有独立 Secret）的 access_token 现在正确隔离

### Added

#### 多应用多智能体路由增强
- **`openclaw.plugin.json` 多应用 schema**：新增 `accounts` 子对象定义，OpenClaw 核心能正确识别多应用配置结构
- **`/status` 命令增强**：显示所有已配置应用的路由映射（accountId → webhook → agentId）
- **启动日志增强**：显示已发现的账户数量和每个应用的 webhook/agentId/corpId 信息；多应用模式时输出提示

#### 多模态媒体管线 (Media Pipeline)
- **图片**：下载后通过 `ctxPayload.MediaPath` 传给 OpenClaw 核心，由多模态 LLM（如 Qwen 3.5）直接理解图片内容
- **语音**：始终下载并转换为 WAV，通过 MediaPath 传给 OpenClaw 核心；保留本地 FunASR STT 作为降级方案
- **视频**：下载后通过 MediaPath 传给 OpenClaw 核心处理
- **文件**：非文本类文件通过 MediaPath 传给 OpenClaw 核心；文本类文件同时提取内容作为上下文
- 移除硬编码的 `doc_processor.py` 路径依赖

### Changed
- README 多智能体路由章节重写，新增完整的「多应用多 Agent」配置指南和架构图
- 媒体处理走 OpenClaw MediaPath 多模态管线，不再依赖工具调用读取文件
- 插件版本升级至 0.4.1

## [0.4.0] - 2026-02-25

### Added

#### 多智能体路由支持 (Multi-Agent Routing)
- **绑定匹配 (Binding Match)**：`resolveAgentRoute` 调用现在传入 `peer` 信息（区分 `dm`/`group`），支持 `openclaw.json` 中的 `bindings` 配置按 peer/accountId/channel 精确匹配到不同智能体
- **会话隔离**：session key 格式从 `wecom:<accountId>:<user>` 升级为 `agent:<agentId>:wecom:<accountId>:<user>`，与官方 Telegram 渠道一致，不同智能体的会话完全隔离
- **Transcript 多智能体目录**：`writeToTranscript` 现在根据 `agentId` 动态定位 `~/.openclaw/agents/<agentId>/sessions/`，不再硬编码 `agents/main/`
- **对话历史隔离**：内存中的对话历史按 `agentId` 隔离的 session key 存储
- **`/status` 命令增强**：显示当前智能体 ID
- **插件能力声明**：`capabilities.multiAgent: true`

### Changed
- Outbound `sendText`/`sendMedia`/`deliverReply` 方法的 `accountId` 提取正则更新，兼容 `agent:<agentId>:wecom:<accountId>:...` 和传统 `wecom:<accountId>:...` 两种格式
- `writeToTranscript` 优先使用 `OPENCLAW_STATE_DIR` 环境变量，回退到 `CLAWDBOT_STATE_DIR`，最后回退到 `~/.openclaw`
- `/clear` 命令使用路由解析后的 session key（含 agentId），确保只清除目标智能体的会话
- 插件版本升级至 0.4.0

## [0.3.5] - 2026-02-22

### Changed
- **插件 ID 重命名**：`clawdbot-wecom` → `wecom`，与渠道名保持一致
- **包名重命名**：`@mijia-life/clawdbot-wecom` → `@openclaw/wecom`
- **临时目录重命名**：`clawdbot-wecom` → `openclaw-wecom`
- 更新 README、CLAUDE.md 中相关引用

## [0.3.3] - 2026-02-18

### Fixed

#### Outbound 消息支持
- **修复 outbound 配置不生效问题**：OpenClaw 核心要求插件同时提供 `sendText` 和 `sendMedia`，之前只有 `sendText`，导致 `createPluginHandler` 返回 null，outbound 被判定为未配置
- **新增 `outbound.sendMedia`**：支持通过 outbound 发送图片，失败时降级为文本+链接
- **修复 `listAccountIds` 兼容性**：支持扁平配置（无 `accounts` 字段时），从顶层 `channels.wecom.corpId` 推断默认账户
- **修复 `resolveAccount` 兼容性**：无 `accounts` 字段时，直接返回顶层 wecom 配置

### Impact
- 修复了 cron 定时任务、`message` tool 等通过 wecom outbound 发送消息失败的问题
- isolated session 现在可以正常通过 wecom 主动发送消息

## [0.3.2] - 2026-01-29

### Added

#### 媒体消息扩展
- **视频消息接收**：支持接收用户发送的视频，自动下载保存到临时目录
- **视频消息发送**：新增 `sendWecomVideo()` 函数，支持发送视频到企业微信
- **文件消息接收**：支持接收用户发送的文件/文档，自动识别可读类型（.txt, .md, .json, .pdf 等）
- **文件消息发送**：新增 `sendWecomFile()` 函数，支持发送文件到企业微信
- **链接分享消息**：支持接收用户分享的链接，提取标题、描述和 URL

#### Chat UI 集成
- **消息同步到 Transcript**：用户消息和 AI 回复写入 session transcript 文件
- **实时广播**：通过 gateway broadcast 实时推送消息到 Chat UI
- **Gateway 方法**：新增 `wecom.init` 和 `wecom.broadcast` 方法

### Changed
- `processInboundMessage()` 函数签名扩展，支持更多消息类型参数
- HTTP 路由处理器新增 video、file、link 类型消息分发

## [0.3.1] - 2026-01-28

### Fixed
- **消息分段按字节计算**：企业微信限制 2048 字节（非字符），中文占 3 字节，修复长消息被截断问题
- **新增 getByteLength() 函数**：精确计算 UTF-8 字节长度
- **二分查找分割点**：使用二分查找算法精确定位字节分割位置

### Added
- **处理状态提示**：收到消息后立即发送"⏳ 收到您的消息，正在处理中，请稍候..."，缓解用户等待焦虑
- **详细调试日志**：记录分段数量、字节长度等信息便于排查问题

## [0.3.0] - 2026-01-28

### Added

#### 阶段一：核心稳定性
- **Token 并发安全**：使用 Promise 锁防止多个请求同时刷新 access_token
- **消息自动分段**：超过 2048 字符的消息自动在自然断点处分割发送
- **XML 安全加固**：禁用实体处理防止 XXE 攻击，添加 1MB 请求体限制
- **错误处理完善**：记录完整堆栈日志，二次发送失败不再吞没异常

#### 阶段二：媒体功能
- **图片上传**：新增 `uploadWecomMedia()` 函数上传临时素材
- **图片发送**：新增 `sendWecomImage()` 函数发送图片消息
- **图片 Vision**：下载用户图片保存到临时文件，AI 可读取分析
- **deliverReply 媒体支持**：支持 `mediaUrl` 和 `mediaType` 参数

#### 阶段三：用户体验
- **命令系统**：支持 `/help`、`/status`、`/clear` 命令
- **Markdown 转换**：AI 回复中的 Markdown 自动转换为可读纯文本格式
- **API 限流**：RateLimiter 类限制并发（最多 3 个）和频率（200ms 间隔）

#### 阶段四：高级功能
- **多账户支持**：Token 缓存按账户隔离，支持 `WECOM_<ACCOUNT>_*` 格式配置
- **语音转文字**：支持企业微信自带语音识别（Recognition 字段）
- **群聊支持**：capabilities 支持 group 类型，群聊会话 ID 格式 `wecom:group:<chatId>`

### Changed
- `capabilities.media.outbound` 改为 `true`
- `capabilities.markdown` 改为 `true`
- `capabilities.chatTypes` 改为 `["direct", "group"]`
- 插件版本升级至 0.3.0

### Fixed
- 修正 capabilities 声明与实际实现不符的问题
- 修复长消息可能导致发送失败的问题

## [0.1.0] - 2026-01-27

### Added
- 初始版本
- 基础文本消息收发
- 消息加解密和签名验证
- access_token 缓存
- 图片消息接收（仅传 URL）
