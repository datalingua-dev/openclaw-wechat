import fs from 'fs';
import path from 'path';
import os from 'os';
import cronParser from 'cron-parser';

// ============================================================================
// 自包含的企微消息发送（cron 插件运行在独立的 [plugins] 上下文，无法
// 访问 [gateway] 注册的 channel.outbound，因此需要直接调用企微 API）
// ============================================================================
const _accessTokenCaches = new Map(); // key: corpId:corpSecret

async function getWecomAccessTokenDirect(corpId, corpSecret) {
  const cacheKey = `${corpId}:${corpSecret}`;
  let cache = _accessTokenCaches.get(cacheKey);
  if (!cache) {
    cache = { token: null, expiresAt: 0, refreshPromise: null };
    _accessTokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 60000) {
    return cache.token;
  }
  if (cache.refreshPromise) return cache.refreshPromise;
  cache.refreshPromise = (async () => {
    try {
      const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
      const res = await fetch(tokenUrl);
      const json = await res.json();
      if (!json?.access_token) throw new Error(`WeCom gettoken failed: ${JSON.stringify(json)}`);
      cache.token = json.access_token;
      cache.expiresAt = Date.now() + (json.expires_in || 7200) * 1000;
      return cache.token;
    } finally {
      cache.refreshPromise = null;
    }
  })();
  return cache.refreshPromise;
}

async function sendWecomTextDirect({ corpId, corpSecret, agentId, toUser, text, logger }) {
  const accessToken = await getWecomAccessTokenDirect(corpId, corpSecret);
  const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
  const body = {
    touser: toUser,
    msgtype: "text",
    agentid: agentId,
    text: { content: text },
    safe: 0,
  };
  const res = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json?.errcode !== 0) {
    throw new Error(`WeCom send failed: ${JSON.stringify(json)}`);
  }
  logger?.info?.(`[fitness-cron] WeChat message sent to ${toUser} ok`);
  return json;
}

// ============================================================================
// Cron-like Notification Plugin for Fitness Coach
// ============================================================================

