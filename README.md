# 🤖 OpenClaw 企业微信插件（支持直接加到微信）

> ⭐ 如果觉得有用，请点击右上角的 **Star** 支持一下！

### 🔍 项目概述

**openclaw-wechat** 是一个 [OpenClaw](https://openclaw.ai)（原 ClawdBot/Moltbot）的 <img src="docs/images/wecom-icon.png" width="16" height="16"> **企业微信渠道插件**，让你的 AI 智能体通过企业微信自建应用与用户对话。接入企业微信后，<img src="docs/images/wechat-icon.png" width="16" height="16"> **个人微信用户也可以直接对话**——只需在企业微信管理后台「我的企业 → 微信插件」中扫码关联即可。

> 🍴 本项目 fork 自 [dingxiang-me/OpenClaw-Wechat](https://github.com/dingxiang-me/OpenClaw-Wechat)（v0.1.0，作者：勾勾的数字生命），并进行了大量功能扩展以兼容新版 OpenClaw。

### 🧠 v0.4.0 — 多智能体路由支持 (Multi-Agent Routing)

**支持 OpenClaw 多智能体路由配置**：通过 `openclaw.json` 中的 `bindings` 配置，可以将不同的企业微信用户/群组路由到不同的 AI 智能体：
- 🏠 按私信用户分配不同智能体（不同的人、不同的人格）
- 👥 按群组绑定特定智能体
- 🔀 按企业微信账户分配智能体
- 🧠 会话完全隔离（每个智能体独立的历史记录和工作区）

### ✨ 与上游的主要区别

| 特性 | 上游 (OpenClaw-Wechat v0.1.0) | 本 Fork (v0.3.6) |
|------|------|------|
| 🎯 平台兼容 | ClawdBot | OpenClaw（同时保留 ClawdBot 兼容） |
| 📄 插件描述文件 | `clawdbot.plugin.json` | `openclaw.plugin.json` + `clawdbot.plugin.json` |
| ⚙️ 配置文件 | `~/.clawdbot/clawdbot.json` | `~/.openclaw/openclaw.json` |
| 📨 消息类型 | 文本、图片、语音 | 文本、图片、语音、**视频**、**文件**、**链接** |
| 📤 发送类型 | 仅文本 | 文本、**图片**、**视频**、**文件**（自动类型识别） |
| 🎙️ 语音识别 | 仅企业微信自带 | 企业微信自带 + **百炼 qwen3-asr-flash 云端 ASR**（可选本地 FunASR） |
| 🧠 对话历史 | 无 | **SDK 级对话记忆（与官方 Telegram 一致）** |
| 🏠 多智能体 | 无 | **多智能体路由（peer/accountId/channel 绑定匹配）** |
| 🖥️ Chat UI | 无 | **消息同步到 Transcript + 实时广播** |
| 🌐 代理支持 | 无 | **WECOM_PROXY 环境变量** |
| 📝 消息分段 | 按字符 | **按字节（UTF-8），二分查找分割** |

### 📋 功能特性

#### 🔌 核心功能
- [x] ✅ 支持个人微信对话（通过企业微信桥接）
- [x] ✅ 接收/发送企业微信消息
- [x] ✅ 自动调用 AI 代理处理消息
- [x] ✅ 消息签名验证（SHA1）和 AES-256-CBC 加解密
- [x] ✅ Webhook URL 验证
- [x] ✅ access_token 自动缓存和刷新

#### 🎬 媒体功能
- [x] 🖼️ 图片消息收发 + AI Vision 识别
- [x] 🎙️ 语音消息转文字（企业微信自带 + **百炼 qwen3-asr-flash 云端 ASR**）
- [x] 📹 视频消息接收、下载、发送 + **AI 视频内容理解（ffmpeg 截帧 + Qwen VL）**
- [ ] 📎 文件消息接收（⚠️ **企业微信官方接口暂不支持普通用户向应用发送文件消息**，代码内已预置本地提取逻辑备用）
- [x] 📍 位置消息接收（经纬度 + 位置名称）
- [x] 🔗 链接分享消息接收

#### 🎨 用户体验
- [x] 📝 命令系统（`/help`、`/status`、`/clear`）
- [x] 🔄 Markdown → 纯文本自动转换（企业微信不支持 Markdown 渲染）
- [x] ✂️ 长消息自动分段（2048 字节限制，按 UTF-8 字节精确分割）
- [x] 🧠 对话历史记忆（SDK 级，与官方 Telegram 一致）
- [x] 🛡️ API 限流保护（10 并发，100ms 间隔）
- [x] ⏳ 处理中提示（"收到您的消息，正在处理中..."）

#### 🚀 高级功能
- [x] 👥 多账户支持（`WECOM_<ACCOUNT>_*` 格式）
- [x] 🏠 多智能体路由（按 peer/accountId/channel 绑定匹配不同 Agent）
- [x] 🔒 Token 并发安全（Promise 锁）
- [x] 🖥️ Chat UI 集成（Transcript 写入 + Gateway 实时广播）
- [x] 🌐 HTTP 代理支持（`WECOM_PROXY`）

### 📊 支持的消息类型

| 类型 | 接收 | 发送 | 说明 |
|:----:|:----:|:----:|------|
| 📝 文本 | ✅ | ✅ | 完全支持，超长消息自动按字节分段 |
| 🖼️ 图片 | ✅ | ✅ | 支持 AI Vision 识别，下载后保存到临时文件 |
| 🎙️ 语音 | ✅ | ❌ | 企业微信自带识别 + 百炼 qwen3-asr-flash 云端 ASR（AMR → base64 → 文本） |
| 📹 视频 | ✅ | ✅ | 自动下载 → ffmpeg 截帧 → Qwen VL 理解视频内容，支持发送视频消息 |
| 📎 文件 | ✅ | ✅ | 自动下载，可读类型自动交给 AI 分析 |

### 📦 前置要求

- [OpenClaw](https://openclaw.ai) 已安装并正常运行（`openclaw doctor` 通过）
- Node.js 环境（npm 可用）
- 企业微信管理员权限
- 公网可访问的服务器或隧道（用于接收企业微信回调）
- FFmpeg（用于视频截帧）：`brew install ffmpeg`（macOS）/ `apt install ffmpeg`（Linux）
- （可选）`DASHSCOPE_API_KEY` / `BAILIAN_API_KEY` —— 用于云端语音转写（qwen3-asr-flash）、视频理解、文档解析

### 🛠️ 安装

#### 方式一：CLI 安装

```bash
openclaw plugin install --path /path/to/openclaw-wechat
```

#### 方式二：手动安装

1. 克隆本仓库：

```bash
git clone https://github.com/datalingua-dev/openclaw-wechat.git
cd openclaw-wechat
npm install
```

2. 在 OpenClaw 配置文件 `~/.openclaw/openclaw.json` 中注册插件：

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-wechat"
      ]
    },
    "entries": {
      "wecom": {
        "enabled": true
      }
    }
  }
}
```

> 💡 **注意**：插件 ID 为 `wecom`（与渠道名一致）。

### ⚙️ 配置（详细步骤）

#### 第一步：创建企业微信自建应用 🏢

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入 **应用管理** → **自建** → **创建应用**
3. 填写应用名称、Logo、可见范围等信息
4. 创建完成后，记录：
   - **AgentId**：应用的 AgentId
   - **Secret**：应用的 Secret

#### 第二步：获取企业信息 🆔

1. 在管理后台首页，点击 **我的企业**
2. 记录 **企业ID (CorpId)**

#### 第三步：配置接收消息 📨

1. 进入你创建的应用 → **接收消息** → **设置API接收**
2. 填写：
   - **URL**：`https://你的域名/wecom/callback`
   - **Token**：自定义一个 Token（随机字符串）
   - **EncodingAESKey**：点击随机生成
