# [开源] 让企业微信秒变多模态大模型智能体入口！基于 OpenClaw 的 WeCom 插件 (支持视频/文件/Cron定时提醒)

各位佬好，今天给大家带来一个刚刚大重构完的开源插件：**[`openclaw-wechat`](https://github.com/datalingua-dev/openclaw-wechat)**！

它不仅能让你通过**企业微信**（甚至桥接给**个人微信**）非常顺滑地与 LLM Agent 对话，更在**多模态能力**和**底层沙箱隔离**上做到了企业级落地。

## 💡 为什么要做这个？
现在各种大模型框架都在做 Web UI，但我们最习惯的交流方式其实还是微信。
之前的很多企微机器人项目痛点在于：
1. 只能处理纯文本，发个图片/语音就崩了。
2. 没有长期记忆和会话隔离，群聊的时候大模型的幻觉把不同人的上下文全串了。
3. 只能“被动响应”，没法实现“定时推送”这样的私人助理核心功能。

所以我们基于 OpenClaw 框架，把这个插件撸出来了。

## 🔥 核心硬核特性

### 1. 全链路原生多模态支持 (Zero-local-dependency)
- **📹 视频流解析**：用户用手机随手拍一个 MP4 发过去，网关会自动下载 → `ffmpeg` 均匀截取 10 帧 → Base64 塞给 `qwen-vl` 等视觉大模型理解画面剧情。
- **🎙️ 语音闪电转写**：支持提取企微 `.amr` 音频，直接对接百炼 `qwen3-asr-flash` 实现云端闪电转写，再把文字喂给 LLM（不需要你在服务器里跑沉重的 PyTorch 模型！）。
- **📎 文件分析**：PDF、Word、Excel 无缝下载并接入大模型的文档解析能力。

### 2. 多智能体动态路由 (Multi-Agent Routing)
并不是所有对话都要进入同一个 System Prompt！你可以通过配置做到：
- 销售部应用的流量 ──路由──▶ Agent: `sales-bot`（满脑子都是转化率）
- 技术部应用的流量 ──路由──▶ Agent: `tech-bot`（用来写代码和查日志）
底层完全依据 `accountId`、甚至精确到 `PeerId` 动态分发。

### 3. [独家] 原生 Cron 引擎与物理级记忆沙箱隔离
这是我们本次重构最骄傲的基础设施：我们用底层网关打通了**“多用户物理级文件隔离”**与**“大模型调度 Cron”**。
以里面的 `fitness-coach` 模板为例：
- **沙箱隔离**：当 WeCom_ID 为 `user123` 的人对话时，所有产生的资料（记忆 `memory.md` 等）都会被网关底层强行锁定在 `~/.openclaw/workspace/users/user123/` 下，大模型的 `read/write` 权限被限制死，**绝对防止跨用户数据泄露**。
- **自主 Cron 定时唤醒**：你可以跟机器人说：“以后这周一、周五早上八点提醒我开会”。大模型会自己理解这句话并调用挂载的 `cron` 工具生成日程表写入用户的沙箱。时间一到，底层时间轴会**逆向唤醒大模型**发送企微消息给该用户！这就真正实现了虚拟助理的主动性。

### 4. 其他极致的开发者体验
- **大消息自动劈卷**：企微接口有 2048 字节限制，很多轮子会报错。我们实现了纯 UTF-8 的二进制二分查找切割法，发万字长文也能顺滑切片。
- **Web UI 镜像广播**：你在企微里说的话，会实时 Websocket 广播到后端的 Chat UI 面板，方便联调记录。
- **HTTP Proxy 突破**：对于家用宽带无固定出口 IP 的佬，支持纯粹的 `WECOM_PROXY` 环境变量将特定的出口包代理到跳板机。

## 🚀 极简部署

前置：你有用过 [OpenClaw](https://openclaw.ai)。

```bash
git clone https://github.com/datalingua-dev/openclaw-wechat.git
cd openclaw-wechat
npm install
```
然后在你的 `openclaw.json` 里挂载该路径，并在环境变量里配上微信后台拿到的 `CorpId` 和 `Secret` 就能直接起飞。（超度详细的图文保姆级教程请见 repo README）。

🔗 **项目地址**: [https://github.com/datalingua-dev/openclaw-wechat](https://github.com/datalingua-dev/openclaw-wechat) （求个 Star 🙏！）

有没有在做微信智能化接入的佬？欢迎在评论区一起讨论或者提 PR！有什么部署问题我全天后解答！
