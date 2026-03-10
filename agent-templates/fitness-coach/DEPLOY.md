# 健身私教 Agent 部署指南

## 文件清单

```
agent-templates/fitness-coach/
├── AGENTS.md       # 行为规范 + 服务项目 + FAQ + 转教练规则
├── IDENTITY.md     # "小壮"教练身份设定
├── SOUL.md         # 性格灵魂 + 激励风格 + 语气策略
├── USER.md         # 会员信息档案（AI 自动更新）
├── TOOLS.md        # 工具权限说明
├── HEARTBEAT.md    # 定期巡检任务
└── DEPLOY.md       # 本部署指南
```

---

## 部署步骤

### 第一步：将文件复制到服务器

```bash
# 在服务器上创建 Agent 目录
mkdir -p ~/.openclaw/agents/fitness-coach/agent

# 将模板文件复制过去
cp agent-templates/fitness-coach/*.md ~/.openclaw/agents/fitness-coach/agent/

# 或从开发机 scp 到服务器
# scp -r agent-templates/fitness-coach/*.md user@服务器IP:~/.openclaw/agents/fitness-coach/agent/
```

### 第二步：创建工作区目录

```bash
mkdir -p ~/.openclaw/workspace-fitness-coach
```

### 第三步：修改 openclaw.json

在现有的 `openclaw.json` 中添加以下配置：

#### 3.1 在 `agents.list` 数组中添加新 Agent

```json
{
  "id": "fitness-coach",
  "name": "AI健身私教",
  "workspace": "~/.openclaw/workspace-fitness-coach",
  "agentDir": "~/.openclaw/agents/fitness-coach/agent",
  "identity": {
    "name": "小壮",
    "theme": "热情专业的健身教练",
    "emoji": "💪"
  },
  "sandbox": {
    "mode": "all",
    "scope": "agent",
    "workspaceAccess": "none"
  },
  "tools": {
    "deny": [
      "read", "write", "edit", "apply_patch",
      "exec", "process", "canvas",
      "nodes", "cron", "image"
    ]
  }
}
```

#### 3.2 在 `channels.wecom.accounts` 中添加企微账号（可选）

```json
"fitness-coach-cs": {
  "corpId": "您的corpId",
  "corpSecret": "该应用的corpSecret",
  "agentId": 应用的agentId,
  "callbackToken": "回调Token",
  "callbackAesKey": "回调AesKey",
  "webhookPath": "/wecom/fitness-coach"
}
```

如果暂时想用现有的 `default` 账号测试，可以跳过这一步。

#### 3.3 在 `bindings` 数组中添加路由

```json
{
  "agentId": "fitness-coach",
  "match": {
    "channel": "wecom",
    "accountId": "fitness-coach-cs"
  }
}
```

如果用现有 `default` 账号测试，将 `accountId` 改为 `"default"`，并**临时注释掉**其他绑定。

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
  "ackReaction": "💪",
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

### 第四步：自定义内容

部署前，请务必修改 `AGENTS.md` 中的以下占位内容：

- `[请替换为实际工作室名称]`
- `[请替换为实际定位]`
- `[请替换为实际口号]`
- `[请替换为实际时间]`
- `[请替换为实际地址]`
- 套餐价格（根据实际情况调整）

### 第五步：重启 Gateway

```bash
docker compose down && docker compose up -d
docker compose restart
docker compose logs -f openclaw-gateway
```

---

## 验证测试

部署完成后，建议依次测试以下场景：

| 测试场景 | 预期结果 |
|---|---|
| 发送"你好" | 回复类似"嘿！我是你的 AI 健身教练小壮…💪" |
| 问"有什么课程" | 介绍私教、团课等课程类型 |
| 问"我想减肥应该怎么练" | 给出减脂训练和饮食的综合建议 |
| 问"帮我制定个训练计划" | 先询问基础信息再制定计划 |
| 问"练完很酸痛怎么办" | 解释 DOMS 并给出恢复建议 |
| 问"转教练" | 触发 `[TRANSFER_TO_HUMAN]` 转接 |
| 说"我膝盖有伤" | 建议先看医生再调整训练 |
| 问"帮我执行个命令" | 拒绝并说明不在服务范围 |
| 隔天再问"上次说的那个计划" | 能记住之前的对话上下文 |

---

## 注意事项

1. **转教练功能**目前需要在 `openclaw-wechat` 插件中开发 `[TRANSFER_TO_HUMAN]` 拦截逻辑
2. **内容更新**：直接编辑服务器上的 Agent 文件，重启 Gateway 即可生效
3. **多门店扩展**：为新的健身房/工作室创建 Agent 时，复制 `fitness-coach/` 目录，修改 `IDENTITY.md` 和 `AGENTS.md` 即可