3. ⚠️ **先不要保存！** 需要先完成后续步骤启动 OpenClaw 服务

#### 第四步：配置环境变量 🔑

在 `~/.openclaw/openclaw.json` 中添加环境变量：

```json
{
  "env": {
    "vars": {
      "WECOM_CORP_ID": "你的企业ID",
      "WECOM_CORP_SECRET": "你的应用Secret",
      "WECOM_AGENT_ID": "你的应用AgentId",
      "WECOM_CALLBACK_TOKEN": "你设置的Token",
      "WECOM_CALLBACK_AES_KEY": "你生成的EncodingAESKey",
      "WECOM_WEBHOOK_PATH": "/wecom/callback",
      "WECOM_PROXY": "",
      "BAILIAN_API_KEY": "你的阿里云百炼 API Key（可选，用于视频理解、文件提取和语音识别）",
      "DASHSCOPE_API_KEY": "或者使用 DASHSCOPE_API_KEY（可选）",
      "WECOM_VIDEO_FRAMES": "10",
      "WECOM_VIDEO_MODEL": "qwen3.5-plus"
    }
  }
}
```

> 💡 **百炼原生多模态支持**：如果你配置了 `BAILIAN_API_KEY`（或 `DASHSCOPE_API_KEY`），插件会自动：
> - 📹 **视频理解**：使用 ffmpeg 截取关键帧 → 调用 Qwen VL（`qwen3.5-plus`）理解视频内容
> - 🎙️ **语音转写**：将语音（`.amr`）通过 `qwen3-asr-flash` 进行云端 ASR 转写
> - 📎 **文档解析**：将文档（`.pdf`, `.docx`, `.xlsx` 等）上传百炼进行原生解析
>
> 实现了完全零本地依赖（除 ffmpeg 外）的多模态体验！

