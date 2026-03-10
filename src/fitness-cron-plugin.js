import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// Cron-like Notification Plugin for Fitness Coach
// ============================================================================

export default function registerFitnessCronPlugin(api) {
  const logger = api.logger;
  logger?.info?.("fitness-cron-plugin initializing...");

  const activeReminders = new Map();
  
  // 每个 OpenClaw 实例在加载时拥有独立的 config.id（即 Agent ID）
  const currentAgentId = api.runtime?.config?.id || "fitness-coach";

  // 动态寻找 OpenClaw 真正的根目录结构 (修复 Docker 内部 root/node 挂载路径差异)
  function getOpenclawDir() {
      if (process.env.OPENCLAW_HOME) return process.env.OPENCLAW_HOME;
      
      const candidates = [
          path.join(process.env.HOME || "", ".openclaw"),
          path.join(os.homedir(), ".openclaw"),
          "/home/node/.openclaw",
          "/root/.openclaw"
      ];
      
      for (const dir of candidates) {
          if (dir && fs.existsSync(dir)) {
             try {
                 const files = fs.readdirSync(dir);
                 // 只要这个目录下有任何 workspace- 开头的文件夹，说明就是真正的挂载数据卷
                 if (files.some(f => f.startsWith("workspace-"))) {
                     return dir;
                 }
             } catch (e) {
                 // 忽略没权限读的目录
             }
          }
      }
      return path.join(os.homedir(), ".openclaw"); // 兜底返回
  }

  // 动态获取某个 agent 的独立 workspace users 目录
  function getAgentUsersDir(agentId) {
    // OpenClaw 默认按 workspace-${agentId} 存放
    const openclawDir = getOpenclawDir();
    const workspaceDir = path.join(openclawDir, `workspace-${agentId}`);
    return path.join(workspaceDir, "users");
  }

  // 从每个有 reminders 记录的用户目录加载
  function loadRemindersForAgent(agentId) {
    const usersDir = getAgentUsersDir(agentId);
    try {
      if (!fs.existsSync(usersDir)) return;
      
      const userFolders = fs.readdirSync(usersDir);
      for (const wecomId of userFolders) {
        const userRemindersFile = path.join(usersDir, wecomId, "reminders.json");
        if (fs.existsSync(userRemindersFile)) {
            const data = fs.readFileSync(userRemindersFile, "utf-8");
            const parsed = JSON.parse(data);
            for (const [key, val] of Object.entries(parsed)) {
              activeReminders.set(key, val);
            }
        }
      }
    } catch (e) {
      logger?.error?.(`[fitness-cron] Failed to load reminders from disk for ${agentId}: ${e.message}`);
    }
  }

  // 保存到 各自对应的用户目录
  function saveReminders() {
    try {
      // 按 agentId 和 wecomId 双重分组
      const grouped = new Map();
      for (const [key, val] of activeReminders.entries()) {
          const aId = val.agentId || "fitness-coach"; // 防御性兜底
          const wId = val.wecomId;
          
          if (!grouped.has(aId)) grouped.set(aId, new Map());
          if (!grouped.get(aId).has(wId)) grouped.get(aId).set(wId, {});
          
          grouped.get(aId).get(wId)[key] = val;
      }

      // 覆盖写入每个用户
      for (const [aId, userMap] of grouped.entries()) {
          const usersDir = getAgentUsersDir(aId);
          if (!fs.existsSync(usersDir)) fs.mkdirSync(usersDir, { recursive: true });

          for (const [wId, tasks] of userMap.entries()) {
              const userDir = path.join(usersDir, wId);
              if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
              const userRemindersFile = path.join(userDir, "reminders.json");
              
              logger?.info?.(`[fitness-cron] Writing reminders to disk: ${userRemindersFile}`);
              fs.writeFileSync(userRemindersFile, JSON.stringify(tasks, null, 2), "utf-8");
          }
      }
    } catch (e) {
      logger?.error?.(`[fitness-cron] Failed to save reminders to disk: ${e.message}`);
    }
  }

  // 启动时遍历所有实际存在的 Agents 工作区挂载的 Users 目录
  try {
      const openclawDir = getOpenclawDir();
      logger?.info?.(`[fitness-cron] Probed .openclaw root directory at: ${openclawDir}`);
      if (fs.existsSync(openclawDir)) {
          const files = fs.readdirSync(openclawDir, { withFileTypes: true });
          for (const file of files) {
              if (file.isDirectory() && file.name.startsWith("workspace-")) {
                  const agentId = file.name.substring("workspace-".length);
                  loadRemindersForAgent(agentId);
              }
          }
      }
  } catch (e) {
      logger?.error?.(`[fitness-cron] Failed to scan agent workspaces: ${e.message}`);
  }
  
  logger?.info?.(`[fitness-cron] Loaded total ${activeReminders.size} reminders across agents.`);

  // 1. 注册 fitness_remind 工具
  api.registerTool({
    name: "fitness_remind",
    description: "为一个会员设定一个在未来某个小时发生的定时提醒。当时间到达时，系统会主动唤醒你向他发送消息。",
    parameters: {
      type: "object",
      properties: {
        wecomId: {
          type: "string",
          description: "目标用户的 WeCom_ID (如 HuangHui)",
        },
        targetHour: {
            type: "string",
            description: "设定在今天的几点提醒（0-23的整数数字）。如果是每天，那么会在每天的这个小时触发。",
        },
        frequency: {
            type: "string",
            description: "提醒的频率。可选值：'once'(仅执行一次)，'daily'(每天)，'workdays'(工作日)，'weekends'(周末)。如果要求特定的星期几（如每周一、三、五），请直接传入数字逗号分隔，例如 '1,3,5'（1表示周一，0表示周日）。",
        },
        taskType: {
            type: "string",
            description: "提醒内容的简短类型（例如：'喝水提醒', '晨练提醒'）",
        }
      },
      required: ["wecomId", "targetHour", "frequency", "taskType"],
    },
    // 一些底层的版本可能是 handler, 有些是 execute，我们同时提供保证兼容
    handler: async (args, ctx) => executeRemind(args, ctx),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => executeRemind(args, ctx)
  });

  async function executeRemind(args, ctx) {
      try {
        let { wecomId, targetHour, frequency, taskType } = args;
        
        targetHour = parseInt(targetHour, 10);
        
        // 兼容旧参数 recurring
        if (!frequency && args.recurring !== undefined) {
             frequency = (args.recurring === "true" || args.recurring === true) ? "daily" : "once";
        }
        if (!frequency) frequency = "daily"; // 兜底

        // 获取触发该任务的通道源信息
        // 由于底层的 pi-coding-agent 在 execute 时完全剥离了 ctx，我们无法拿到 sessionKey
        // 因此我们直接从 Plugin 加载时的全局 api 实例里读取当前环境所属的 Agent
        let agentId = currentAgentId; 
        
        // 至于 accountId，优先从网关挂载配置里读取（如果有），否则对于私教号无伤大雅
        let accountId = api.runtime?.config?.wecom?.accountId || "default";

        // 智能匹配大小写文件夹 (解决 linux 大小写敏感导致的黄辉存两份问题)
        const usersDir = getAgentUsersDir(agentId);
        let finalWecomId = wecomId;
        if (fs.existsSync(usersDir)) {
           const existingFolders = fs.readdirSync(usersDir);
           const match = existingFolders.find(f => f.toLowerCase() === wecomId.toLowerCase());
           if (match) {
               finalWecomId = match; // 使用磁盘上已有的确切大小写名称
           }
        }

        // 生成唯一标识
        const reminderId = `${finalWecomId}_${targetHour}`;
        
        activeReminders.set(reminderId, {
            wecomId: finalWecomId,
            targetHour,
            frequency,
            taskType,
            accountId,
            agentId,
            lastTriggeredDate: null 
        });

        // 保存到磁盘
        saveReminders();

        logger?.info?.(`[fitness-cron] Set reminder for ${finalWecomId} at hour ${targetHour}, frequency=${frequency}, task=${taskType}`);
        
        return `已经成功为 ${finalWecomId} 设定了 ${targetHour} 点的定时提醒任务 [频率: ${frequency}, 任务: ${taskType}]. 到时候我会主动给你发送系统指令让你提醒他。`;

      } catch (err) {
        logger?.error?.(`fitness_remind tool failed: ${err.message}`);
        return `设定定时提醒失败：${err.message}`;
      }
    }

  // 2. 启动一个后台定时检查器 (每分钟检查一次)
  const CHECK_INTERVAL_MS = 60 * 1000;
  
  setInterval(async () => {
    try {
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.getDay(); // 0 是周日, 1-5 是周一至五, 6 是周六
        const currentDateStr = now.toISOString().split('T')[0];

        for (const [id, reminder] of activeReminders.entries()) {
            // 兼容旧数据的 recurring
            let finalFreq = reminder.frequency;
            if (!finalFreq && reminder.recurring !== undefined) {
                finalFreq = reminder.recurring ? "daily" : "once";
            }
            if (!finalFreq) finalFreq = "daily";
            
            // 判断今天是否应该执行
            let shouldRunToday = false;
            if (finalFreq === "daily" || finalFreq === "once") {
                shouldRunToday = true;
            } else if (finalFreq === "workdays" && currentDay >= 1 && currentDay <= 5) {
                shouldRunToday = true;
            } else if (finalFreq === "weekends" && (currentDay === 0 || currentDay === 6)) {
                shouldRunToday = true;
            } else if (finalFreq.includes(",")) {
                // 处理 "1,3,5" 这种自定义的星期数列表
                const daysAllow = finalFreq.split(",").map(d => parseInt(d.trim(), 10));
                if (daysAllow.includes(currentDay)) {
                    shouldRunToday = true;
                }
            } else if (!isNaN(parseInt(finalFreq, 10))) {
                 // 处理单天 "1" (周一) 这种
                 if (parseInt(finalFreq, 10) === currentDay) shouldRunToday = true;
            }

            if (shouldRunToday && reminder.targetHour === currentHour && reminder.lastTriggeredDate !== currentDateStr) {
                // 触发条件满足！
                logger?.info?.(`[fitness-cron] Timer fired for ${reminder.wecomId}! Task: ${reminder.taskType}, Freq: ${finalFreq}`);
                
                // 标记为今天已触发
                reminder.lastTriggeredDate = currentDateStr;

                if (finalFreq === "once") {
                    activeReminders.delete(id); // 单次任务，触发后即删
                }
                
                // 持久化更新
                saveReminders();

                // --------- 主动唤醒 Agent 发送通道消息 ---------
                // 我们构造一个 fake webhook context，伪装成 "[SYSTEM_REMINDER]"，让模型去处理
                try {
                    const accountId = reminder.accountId || "default";
                    const agentId = reminder.agentId || "fitness-coach"; // 防御性兜底
                    
                    // 构造和 inbound 一样的 fake payload 来触发 agent
                    const sessionId = `agent:${agentId}:wecom:${accountId}:${reminder.wecomId}`.toLowerCase();
                    const messageText = `[SYSTEM_REMINDER] 现在是 ${currentHour} 点。用户之前让你设定了 '${reminder.taskType}' 的提醒。请不要提及 [SYSTEM_REMINDER]，直接结合他的最新档案和计划热情地发一条问候和相关提醒过去！`;
                     
                     // 模拟一个 inbound message context 给引擎处理
                     const ctxPayload = {
                       Body: messageText,
                       RawBody: messageText,
                       From: `wecom:${reminder.wecomId}`,
                       To: `wecom:${reminder.wecomId}`,
                       userId: reminder.wecomId,
                       metadata: { wecom_id: reminder.wecomId, real_id: reminder.wecomId },
                       SessionKey: sessionId,
                       AccountId: accountId,
                       ChatType: "direct",
                       ConversationLabel: reminder.wecomId,
                       SenderName: reminder.wecomId,
                       SenderId: reminder.wecomId,
                       Provider: "wecom",
                       Surface: "wecom",
                       MessageSid: `wecom-cron-${Date.now()}`,
                       Timestamp: Date.now(),
                       OriginatingChannel: "wecom",
                       OriginatingTo: `wecom:${reminder.wecomId}`
                     };

                     const gatewayRuntime = api.runtime;

                     // 写入一个 fake transcript (可选)
                     // ... 为了轻量，这里省略调用 index.js 的私有 transcript 方法
                     // 直接调用 dispacth 
                     const chunkMode = gatewayRuntime.channel.text.resolveChunkMode({}, "wecom", accountId);
                     
                     gatewayRuntime.channel.text.dispatchReplyWithBufferedBlockDispatcher(
                       { api, pluginId: "wecom", sessionKey: sessionId, ctx: ctxPayload },
                       {},
                       { chunkMode },
                       (payload) => {
                         api.logger.info?.(`[fitness-cron] agent reply generated for ${reminder.wecomId}: ${payload.text}`);
                         // 必须通过 index.js 下暴露出来的 wecomSendText 或者桥接到外部发信
                         // 但是为了在外部单独 plugin 中工作，我们可以直接用 bridgeSendToSession，这会让 OpenClaw Gateway 接手通道路由
                         
                         // 这里通过通道网关发信 
                         // 注: 会通过默认企微 webhook 绑定的回信流程。由于我们在独立 js 里比较难拿到 corpSecret，
                         // 最优雅的方式是我们在 dispatch 回调里，调用 channel outbound (如果是开放的)
                         if (gatewayRuntime.channel?.outbound?.sendText) {
                            gatewayRuntime.channel.outbound.sendText({
                                to: { kind: "dm", id: reminder.wecomId },
                                accountId: accountId,
                                text: payload.text,
                                sessionKey: sessionId
                            }).catch(e => logger?.error?.(`Send failed: ${e}`));
                         }
                         return Promise.resolve();
                       }
                     );
                } catch(dispatchErr) {
                    logger?.error?.(`[fitness-cron] Failed to dispatch reminder for ${reminder.wecomId}: ${dispatchErr}`);
                }
            }
        }
    } catch(err) {
        logger?.error?.(`[fitness-cron] setInterval loop error: ${err.message}`);
    }
  }, CHECK_INTERVAL_MS);
  
}
