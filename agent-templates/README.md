# 智能客服 Agent 模板

这是为小微企业定制的 OpenClaw 智能客服 Agent 模板文件集，用于在企业微信中提供像真人一样的客服服务。

## 文件说明

| 文件 | 用途 | 是否必需 |
|---|---|---|
| `AGENTS.md` | 行为规范：定义客服能做什么、不能做什么 | ✅ 必需 |
| `IDENTITY.md` | 外在身份：客服的名字、风格、称呼方式 | ✅ 必需 |
| `SOUL.md` | 内在灵魂：性格、语气、沟通策略 | ✅ 推荐 |
| `KNOWLEDGE.md` | 企业知识库：产品、价格、FAQ（自动加载） | ✅ 必需 |
| `USER.md` | 用户记忆：AI 自动维护的客户档案 | ✅ 推荐 |
| `TOOLS.md` | 工具说明：当前服务不使用系统工具 | ⚠️ 可选 |
| `HEARTBEAT.md` | 心跳巡检：定期检查未处理任务 | ⚠️ 可选 |

## 使用方法

### 新增一个企业客服 Agent

1. **复制模板目录**到服务器：
```bash
cp -r agent-templates/cs-template/ ~/.openclaw/agents/cs-<企业id>/agent/
```

2. **修改关键文件**：
   - `IDENTITY.md` — 替换客服名字和企业名称
   - `KNOWLEDGE.md` — 填入该企业的产品/服务/FAQ 信息

3. **在 `openclaw.json` 中添加配置**：
   - `agents.list` 中添加新 Agent
   - `channels.wecom.accounts` 中添加企微账号
   - `bindings` 中添加路由映射

4. **重启 Gateway**：
```bash
openclaw gateway
```

## 知识库加载机制

`KNOWLEDGE.md` 通过 OpenClaw 的 `bootstrap-extra-files` 内部钩子自动加载。只要文件放在 `agentDir` 下，启动时就会被注入到系统提示词中，**无需任何额外配置**。

配置中只需确保以下钩子已启用（您的配置已启用）：
```json
"hooks": {
  "internal": {
    "enabled": true,
    "entries": {
      "bootstrap-extra-files": {"enabled": true}
    }
  }
}
```