##### 多账户配置

支持配置多个企业微信账户，使用 `WECOM_<ACCOUNT>_*` 格式：

```json
{
  "env": {
    "vars": {
      "WECOM_CORP_ID": "默认账户企业ID",
      "WECOM_CORP_SECRET": "默认账户Secret",
      "WECOM_AGENT_ID": "默认账户AgentId",
      "WECOM_CALLBACK_TOKEN": "默认账户Token",
      "WECOM_CALLBACK_AES_KEY": "默认账户AESKey",

      "WECOM_SALES_CORP_ID": "销售账户企业ID",
      "WECOM_SALES_CORP_SECRET": "销售账户Secret",
      "WECOM_SALES_AGENT_ID": "销售账户AgentId",
      "WECOM_SALES_CALLBACK_TOKEN": "销售账户Token",
      "WECOM_SALES_CALLBACK_AES_KEY": "销售账户AESKey"
    }
  }
}
```

#### 多应用多智能体路由配置

如果你在同一个企业微信下创建了多个自建应用，希望每个应用由不同的 AI 智能体服务（如"销售助手"、"客服助手"各有独立话术），按以下步骤配置：

**架构图：**

```
企业微信（CorpID: ww123）
├── 自建应用「销售助手」  ──回调──▶  /wecom/sales    ──路由──▶  Agent: sales-bot
├── 自建应用「客服助手」  ──回调──▶  /wecom/support  ──路由──▶  Agent: support-bot
└── 自建应用「技术支持」  ──回调──▶  /wecom/tech     ──路由──▶  Agent: tech-bot
```

**完整配置示例（`~/.openclaw/openclaw.json`）：**

```json
{
  "channels": {
    "wecom": {
      "accounts": {
        "sales": {
          "corpId": "ww你的企业ID",
          "corpSecret": "销售应用的Secret",
          "agentId": 1000002,
          "callbackToken": "销售应用的Token",
          "callbackAesKey": "销售应用的AESKey"
        },
        "support": {
          "corpId": "ww你的企业ID",
          "corpSecret": "客服应用的Secret",
          "agentId": 1000003,
          "callbackToken": "客服应用的Token",
          "callbackAesKey": "客服应用的AESKey"
        },
        "tech": {
          "corpId": "ww你的企业ID",
          "corpSecret": "技术支持应用的Secret",
          "agentId": 1000004,
          "callbackToken": "技术支持应用的Token",
          "callbackAesKey": "技术支持应用的AESKey"
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "sales-bot",
        "name": "销售助手",
        "workspace": "~/.openclaw/workspace-sales"
      },
      {
        "id": "support-bot",
        "name": "客服助手",
        "workspace": "~/.openclaw/workspace-support"
      },
      {
        "id": "tech-bot",
        "default": true,
        "name": "技术支持",
        "workspace": "~/.openclaw/workspace-tech"
      }
    ]
  },
  "bindings": [
    { "agentId": "sales-bot", "match": { "channel": "wecom", "accountId": "sales" } },
    { "agentId": "support-bot", "match": { "channel": "wecom", "accountId": "support" } },
    { "agentId": "tech-bot", "match": { "channel": "wecom", "accountId": "tech" } }
  ]
}
```

> 💡 **每个 Agent 的话术/人设**：在各自的 `workspace` 目录下创建 `AGENTS.md` 或 `SOUL.md` 文件，定义该智能体的角色、话术风格和知识范围。

