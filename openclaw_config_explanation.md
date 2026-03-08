# OpenClaw 配置文件 (openclaw.json) 说明文档

这份文档基于 [OpenClaw 官方配置说明](https://docs.openclaw.ai/zh-CN/gateway/configuration) 与当前提供的 `openclaw.json`，详细解释了各个配置模块及其作用。

## 1. `meta` (元数据)
记录了配置文件的版本信息和最近一次的修改时间：
- **`lastTouchedVersion`**: 记录使用的 OpenClaw 版本号 (`2026.2.22-2`)。
- **`lastTouchedAt`**: 配置上次被修改或访问的时间戳。

## 2. `env` (环境变量)
配置项目中所需的各种安全凭证和变量，这些变量可以在配置文件的其他地方通过 `${VAR_NAME}` 引用。
- **`BRAVE_*`**: Brave 搜索引擎 API 密钥（用于 AI 联网搜索和智能问答）。
- **`BAILIAN_*`**: 阿里云百炼服务平台的基础 URL 和 API 密钥。
- **`WECOM_STT_*`**: 企业微信相关的语音识别参数配置（调用了阿里的 `qwen3-asr-flash` 模型接口，用于将企业微信收到的语音消息转化为文字）。

## 3. `models` (模型配置)
负责定义供 OpenClaw 使用的大语言模型及提供商。
- **`mode`**: 设置为 `"merge"`，表示合并现有配置及加载这里补充的自定义模型（而不是全部直接覆盖）。
- **`providers`**: 定义了两个主要的模型供应商：
  1. **`oldbird`**:
     - 本地局域网内基于 API 接口的服务提供商 (`http://192.168.3.118:8086/v1`)，兼容 `openai-completions` API 格式。
     - 提供模型 `Qwen3-Coder-Next_Q6_K`（适合用于代码处理任务的自定义模型）。
  2. **`bailian`**:
     - 阿里云百炼的模型提供商接口。
     - 提供了两个多模型：`qwen3.5-plus`（文本或多模态主力模型）和 `qwen3-vl-plus`（视觉识别加强多模态模型）。

## 4. `agents` (智能体配置)
负责管理和定义 AI 机器人的身份、模型映射及运行沙盒行为。

### `defaults` (全局默认配置)
适用于所有未单独指定配置的智能体（回退配置）。
- **`model.primary`**: 系统默认首选的主力模型设定为 `"bailian/qwen3.5-plus"`。
- **`models`**: 为使用的特定模型配置用户友好的别名（Alias），如 `Qwen3.5-Plus`，避免控制台太长。
- **`workspace`**: 规定智能体默认文件操作的工作区根目录 (`/home/oldbird/.openclaw/workspace`)。
- **`compaction.mode`**: `"safeguard"`，对于较长的会话历史进行安全的内容压缩裁剪，以平衡开销与记忆能力。
- **`maxConcurrent`** / **`subagents.maxConcurrent`**: 最大并发处理会话请求或子智能体调用的数量。

### `list` (智能体列表)
声明了系统运行的两个智能体实例：
- **`main`**: (`id: "main"`) 系统默认的主力聊天助手，未单独定制所以它直接继承 `defaults` 的设置。
- **`news-analyst`**: 被命名为“新闻分析师”的专用智能体：
  - **`workspace` / `agentDir`**: 采用独立的文件路径 `/home/oldbird/.openclaw/workspace-news-analyst`。
  - **`sandbox`**: 挂钩了高级文件系统安全沙箱管控：
    - `mode: "all"`（全面沙箱管控）。
    - `scope: "agent"`（此沙箱环境仅跟该智能体隔离绑定）。
    - `workspaceAccess: "ro"`（关键设置）：向智能体限定了工作区的 **只读权限 (Read-Only)**。意味着这位“新闻分析师”只能阅览文件不得随意修改删除。

## 5. `tools` (工具配置)
管理系统启用哪些工具供智能体动态调用。
- **`web.search`**: 启用了网页搜索功能并配合使用了前面在环境变量出现的 `brave` 引擎。
- **`media`**: 开启了图片、音频和视频的分析或处理功能。

## 6. `messages`, `commands`, `session` 与 `hooks` (系统流控设置)
- **`messages.ackReactionScope`**: `"group-mentions"` 表示当涉及群聊时，AI 只会在用户主动 `@提及` 时回复反应态度（比如接收中先发送确认点赞），防止多管闲事乱插话。
- **`commands`**: 定义核心聊天控制台内的系统指令允许情况。`restart: true` 表明允许通过网关命令重启。
- **`session.dmScope`**: `"per-channel-peer"`，会话隔离级别在各频道下单聊范围内独立保存上下文流（比如企微私聊时，上下文不会串给他人）。
- **`hooks`**: 设定了网关加载启动等过程使用的内部系统微钩子机制，如加载会话记忆等。

## 7. `channels` (接入渠道配置)
配置机器人连接的通信端——这里启用了 `wecom` (企业微信) 的双开支持多账号（Accounts）：
1. **`default`**: 主机器人的企微应用（`agentId: 1000002`），用于大范围默认交互，使用路由地址 `/wecom/callback`。
2. **`news`**: 另外配置的一个新闻推报/分析机器人应用（`agentId: 1000004`），独立拥有鉴权和 Token，回调地址为 `/wecom/news`。
利用这一设定，系统能在企业微信里运营着职责不同的多个应用分身。

## 8. `gateway` (网关与网络安全配置)
这是 OpenClaw HTTP / WebSocket 后端控制服务网络设置。
- **`port`**: `18789`（默认内部数据及网关接口多路复用端口）。
- **`mode`**: `"local"`（本地模式，不进行大外网暴露）。
- **`bind`**: `"lan"`（绑定局域网，允许同一 WIFI 或内网机器使用控制端）。
- **`auth`**: `"token"`，调用控制台和连接 API 接口必须携带设定的 Token 值以保证网关调用安全。
- **`tailscale.mode`**: `"off"`，由于使用的是局域网而非异地穿透，在此尚未开启 Tailscale 功能。
- **`nodes.denyCommands`**: 终端安全黑名单配置。在这个网关上系统默认切断和去除了拍照、录音、联系人日历读写等高风险系统指令，这在 Linux 云服务器上是非常合理的安全防护。

## 9. `skills` 与 `plugins` (技能和插件拓展)
- **`skills`**: 指定系统为代码自动生成等环境使用包管理工具为 `"npm"`。
- **`plugins`**: 这是让开源平台支持微信扩展插件的关键。
  - `load.paths`: 直接指定路径指向当前的本地工程 `/home/oldbird/.openclaw/plugins/openclaw-wechat`，热加载自定义企微插件。
  - `entries.wecom.enabled`: `true`。显式启用 `wecom` 插件以建立与企业通信服务器的联络。

## 10. `bindings` (多智能体路由规则)
将外部产生的消息经过分析后分发转交到专属负责的那位 Agent，这部分体现了多 Agent 路由。
- **规则 1**: 如果消息来源于 `wecom` 渠道且对应应用账号的 ID 为 `news`，则系统动态路由至 `news-analyst` (新闻分析师) 来处理这批情报分析。
- **规则 2**: 如果是来源于 `wecom` 渠道的 `default` 通讯录常规账号，就自动交给 `main` (具备主模型默认全部权限的核心中控智能体) 来解答解决。

---
### 总结
整体而言，这是一个结构清晰且具备一定安全机制的企业级双 AI 应用配置。利用局域网、本地加代理多模型调度（结合自己训练的模型与阿里云模型），并通过统一底座利用多账户和灵活的路由机制，在同一套系统结构下无缝运行着“全能主控”与“基于局域网只读沙盒的新闻分析员”这两个企微服务机器人。