export default function registerFitnessCronPlugin(api, opts) {
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

  // 暴力从磁盘读取 openclaw.json 获取 binding，解决插件上下文拿不到 binding 的问题
  function resolveAccountIdFromDisk(agentId) {
      try {
          const configPath = path.join(getOpenclawDir(), 'openclaw.json');
          if (fs.existsSync(configPath)) {
              const rawCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              const bindings = rawCfg.bindings || [];
              const binding = bindings.find(b => b.agentId === agentId && b.match?.channel === "wecom");
              if (binding?.match?.accountId) {
                  return binding.match.accountId;
              }
          }
      } catch (e) {
          api.logger.error?.(`[fitness-cron] Failed to resolve bindings from openclaw.json on disk: ${e.message}`);
      }
      return null;
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

  // 启动时仅读取当前生效的 Agent 的提醒数据
  try {
      logger?.info?.(`[fitness-cron] Loading reminders for current agent: ${currentAgentId}`);
      loadRemindersForAgent(currentAgentId);
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
        cronExpression: {
            type: "string",
            description: "（推荐）设定的 Cron 表达式，如 '0 8 * * *' 代表每天上午 8 点。如果使用该参数，下面的 targetHour 和 frequency 可以忽略。",
        },
        targetHour: {
            type: "string",
            description: "（兼容用法）设定在今天的几点提醒（0-23的整数数字）。如果提供了 cronExpression 则忽略此项。",
        },
        frequency: {
            type: "string",
            description: "（兼容用法）提醒的频率。可选值：'once', 'daily', 'workdays', 'weekends' 等。如果要求特定的星期几请传入数字逗号分隔。如果提供了 cronExpression 则忽略此项。",
        },
        taskType: {
            type: "string",
            description: "提醒内容的简短类型（例如：'喝水提醒', '晨练提醒'）",
        }
      },
      required: ["wecomId", "taskType"], // 保留最小必填集合
    },
    // 一些底层的版本可能是 handler, 有些是 execute，我们同时提供保证兼容
    handler: async (args, ctx) => executeRemind(args, ctx),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => executeRemind(args, ctx)
  });

  async function executeRemind(args, ctx) {
      try {
        let { wecomId, targetHour, frequency, taskType, cronExpression } = args;
        
        if (cronExpression) {
            try {
                cronParser.parseExpression(cronExpression); // 验证格式
            } catch (e) {
                return `设定的 Cron 表达式无效: ${e.message}`;
            }
        } else {
            if (targetHour === undefined || !frequency) {
                return `如果没有使用 cronExpression，则必须提供 targetHour 和 frequency`;
            }
            targetHour = parseInt(targetHour, 10);
            
            // 兼容旧参数 recurring
            if (!frequency && args.recurring !== undefined) {
                 frequency = (args.recurring === "true" || args.recurring === true) ? "daily" : "once";
            }
            if (!frequency) frequency = "daily"; // 兜底
        }

        // 获取触发该任务的通道源信息
        // 由于底层的 pi-coding-agent 在 execute 时完全剥离了 ctx，我们无法拿到 sessionKey
        // 因此我们直接从 Plugin 加载时的全局 api 实例里读取当前环境所属的 Agent
        let agentId = currentAgentId; 
        
        // 动态查找真实绑定的 accountId（解决 agentId="fitness-coach" 但 accountId="fitness-coach-cs" 的不一致问题）
        let accountId = resolveAccountIdFromDisk(currentAgentId) || currentAgentId;

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
        const reminderId = cronExpression ? `${finalWecomId}_cron_${Date.now()}` : `${finalWecomId}_${targetHour}`;
        
        activeReminders.set(reminderId, {
            wecomId: finalWecomId,
            cronExpression,
            targetHour,
            frequency,
            taskType,
            accountId,
            agentId,
            lastTriggeredDate: null,
            lastTriggeredMinute: null
        });

        // 保存到磁盘
        saveReminders();

        logger?.info?.(`[fitness-cron] Set reminder for ${finalWecomId} task=${taskType}, cron=${cronExpression}, hour=${targetHour}`);
        
        if (cronExpression) {
            return `已经成功为 ${finalWecomId} 设定了基于 Cron 表达式 (${cronExpression}) 的定时提醒任务 [任务: ${taskType}].`;
        } else {
            return `已经成功为 ${finalWecomId} 设定了 ${targetHour} 点的定时提醒任务 [频率: ${frequency}, 任务: ${taskType}]. 到时候我会主动给你发送系统指令让你提醒他。`;
        }

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

        const currentMinuteStr = now.toISOString().substring(0, 16);

        logger?.info?.(`[fitness-cron] heartbeat: checking ${activeReminders.size} reminders at ${now.toLocaleString()}`);

        for (const [id, reminder] of activeReminders.entries()) {
            let shouldTriggerNow = false;
            let finalFreq = reminder.frequency;

            if (reminder.cronExpression) {
                // Cron 模式检测
                try {
                    const checkTime = new Date(now.getTime() - 60000); // 退回 1 分钟检测下一跳
                    const interval = cronParser.parseExpression(reminder.cronExpression, { currentDate: checkTime });
                    const nextRun = interval.next().toDate();
                    const nextMinuteStr = nextRun.toISOString().substring(0, 16);
                    if (nextMinuteStr === currentMinuteStr && reminder.lastTriggeredMinute !== currentMinuteStr) {
                         shouldTriggerNow = true;
                    }
                } catch(e) {
                     logger?.error?.(`[fitness-cron] Cron execution error for ${id}: ${e.message}`);
                }
                logger?.info?.(`[fitness-cron] check cron ${id}: shouldTriggerNow=${shouldTriggerNow}, cron=${reminder.cronExpression}, currentMinute=${currentMinuteStr}, lastTriggeredMinute=${reminder.lastTriggeredMinute}`);
            } else {
                // 兼容旧数据的 recurring
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

                logger?.info?.(`[fitness-cron] check ${id}: shouldRunToday=${shouldRunToday}(freq=${finalFreq}, day=${currentDay}), targetHour=${reminder.targetHour}, currentHour=${currentHour}, lastTriggeredDate=${reminder.lastTriggeredDate}, currentDateStr=${currentDateStr}`);

                if (shouldRunToday && reminder.targetHour === currentHour && reminder.lastTriggeredDate !== currentDateStr) {
                    shouldTriggerNow = true;
                }
            }

            if (shouldTriggerNow) {
                // 触发条件满足！
                logger?.info?.(`[fitness-cron] Timer fired for ${reminder.wecomId}! Task: ${reminder.taskType}, Freq/Cron: ${reminder.cronExpression || finalFreq}`);
                
                // 分别标记防重字段
                if (reminder.cronExpression) {
                    reminder.lastTriggeredMinute = currentMinuteStr;
                } else {
                    reminder.lastTriggeredDate = currentDateStr;
                }

                if (finalFreq === "once" && !reminder.cronExpression) {
                    activeReminders.delete(id); // 单次任务，触发后即删
                }
                
                // 持久化更新
                saveReminders();

                // --------- 主动唤醒 Agent 发送通道消息 ---------
                // 我们构造一个 fake webhook context，伪装成 "[SYSTEM_REMINDER]"，让模型去处理
                try {
                    const agentId = reminder.agentId || "fitness-coach"; // 防御性兜底
                    let accountId = reminder.accountId || "default";

                    // 动态修正存量数据：如果 accountId 是遗留的 "default" 或直接等于 agentId，尝试通过 bindings 查找真实的 accountId
                    let resolved = resolveAccountIdFromDisk(agentId);
                    if (resolved) {
                        accountId = resolved;
                    } else if (accountId === "default" && agentId !== "main") {
                        accountId = agentId;
                    }
                    
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

                     // 使用完整 gateway config，让 OpenClaw 核心正确解析 auth profile
                     gatewayRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(
                       {
                           ctx: ctxPayload,
                           cfg: api.config, // 使用完整 gateway config 以正确解析 auth
                           dispatcherOptions: {
                               deliver: async (payload, info) => {
                                   api.logger.info?.(`[fitness-cron] agent reply for ${reminder.wecomId}: ${payload.text?.slice(0, 80)}...`);
                                   if (payload.text) {
                                      try {
                                          // 直接使用 index.js 注入的 getWecomConfig 函数获取确切的配置
                                          let corpId, corpSecret, wecomAgentId;
                                          if (opts && typeof opts.getWecomConfig === 'function') {
                                              const cfg = opts.getWecomConfig(api, accountId);
                                              if (cfg) {
                                                  corpId = cfg.corpId;
                                                  corpSecret = cfg.corpSecret;
                                                  wecomAgentId = cfg.agentId;
                                              }
                                          }

                                          if (!corpId || !corpSecret || !wecomAgentId) {
                                              logger?.error?.(`[fitness-cron] WeChat config missing via getWecomConfig for accountId=${accountId}`);
                                          } else {
                                              await sendWecomTextDirect({
                                                  corpId,
                                                  corpSecret,
                                                  agentId: Number(wecomAgentId),
                                                  toUser: reminder.wecomId,
                                                  text: payload.text,
                                                  logger
                                              });
                                          }
                                      } catch (e) {
                                          logger?.error?.(`[fitness-cron] Send failed: ${e}`);
                                      }
                                   }
                               },
                               onError: (err, info) => {
                                   logger?.error?.(`[fitness-cron] Dispatch reply error: ${err}`);
                               }
                           },
                           replyOptions: {
                               disableBlockStreaming: true
                           }
                       }
                     );
                } catch(dispatchErr) {
                    logger?.error?.(`[fitness-cron] Failed to dispatch reminder for ${reminder.wecomId}: ${dispatchErr.stack || dispatchErr}`);
                }
            }
        }
    } catch(err) {
        logger?.error?.(`[fitness-cron] setInterval loop error: ${err.message}`);
    }
  }, CHECK_INTERVAL_MS);
  
}