**企业微信后台配置：**

每个自建应用需要分别配置回调 URL：
| 应用 | 回调 URL |
|------|----------|
| 销售助手 | `https://你的域名/wecom/sales` |
| 客服助手 | `https://你的域名/wecom/support` |
| 技术支持 | `https://你的域名/wecom/tech` |

**按用户/群组精细路由（可选）：**

在同一个应用内，还可以按用户或群组路由到不同智能体：

```json
{
  "bindings": [
    { "agentId": "vip-sales", "match": { "channel": "wecom", "accountId": "sales", "peer": { "kind": "dm", "id": "zhangsan" } } },
    { "agentId": "sales-bot", "match": { "channel": "wecom", "accountId": "sales" } }
  ]
}
```

#### 第五步：配置公网访问 🔗

企业微信需要能够访问你的回调 URL。推荐使用 Cloudflare Tunnel：

```bash
# 安装 cloudflared
brew install cloudflared   # macOS
# 或 apt install cloudflared  # Linux

# 创建隧道
cloudflared tunnel create openclaw

# 配置隧道路由
cloudflared tunnel route dns openclaw 你的域名

# 启动隧道（将流量转发到本地 Gateway 端口）
cloudflared tunnel --url http://localhost:18789 run openclaw
```

其他方案：SSH 隧道、Tailscale、Nginx 反向代理 + 端口转发等。

#### 第六步：配置企业可信 IP 🛡️

企业微信要求调用 API（发送消息、获取 token 等）的服务器 IP 在白名单中。

1. 查询你服务器的**出口公网 IP**：

```bash
curl -s https://ifconfig.me
```

> ⚠️ 注意：这里需要的是你服务器**发出请求时的 IP**（出口 IP），不是 Cloudflare Tunnel 的 IP。Cloudflare Tunnel 只处理入站流量，服务器调用企业微信 API 时仍然走自己的公网出口。

2. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
3. 进入 **应用管理** → 选择你创建的自建应用
4. 滚动到页面底部，找到 **企业可信 IP**，点击 **配置**：

   ![企业可信 IP 位置](docs/images/ip-whitelist.png)

5. 添加上一步查到的 IP 地址

> 💡 如果调用 API 报错 `60020`（not allow to access from your ip），检查日志中提示的 IP 并添加到白名单即可。

**动态 IP 场景（家用宽带 / 无固定公网 IP 的服务器）**：

如果你的服务器没有固定公网 IP，推荐通过一台有固定 IP 的 VPS 做正向代理：

1. 在 VPS 上安装代理（如 tinyproxy）：
   ```bash
   sudo apt-get install -y tinyproxy
   ```
2. 编辑 `/etc/tinyproxy/tinyproxy.conf`，设置监听地址和访问控制（建议只允许内网访问）
3. 在插件配置中设置 `WECOM_PROXY` 环境变量指向代理：
   ```jsonc
   // ~/.openclaw/openclaw.json
   {
     "env": {
       "vars": {
         "WECOM_PROXY": "http://你的VPS内网IP:8888"
       }
     }
   }
   ```
4. 将 VPS 的**公网 IP** 添加到企业可信 IP 白名单

> 插件内置了 `wecomFetch()` 函数，会自动通过 `WECOM_PROXY` 代理所有发往 `qyapi.weixin.qq.com` 的请求。如果使用 ZeroTier / Tailscale 等虚拟内网连接 VPS，代理地址填内网 IP 即可。

#### 第七步：启动并验证 🚀

1. 重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

2. 检查插件是否加载：

```bash
openclaw plugin list
```

3. 验证 Webhook 可达：

```bash
curl https://你的域名/wecom/callback
# 应返回 "wecom webhook ok"
```

4. 回到企业微信管理后台，点击**保存**回调配置
5. 如果验证通过，配置完成！🎉

#### 第八步：关联个人微信 📱（可选）

如果希望**个人微信**也能直接与 AI 对话，需在企业微信管理后台开启微信插件：

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入 **我的企业** → **微信插件**
3. 用个人微信扫描页面上的二维码，关联到企业
4. 关联后，个人微信中会出现企业的应用入口，直接发消息即可

<p align="center">
  <img src="docs/images/wecom2wechat.jpg" alt="企业微信管理后台 → 我的企业 → 微信插件" width="600">
  <br>
  <em>在企业微信管理后台「我的企业 → 微信插件」中，用个人微信扫码即可关联</em>
