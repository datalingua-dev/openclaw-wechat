import fetch from "node-fetch";

// ============================================================================
// 适配器 (Adapters)：不同厂家的视频生成 API 在这里对接
// ============================================================================

/**
 * 阿里云百炼 (DashScope / WanX) 适配器
 */
async function generateViaDashscope({ prompt, apiKey, apiUrl, model, logger }) {
  const createEndpoint = `${apiUrl}/services/aigc/video-generation/video-synthesis`;
  
  // 1. 发起生成请求
  const createRes = await fetch(createEndpoint, {
      method: "POST",
      headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({ model, input: { prompt } })
  });

  if (!createRes.ok) {
      let errText = "";
      try { errText = await createRes.text(); } catch (e) {}
      throw new Error(`Dashscope 任务创建失败, HTTP Status: ${createRes.status}, Body: ${errText}`);
  }

  const createJson = await createRes.json();
  const taskId = createJson.output?.task_id;
  if (!taskId) throw new Error("百炼接口未返回 task_id");

  // 2. 轮询等待
  const statusUrl = `${apiUrl}/tasks/${taskId}`;
  while (true) {
    const res = await fetch(statusUrl, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    
    if (!res.ok) throw new Error(`获取任务状态失败 HTTP ${res.status}`);

    const json = await res.json();
    if (json.output?.task_status === "SUCCEEDED") {
      return json.output.video_url; 
    }
    if (json.output?.task_status === "FAILED") {
      throw new Error(`视频生成失败: ${json.output.message}`);
    }

    logger?.info?.(`[Dashscope] video task ${taskId} is ${json.output?.task_status}, waiting...`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

/**
 * Google Veo (Vertex AI API) 适配器
 */
async function generateViaGoogleVeo({ prompt, apiKey, apiUrl, model, logger }) {
  // Google Vertex AI API 通常的 endpoint 类似：
  // https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/${MODEL_ID}:predict
  // 此处我们需要用户将完整的 URL 配置在 apiUrl 里，例如：
  // https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/veo-2.0-generate-001:predict
  // apiKey 则是 GCP 的 Access Token (如 gcloud auth print-access-token)
  
  if (!apiUrl || !apiUrl.includes("predict")) {
      throw new Error("使用 Google Veo 时，必须提供完整的 Vertex AI predict Endpoint (如 https://.../:predict)");
  }

  model = model || "veo-2.0-generate-001";
  logger?.info?.(`[GoogleVeo] Generating video via ${apiUrl}`);
  
  // Veo API 请求体示例
  const requestBody = {
    instances: [
      {
        prompt: prompt,
      }
    ],
    parameters: {
      sampleCount: 1, // 生成 1 个视频
      aspectRatio: "16:9",
      personGeneration: "DONT_ALLOW" // 默认不生成人脸以规避政策拦截
    }
  };

  const createRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody)
  });

  if (!createRes.ok) {
      let errText = "";
      try { errText = await createRes.text(); } catch(e){}
      throw new Error(`Google Veo 调用失败 HTTP ${createRes.status}: ${errText}`);
  }

  const json = await createRes.json();
  
  // 处理预测结果：Vertex AI predict 会同步/异步返回 predictions 数组
  // Veo 的返回结构中，predictions 数组包含生成的内容，可能是 base64 或者是 cloud storage URI
  const prediction = json.predictions?.[0];
  if (!prediction) {
      throw new Error(`Google Veo 未返回任何视频数据: ${JSON.stringify(json)}`);
  }

  // 根据 Veo 文档，如果指定了 GCS URI 会存在 cloudStorageUri 属性，否则返回 base64
  // 注意：OpenClaw的 wecom media 下载接口不支持直接传递非常庞大的 base64 给微信，
  // 我们更倾向于传递一个 URL (WeCom API 会通过 fetch 下载)。由于 VertexAI 返回了 base64，
  // 如果企业微信必须使用外部 URL，我们要在此处抛出异常，或在此地将 base64 转成文件提供给 Openclaw Core。
  // 我们将这部分转为临时文件后生成 file:// url 返回：

  if (prediction.bytesBase64Encoded) {
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");
    
    // 生成视频文件的临时存储路径
    const tempDir = os.tmpdir();
    const fileName = `google-veo-${Date.now()}-${Math.random().toString(36).substring(2)}.mp4`;
    const tempFilePath = path.join(tempDir, fileName);
    
    // 解码并保存到本地
    const videoBuffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
    await fs.writeFile(tempFilePath, videoBuffer);
    
    logger?.info?.(`[GoogleVeo] Video saved locally to ${tempFilePath}`);
    
    // 返回包含本地路径的 URL（需要确保 OpenClaw 下游能够读取 file:// 协议）
    // 或者直接返回本地路径（当前微信插件支持通过 MediaUrl 或 MEDIA 关键字传入路径解决）
    return `file://${tempFilePath}`;
    
  } else if (prediction.cloudStorageUri) {
     // 返回 GCS URI（需要外部有权限访问，或者我们需要做 signed URL 转换）
     throw new Error("Google Veo 返回了 GCS URI，请使用 bytes 返回模式以便直接发送给用户。");
  } else if (prediction.videoUri) {
     // 如果 Vertex 提供公网 URL
     return prediction.videoUri;
  }

  throw new Error(`Google Veo 返回了未知的视频数据结构。`);
}

/**
 * OpenAI (Sora) 适配器
 */
async function generateViaOpenAI({ prompt, apiKey, apiUrl, model, logger }) {
  logger?.info?.(`[OpenAI] Generating video via ${apiUrl} with model ${model}`);
  
  // 伪代码示例：
  // const res = await fetch(`${apiUrl}/video/generations`, { ... })
  
  throw new Error("OpenAI (Sora) 适配器尚未完整实现。");
}

// ============================================================================
// 核心插件逻辑 (Plugin Core)
// ============================================================================

/**
 * 通用视频插件，支持配置不同的 provider、url、model 进行分发
 */
export default function registerVideoGeneratorPlugin(api) {
  const logger = api.logger;

  const generateVideoSchema = {
    name: "generate_video",
    description: "当用户要求制作或生成视频、视觉广告、微电影时，调用本工具。传入用户的视频画面描述即可。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "生成视频所需的详细画面提示词，描述场景、镜头、动作、光影等。如果不详细，请发挥你的创意进行扩写。",
        },
        duration: {
          type: "string",
          enum: ["5s", "10s"],
          description: "想要生成的视频时长，默认是5s（可选）",
        }
      },
      required: ["prompt"],
    },
  };

  api.registerTool({
    schema: generateVideoSchema,
    
    handler: async (args, ctx) => {
      try {
        // --- 1. 从 Gateway 全局配置中提取参数 ---
        // 用户可以在 ~/.openclaw/openclaw.json 中配置如下结构：
        // "plugins": {
        //   "videoGenerator": {
        //     "provider": "dashscope",  // 或 "openai", "zhipu", "sora" 等
        //     "apiUrl": "https://dashscope.aliyuncs.com/api/v1",
        //     "apiKey": "sk-xxxx",
        //     "model": "wanx-video-generation"
        //   }
        // }
        const cfg = ctx.runtime?.config; 
        const pCfg = cfg?.plugins?.videoGenerator || {};
        
        const VIDEO_PROVIDER = pCfg.provider || process.env.VIDEO_PROVIDER || "dashscope";
        const VIDEO_API_KEY = pCfg.apiKey || process.env.VIDEO_API_KEY;
        let VIDEO_API_URL = pCfg.apiUrl || process.env.VIDEO_API_URL || "https://dashscope.aliyuncs.com/api/v1";
        const VIDEO_MODEL = pCfg.model || process.env.VIDEO_MODEL || "wanx-video-generation";

        VIDEO_API_URL = VIDEO_API_URL.replace(/\/$/, "");

        if (!VIDEO_API_KEY) {
          throw new Error("未能读取到有效的 VIDEO_API_KEY。请在 openclaw.json 的 plugins.videoGenerator 下或环境变量中配置。");
        }

        const { prompt } = args;
        
        // --- 2. 下发安抚提示 ---
        if (ctx.runtime?.channel?.outbound?.sendText && ctx.peer) {
            ctx.runtime.channel.outbound.sendText({ 
                to: ctx.peer, 
                text: `[系统] 已接单，正在调用模型 [${VIDEO_MODEL}] 渲染视频，可能需要几分钟，请耐心等待...\n\n提示词：\n"${prompt}"` 
            }).catch(e => logger?.warn?.(`wecom: failed to send placeholder text, ${e.message}`));
        }

        logger?.info?.(`[generate_video] starting task on model: ${VIDEO_MODEL}`);

        // --- 3. 针对不同厂家的 Adapter 分发 ---
        let videoUrl = "";

        if (VIDEO_PROVIDER === "dashscope") {
            videoUrl = await generateViaDashscope({ prompt, apiKey: VIDEO_API_KEY, apiUrl: VIDEO_API_URL, model: VIDEO_MODEL, logger });
        } else if (VIDEO_PROVIDER === "google-veo") {
            videoUrl = await generateViaGoogleVeo({ prompt, apiKey: VIDEO_API_KEY, apiUrl: VIDEO_API_URL, model: VIDEO_MODEL, logger });
        } else if (VIDEO_PROVIDER === "openai" || VIDEO_PROVIDER === "sora") {
            videoUrl = await generateViaOpenAI({ prompt, apiKey: VIDEO_API_KEY, apiUrl: VIDEO_API_URL, model: VIDEO_MODEL, logger });
        } else {
            throw new Error(`未知的 VIDEO_PROVIDER: ${VIDEO_PROVIDER}，插件暂未提供该厂家的适配器。`);
        }

        logger?.info?.(`[generate_video] task finished! Media url: ${videoUrl}`);

        // --- 4. 返回复合格式给 OpenClaw Core ---
        return {
          mediaUrl: videoUrl,
          text: `这是为您生成的视频成品。`
        };

      } catch (err) {
        logger?.error?.(`generate_video tool failed: ${err.message}`);
        return `生成视频时发生了错误：${err.message}`;
      }
    }
  });

  logger?.info?.("Video generator plugin registered successfully.");
}
