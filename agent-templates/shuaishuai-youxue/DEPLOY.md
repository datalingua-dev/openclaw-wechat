# 帅帅游学智能客服 Agent 部署指南

## 文件清单

```
agent-templates/shuaishuai-youxue/
├── AGENTS.md       # 核心！行为规范 + 平台产品知识库 + 转人工规则
├── IDENTITY.md     # "小帅"客服身份设定与系统感知要求
├── SOUL.md         # 帅帅的故事 + 性格灵魂 + 拟人化温暖陪伴语气策略
├── USER.md         # 客户记忆档案（AI 自动更新）
├── TOOLS.md        # 工具权限说明
└── HEARTBEAT.md    # 定期巡检任务
```

---

## 部署步骤

### 第一步：将文件复制到服务器

```bash
# 在服务器上创建 Agent 目录
mkdir -p ~/.openclaw/agents/shuaishuai-youxue/agent

# 将本项目中的模板文件复制过去（根据您的实际传输方式选择）
# 方式一：如果在服务器上直接操作
cp agent-templates/shuaishuai-youxue/*.md ~/.openclaw/agents/shuaishuai-youxue/agent/

# 方式二：从开发机 scp 到服务器
# scp -r agent-templates/shuaishuai-youxue/*.md shuaishuai@服务器IP:~/.openclaw/agents/shuaishuai-youxue/agent/
```

### 第二步：创建工作区目录

```bash
mkdir -p ~/.openclaw/workspace-shuaishuai-youxue
```

### 第三步：修改 openclaw.json

在现有的 `openclaw.json` 中添加以下 3 处配置：

#### 3.1 在 `agents.list` 数组中添加新 Agent

在 `agents.list` 中的最后一个 Agent 后面加上：

```json
{
  "id": "shuaishuai-youxue",
  "name": "帅帅游学全球好物线上平台",
  "workspace": "~/.openclaw/workspace-shuaishuai-youxue",
  "agentDir": "~/.openclaw/agents/shuaishuai-youxue/agent",
  "identity": {
    "name": "小帅",
    "theme": "温暖陪伴的全球好物与疗愈游学顾问",
    "emoji": "🌿"
  },
  "sandbox": {
    "mode": "all",
    "scope": "agent",
    "workspaceAccess": "none"
  },
  "tools": {
    "deny": [
      "read", "write", "edit", "apply_patch",
      "exec", "process", "browser", "canvas",
      "nodes", "cron", "image"
    ]
  }
}
```

#### 3.2 在 `channels.wecom.accounts` 中添加企微账号（可选）

如果您希望为这个客服 Agent 配置独立的企微应用，添加：

```json
"shuaishuai-youxue-cs": {
  "corpId": "您的corpId",
  "corpSecret": "该应用的corpSecret",
  "agentId": 应用的agentId,
  "callbackToken": "回调Token",
  "callbackAesKey": "回调AesKey",
  "webhookPath": "/wecom/shuaishuai-youxue"
}
```

#### 3.3 在 `bindings` 数组中添加路由

```json
{
  "agentId": "shuaishuai-youxue",
  "match": {
    "channel": "wecom",
    "accountId": "shuaishuai-youxue-cs"
  }
}
```

#### 3.4 更新 session 和 messages 配置（如果还没改）

```json
"session": {
  "dmScope": "per-account-channel-peer",
  "reset": {
    "mode": "idle",
    "idleMinutes": 525600
  },
  "resetByType": {
    "dm": { "mode": "idle", "idleMinutes": 525600 },
    "group": { "mode": "idle", "idleMinutes": 525600 }
  },
  "resetTriggers": ["/new", "/reset"]
},
"messages": {
  "ackReaction": "❤️",
  "ackReactionScope": "all",
  "removeAckAfterReply": true,
  "responsePrefix": "",
  "inbound": {
    "debounceMs": 3000
  },
  "queue": {
    "mode": "collect",
    "debounceMs": 2000,
    "cap": 10
  }
}
```

### 第四步：重启 Gateway

```bash
openclaw gateway
```

---

## 验证测试

部署完成后，建议依次测试以下场景：

| 测试场景 | 预期结果 |
|---|---|
| 发送"我想了解一下颂钵" | 小帅温柔介绍尼泊尔手工颂钵的产地与服务。 |
| 发送破损的产品照片 | AI启动陪伴话术并安抚情绪，触发转人工对接。 |
| 问"转人工" | 触发 `[TRANSFER_TO_HUMAN]` 转接 |
| 连发多条消息 | 等 3 秒防抖后统一回复 |
| 问"帮我执行个命令" | 拒绝并说明不在服务范围 |
| 隔天再回忆"上次我看的那款颂钵" | 能记住之前的对话上下文 |