</p>

### 🎙️ 语音转文字（云端 ASR）

语音消息通过百炼 `qwen3-asr-flash` 模型进行云端 ASR 转写，零本地依赖（无需 Python/PyTorch）。

**工作流程：**
1. 收到语音消息 → 下载 AMR 音频文件
2. 将 AMR 文件 Base64 编码为 Data URL
3. 调用百炼 `qwen3-asr-flash` OpenAI 兼容 API（`input_audio` 格式）
4. 将识别结果作为文本消息发送给 AI 代理

**优先级：** 企业微信自带识别（Recognition 字段）> 百炼云端 ASR > 降级提示

> 💡 需要配置 `DASHSCOPE_API_KEY`（或 `BAILIAN_API_KEY`）。可通过 `WECOM_STT_MODEL` 环境变量切换 ASR 模型。

<details>
<summary>📦 本地语音识别备选方案（stt.py）</summary>

项目中保留了 `stt.py`，使用 [FunASR SenseVoice-Small](https://modelscope.cn/models/iic/SenseVoiceSmall) 进行本地语音识别（需要 Python 3 + PyTorch + FFmpeg）。

适用场景：无法配置百炼 API Key，或需要完全离线运行。

```bash
# 依赖安装
pip install funasr modelscope torch torchaudio torchcodec

# 独立使用
python3 stt.py /path/to/audio.wav
```

> 详细部署指南见 [`docs/stt-deploy-guide.md`](docs/stt-deploy-guide.md)

</details>

### 📝 使用

配置完成后，在企业微信或个人微信中找到你的应用，直接发送消息即可：

1. 📱 在企业微信中找到你创建的应用
2. 💬 发送文字、图片、语音、视频、链接消息
3. 🤖 AI 会自动回复

**<img src="docs/images/wechat-icon.png" width="16" height="16"> 个人微信接入：** 在企业微信管理后台「我的企业  → 微信插件」中，用个人微信扫码关联即可。

#### 命令系统

| 命令 | 说明 |
|------|------|
| `/help` | 📋 显示帮助信息 |
| `/status` | 📊 查看系统状态（含账户信息） |
| `/clear` | 🗑️ 清除会话历史，开始新对话 |

### 🔧 环境变量参考

| 变量名 | 必填 | 默认值 | 说明 |
|--------|:----:|--------|------|
| `WECOM_CORP_ID` | ✅ | — | 企业微信企业 ID |
| `WECOM_CORP_SECRET` | ✅ | — | 自建应用的 Secret |
| `WECOM_AGENT_ID` | ✅ | — | 自建应用的 AgentId |
| `WECOM_CALLBACK_TOKEN` | ✅ | — | 回调配置的 Token |
| `WECOM_CALLBACK_AES_KEY` | ✅ | — | 回调配置的 EncodingAESKey（43 字符 Base64） |
| `WECOM_WEBHOOK_PATH` | ❌ | `/wecom/callback` | Webhook 路径 |
| `WECOM_PROXY` | ❌ | — | 出站 WeCom API 的 HTTP 代理地址（如 `http://10.x.x.x:8888`） |
| `DASHSCOPE_API_KEY` | ❌ | — | 阿里云百炼 API Key（用于视频理解、语音转写、文档解析） |
| `WECOM_VIDEO_FRAMES` | ❌ | `10` | 视频截帧数量（ffmpeg 均匀截取） |
| `WECOM_VIDEO_MODEL` | ❌ | `qwen3.5-plus` | 视频理解使用的百炼模型名称 |
| `WECOM_STT_API_KEY` | ❌ | 同 `DASHSCOPE_API_KEY` | 语音转写独立 API Key（优先于通用 Key） |
| `WECOM_STT_BASE_URL` | ❌ | 同 `BAILIAN_BASE_URL` | 语音转写独立 Base URL（优先于通用 URL） |
| `WECOM_STT_MODEL` | ❌ | `qwen3-asr-flash` | 语音转写使用的百炼 ASR 模型名称 |

### 🔍 故障排查

#### ❌ 回调验证失败

1. 检查 URL 是否可公网访问：
```bash
curl https://你的域名/wecom/callback
# 应返回 "wecom webhook ok"
```

2. 检查环境变量是否正确配置（Token 和 AESKey 必须与企业微信后台一致）

3. 查看 OpenClaw 日志：
```bash
openclaw logs -f | grep wecom
```

#### ❌ 消息没有回复

1. 检查日志中是否有 `wecom inbound` 记录
2. 确认 AI 模型配置正确（检查 `agents.defaults.model`）
3. 检查是否有错误日志

#### ❌ access_token 获取失败

1. 确认 `WECOM_CORP_ID` 和 `WECOM_CORP_SECRET` 正确
2. 检查应用的可见范围是否包含测试用户
3. 确认服务器能访问 `qyapi.weixin.qq.com`（如有代理需设置 `WECOM_PROXY`）

#### ❌ 报错 `60020` (not allow to access from your ip)

企业微信 API 拒绝了你服务器的出口 IP。解决方法：
1. 查看错误日志中提示的 IP 地址
2. 将该 IP 添加到企业微信管理后台 → 应用管理 → 企业可信 IP
3. 如果服务器是动态 IP，参考第六步配置代理方案

#### ❌ 报错 "Outbound not configured"

OpenClaw 要求插件同时提供 `sendText` **和** `sendMedia` 两个出站方法。如果缺少任一方法，`createPluginHandler()` 会返回 null，导致此错误。确认插件版本包含完整的出站配置。

#### ❌ 语音识别失败

1. 确认已配置 `DASHSCOPE_API_KEY`（或 `BAILIAN_API_KEY`）
2. 检查日志中的 STT 错误信息（例如 `STT (qwen3-asr-flash) failed: 401`）
3. 确认百炼账户有 `qwen3-asr-flash` 模型的免费额度或已开通计费
4. 如果企业微信已开启语音识别（Recognition 字段），会优先使用企业微信的结果

#### ❌ 语音消息发送了但 AI 没收到内容

`RawBody` 为空字符串 `""` 时会短路 `??` 运算符的回退链，导致 AI 收到空消息。确认插件版本中 `RawBody` 设置为 `content || messageText || ""`（而非 `content || ""`）。

#### ❌ AI 无法"看到"用户发送的图片

图片会保存到本地磁盘并通过工具指令告知 AI 读取，而非以 base64 多模态方式传入。AI 需要主动调用 Read 工具才能看到图片内容，这取决于模型是否正确使用了工具。

#### ❌ sendMedia 发送文件失败 / 文件被静默拦截

OpenClaw 核心层通过 `mediaLocalRoots` 限制可发送的本地文件路径，仅允许以下目录：
- `tmpdir`（系统临时目录）
- `~/.openclaw/media`
- `~/.openclaw/agents`
- `~/.openclaw/workspace`
- `~/.openclaw/sandboxes`

目录外的文件会被 `assertLocalMediaAllowed()` 静默拦截。解决方法：先将文件复制到 `~/.openclaw/workspace/` 再发送。

#### ❌ Node.js `fetch()` 不走代理

Node.js 原生 `fetch()` **不支持** `HTTPS_PROXY` 环境变量。插件使用 `undici.ProxyAgent` 配合 `dispatcher` 参数实现代理，仅需设置 `WECOM_PROXY` 环境变量即可，无需额外配置系统代理。

### 🏗️ 架构

```
┌──────────────┐         ┌──────────────────┐         ┌───────────────┐
│  企业微信     │ ──XML──▶│ OpenClaw Gateway │ ──────▶ │  AI Agent     │
│  / 个人微信   │         │  (port 18789)    │         │  (LLM)        │
│              │ ◀──API──│                  │ ◀────── │               │
└──────────────┘         └──────┬───────────┘         └───────────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
              ┌──────────┐ ┌────────┐ ┌──────────┐
              │ 消息加解密 │ │ 百炼ASR │ │ Chat UI  │
              │ AES-256  │ │ 视频VL  │ │ Broadcast│
              └──────────┘ └────────┘ └──────────┘
```

**消息流程：**

1. 📩 用户在企业微信/个人微信发送消息
2. 🔒 企业微信服务器将加密的 XML 回调发送到你的 Webhook URL
3. 🔓 插件验证签名，解密消息（AES-256-CBC）
4. ⚡ 立即返回 HTTP 200（企业微信要求 5 秒内响应）
5. 🔄 异步处理：根据消息类型分发处理
   - 📝 文本 → 直接交给 AI
   - 🖼️ 图片 → 下载保存 → AI Vision 分析
   - 🎙️ 语音 → 下载 AMR → base64 编码 → 百炼 qwen3-asr-flash 云端 ASR → 文本交给 AI
   - 📹 视频 → 下载 MP4 → ffmpeg 截 10 帧 → base64 编码 → 百炼 Qwen VL 理解 → 描述文本交给 AI
   - 📎 文件 → 下载保存 → 百炼文档解析（或本地读取）→ 内容交给 AI
   - 🔗 链接 → 提取元信息 → 交给 AI
6. 🤖 AI 代理生成回复
7. 📤 回复经 Markdown 转换后，自动分段发送回企业微信
8. 🖥️ 同时写入 Transcript + 广播到 Chat UI

### 📁 项目结构

```
openclaw-wechat/
├── index.js                 # 入口文件（重导出）
├── src/
│   └── index.js             # 插件主逻辑（1400+ 行）
├── stt.py                   # 🎙️ 本地语音识别备选（FunASR SenseVoice，需 Python）
├── openclaw.plugin.json     # OpenClaw 插件描述文件（新格式）
├── clawdbot.plugin.json     # ClawdBot 插件描述文件（兼容旧版）
├── package.json             # npm 包配置 (v0.4.0)
├── .env.example             # 环境变量示例
├── skills/
│   └── wecom-notify/        # 📨 Claude Code WeCom 通知技能
│       ├── SKILL.md
│       └── scripts/
│           └── send_wecom.py
├── docs/
│   └── channels/
│       └── wecom.md         # 渠道文档
├── CHANGELOG.md             # 版本变更日志
└── LICENSE                  # MIT 许可证
```

### 📨 Claude Code WeCom 通知技能

本仓库还包含一个独立的 **Claude Code 技能**（`wecom-notify`），可以在 Claude Code 中直接发送企业微信消息。这是一个**独立工具**，不依赖 OpenClaw 插件，直接调用企业微信 API。

#### 安装技能

将 `skills/wecom-notify/` 目录复制到 `~/.claude/skills/` 即可：

```bash
cp -r skills/wecom-notify ~/.claude/skills/
```

#### 使用方式

在 Claude Code 中可以直接使用 `/wecom-notify` 命令，或让 AI 自动调用：

```bash
# 发送文本消息
python3 skills/wecom-notify/scripts/send_wecom.py "你好，这是一条测试消息"

# 指定接收人
python3 skills/wecom-notify/scripts/send_wecom.py "消息内容" --to UserName

# 发送图片
python3 skills/wecom-notify/scripts/send_wecom.py --image /path/to/photo.png

# 发送文件
python3 skills/wecom-notify/scripts/send_wecom.py --file /path/to/report.pdf
```

#### 特点

- 🔧 **零依赖**：仅使用 Python 标准库（`urllib.request`、`json`），无需 `pip install`
- 📄 自动从 `~/.openclaw/openclaw.json` 读取 WeCom 配置（复用 OpenClaw 的环境变量）
- 📝 支持文本（2048 字节限制）、图片（jpg/png/gif，≤2MB）、文件（任意格式，≤20MB）
- 🌐 支持 `WECOM_PROXY` 代理

### 📜 版本历史

查看 [CHANGELOG.md](./CHANGELOG.md) 了解完整版本历史。

---

## 🔗 相关链接

- 🌐 [OpenClaw 官方网站](https://openclaw.ai)
- 📖 [企业微信开发文档](https://developer.work.weixin.qq.com/document/)
- 🔐 [企业微信消息加解密](https://developer.work.weixin.qq.com/document/path/90968)
- 🍴 [上游项目：dingxiang-me/OpenClaw-Wechat](https://github.com/dingxiang-me/OpenClaw-Wechat)
- 🎙️ [FunASR SenseVoice](https://modelscope.cn/models/iic/SenseVoiceSmall)

## 📄 许可证

[MIT License](./LICENSE)

## 🙏 致谢

- 🍴 原始项目：[dingxiang-me/OpenClaw-Wechat](https://github.com/dingxiang-me/OpenClaw-Wechat)，作者 **勾勾的数字生命** ([@dingxiang-me](https://github.com/dingxiang-me))
- 🤖 [OpenClaw](https://openclaw.ai)，由 Peter Steinberger 和 OpenClaw 社区开发
- 🎙️ [FunASR SenseVoice](https://github.com/modelscope/FunASR)，由阿里巴巴达摩院开发

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！
