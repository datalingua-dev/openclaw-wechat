# 湖雀科技智能客服 Agent 部署指南

## 文件清单

```
agent-templates/cs-oldbird-tech/
├── AGENTS.md       # 行为规范 + 转人工规则
├── IDENTITY.md     # "小雀"客服身份设定
├── SOUL.md         # 性格灵魂 + 拟人化语气策略
├── KNOWLEDGE.md    # 产品知识库（套餐/定价/FAQ）
├── USER.md         # 客户记忆档案（AI 自动更新）
├── TOOLS.md        # 工具权限说明
└── HEARTBEAT.md    # 定期巡检任务
```

---

## 部署步骤

### 第一步：将文件复制到服务器

```bash
# 在服务器上创建 Agent 目录
mkdir -p ~/.openclaw/agents/cs-oldbird-tech/agent

# 将本项目中的模板文件复制过去（根据您的实际传输方式选择）
# 方式一：如果在服务器上直接操作
cp agent-templates/cs-oldbird-tech/*.md ~/.openclaw/agents/cs-oldbird-tech/agent/

# 方式二：从开发机 scp 到服务器
# scp -r agent-templates/cs-oldbird-tech/*.md oldbird@服务器IP:~/.openclaw/agents/cs-oldbird-tech/agent/
```

### 第二步：创建工作区目录

```bash
mkdir -p ~/.openclaw/workspace-cs-oldbird-tech
```

### 第三步：修改 openclaw.json

在现有的 `openclaw.json` 中添加以下 3 处配置：

#### 3.1 在 `agents.list` 数组中添加新 Agent

在 `agents.list` 中的最后一个 Agent 后面加上：

```json
{
  "id": "cs-oldbird-tech",
  "name": "湖雀科技智能客服",
  "workspace": "~/.openclaw/workspace-cs-oldbird-tech",
  "agentDir": "~/.openclaw/agents/cs-oldbird-tech/agent",
  "identity": {
    "name": "小雀",
    "theme": "温暖专业的技术服务顾问",
    "emoji": "🐦"
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
"oldbird-tech-cs": {
  "corpId": "您的corpId",
  "corpSecret": "该应用的corpSecret",
  "agentId": 应用的agentId,
  "callbackToken": "回调Token",
  "callbackAesKey": "回调AesKey",
  "webhookPath": "/wecom/oldbird-tech-cs"
}
```

如果暂时想用现有的 `default` 账号测试，可以跳过这一步。

#### 3.3 在 `bindings` 数组中添加路由

```json
{
  "agentId": "cs-oldbird-tech",
  "match": {
    "channel": "wecom",
    "accountId": "oldbird-tech-cs"
  }
}
```

如果用现有 `default` 账号测试，将 `accountId` 改为 `"default"`，并**临时注释掉** main 的绑定。

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
  "ackReaction": "😊",
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
| 发送"你好" | 回复类似"您好！我是老鸟科技的小鸟客服…😊" |
| 问"有什么服务" | 介绍智能客服/新闻分析/技术咨询三大产品 |
| 问"基础版多少钱" | 回答 ¥299/月 并介绍包含内容 |
| 问"转人工" | 触发 `[TRANSFER_TO_HUMAN]` 转接 |
| 连发多条消息 | 等 3 秒防抖后统一回复 |
| 问"帮我执行个命令" | 拒绝并说明不在服务范围 |
| 隔天再问"上次说的那个套餐" | 能记住之前的对话上下文 |

---

## 注意事项

1. **转人工功能**目前需要在 `openclaw-wechat` 插件中开发 `[TRANSFER_TO_HUMAN]` 拦截逻辑（后续任务）
2. **知识库更新**：直接编辑服务器上的 `~/.openclaw/agents/cs-oldbird-tech/agent/KNOWLEDGE.md` 文件，重启 Gateway 即可生效
3. **多企业扩展**：为新的小微企业客户创建 Agent 时，复制 `cs-oldbird-tech/` 目录，修改 `IDENTITY.md` 和 `KNOWLEDGE.md` 即可
