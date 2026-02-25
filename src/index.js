import crypto from "node:crypto";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import {
  normalizePluginHttpPath,
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntry,
  clearHistoryEntriesIfEnabled,
} from "clawdbot/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, mkdir, appendFile } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const PLUGIN_VERSION = _require("../package.json").version;

// --- Proxy support for WeCom API calls ---
import { ProxyAgent as _UndiciProxyAgent } from "undici";

const WECOM_PROXY_URL = process.env.WECOM_PROXY || process.env.HTTPS_PROXY || "";
let _wecomProxyDispatcher = null;
if (WECOM_PROXY_URL) {
  _wecomProxyDispatcher = new _UndiciProxyAgent(WECOM_PROXY_URL);
}

function wecomFetch(url, opts = {}) {
  if (_wecomProxyDispatcher && typeof url === "string" && url.includes("qyapi.weixin.qq.com")) {
    return fetch(url, { ...opts, dispatcher: _wecomProxyDispatcher });
  }
  return fetch(url, opts);
}
// --- End proxy support ---

const execFileAsync = promisify(execFile);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false, // 禁用实体处理，防止 XXE 攻击
});
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });

// 请求体大小限制 (1MB)
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

function readRequestBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return sha1(arr.join(""));
}

function decodeAesKey(aesKey) {
  const base64 = aesKey.endsWith("=") ? aesKey : `${aesKey}=`;
  return Buffer.from(base64, "base64");
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function decryptWecom({ aesKey, cipherTextBase64 }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(cipherTextBase64, "base64")),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(plain);
  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  const msg = unpadded.subarray(msgStart, msgEnd).toString("utf8");
  const corpId = unpadded.subarray(msgEnd).toString("utf8");
  return { msg, corpId };
}

function parseIncomingXml(xml) {
  const obj = xmlParser.parse(xml);
  const root = obj?.xml ?? obj;
  return root;
}

function requireEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v;
}

function asNumber(v, fallback = null) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 企业微信 access_token 缓存（支持多账户/多应用）
// key: corpId:corpSecret — 同一企业下不同应用的 secret 不同，token 也不同，必须分开缓存
const accessTokenCaches = new Map();

async function getWecomAccessToken({ corpId, corpSecret }) {
  const cacheKey = `${corpId}:${corpSecret}`;
  let cache = accessTokenCaches.get(cacheKey);
  if (!cache) {
    cache = { token: null, expiresAt: 0, refreshPromise: null };
    accessTokenCaches.set(cacheKey, cache);
  }
  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 60000) {
    return cache.token;
  }
  // 如果已有刷新在进行中，等待它完成
  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }
  cache.refreshPromise = (async () => {
    try {
      const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
      const tokenRes = await wecomFetch(tokenUrl);
      const tokenJson = await tokenRes.json();
      if (!tokenJson?.access_token) {
        throw new Error(`WeCom gettoken failed: ${JSON.stringify(tokenJson)}`);
      }
      cache.token = tokenJson.access_token;
      cache.expiresAt = Date.now() + (tokenJson.expires_in || 7200) * 1000;
      return cache.token;
    } finally {
      cache.refreshPromise = null;
    }
  })();
  return cache.refreshPromise;
}

// Markdown 转换为企业微信纯文本
// 企业微信不支持 Markdown 渲染，需要转换为可读的纯文本格式
function markdownToWecomText(markdown) {
  if (!markdown) return markdown;
  let text = markdown;
  // 移除代码块标记，保留内容并添加缩进
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const lines = code.trim().split('\n').map(line => '  ' + line).join('\n');
    return lang ? `[${lang}]\n${lines}` : lines;
  });
  // 移除行内代码标记
  text = text.replace(/`([^`]+)`/g, '$1');
  // 转换标题为带符号的格式
  text = text.replace(/^### (.+)$/gm, '▸ $1');
  text = text.replace(/^## (.+)$/gm, '■ $1');
  text = text.replace(/^# (.+)$/gm, '◆ $1');
  // 移除粗体/斜体标记，保留内容
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/___([^_]+)___/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  // 转换链接为 "文字 (URL)" 格式
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 转换无序列表标记
  text = text.replace(/^[\*\-] /gm, '• ');
  // 转换有序列表（保持原样，数字已经可读）
  // 转换水平线
  text = text.replace(/^[-*_]{3,}$/gm, '────────────');
  // 移除图片标记，保留 alt 文字
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图片：$1]');
  // 清理多余空行（保留最多两个连续换行）
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// 企业微信文本消息限制 (2048 字节，中文约 680 字)
const WECOM_TEXT_BYTE_LIMIT = 2000; // 留点余量

// 计算字符串的 UTF-8 字节长度
function getByteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 简单的限流器，防止触发企业微信 API 限流
class RateLimiter {
  constructor({ maxConcurrent = 3, minInterval = 200 }) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.running = 0;
    this.queue = [];
    this.lastExecution = 0;
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitTime = Math.max(0, this.lastExecution + this.minInterval - now);

    if (waitTime > 0) {
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    this.running++;
    this.lastExecution = Date.now();

    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running--;
      this.processQueue();
    }
  }
}

// API 调用限流器（最多 3 并发，200ms 间隔）
const apiLimiter = new RateLimiter({ maxConcurrent: 10, minInterval: 100 });

// 消息处理限流器（最多 10 并发）
const messageProcessLimiter = new RateLimiter({ maxConcurrent: 10, minInterval: 0 });

// 消息分段函数，按字节限制分割（企业微信限制 2048 字节）
function splitWecomText(text, byteLimit = WECOM_TEXT_BYTE_LIMIT) {
  if (getByteLength(text) <= byteLimit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (getByteLength(remaining) <= byteLimit) {
      chunks.push(remaining);
      break;
    }

    // 二分查找合适的分割点（按字节）
    let low = 1;
    let high = remaining.length;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (getByteLength(remaining.slice(0, mid)) <= byteLimit) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    let splitIndex = low;

    // 尝试在自然断点处分割（往前找 200 字符范围内）
    const searchStart = Math.max(0, splitIndex - 200);
    const searchText = remaining.slice(searchStart, splitIndex);

    // 优先在段落处分割
    let naturalBreak = searchText.lastIndexOf("\n\n");
    if (naturalBreak === -1) {
      // 其次在换行处
      naturalBreak = searchText.lastIndexOf("\n");
    }
    if (naturalBreak === -1) {
      // 再次在句号处
      naturalBreak = searchText.lastIndexOf("。");
      if (naturalBreak !== -1) naturalBreak += 1; // 包含句号
    }

    if (naturalBreak !== -1 && naturalBreak > 0) {
      splitIndex = searchStart + naturalBreak;
    }

    // 确保至少分割一些内容
    if (splitIndex <= 0) {
      splitIndex = Math.min(remaining.length, Math.floor(byteLimit / 3));
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter(c => c.length > 0);
}

// 发送单条文本消息（内部函数，带限流）
async function sendWecomTextSingle({ corpId, corpSecret, agentId, toUser, text }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "text",
      agentid: agentId,
      text: { content: text },
      safe: 0,
    };
    const sendRes = await wecomFetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom message/send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送文本消息（支持自动分段）
async function sendWecomText({ corpId, corpSecret, agentId, toUser, text, logger }) {
  const chunks = splitWecomText(text);
  logger?.info?.(`wecom: splitting message into ${chunks.length} chunks, total bytes=${getByteLength(text)}`);
  for (let i = 0; i < chunks.length; i++) {
    logger?.info?.(`wecom: sending chunk ${i + 1}/${chunks.length}, bytes=${getByteLength(chunks[i])}`);
    await sendWecomTextSingle({ corpId, corpSecret, agentId, toUser, text: chunks[i] });
    // 分段发送时添加间隔，避免触发限流
    if (i < chunks.length - 1) {
      await sleep(300);
    }
  }
}

// 上传临时素材到企业微信
async function uploadWecomMedia({ corpId, corpSecret, type, buffer, filename }) {
  const accessToken = await getWecomAccessToken({ corpId, corpSecret });
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`;

  // 构建 multipart/form-data
  const boundary = "----WecomMediaUpload" + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const res = await wecomFetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const json = await res.json();
  if (json.errcode !== 0) {
    throw new Error(`WeCom media upload failed: ${JSON.stringify(json)}`);
  }
  return json.media_id;
}

// 发送图片消息（带限流）
async function sendWecomImage({ corpId, corpSecret, agentId, toUser, mediaId }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "image",
      agentid: agentId,
      image: { media_id: mediaId },
      safe: 0,
    };
    const sendRes = await wecomFetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom image send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送视频消息（带限流）
async function sendWecomVideo({ corpId, corpSecret, agentId, toUser, mediaId, title, description }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "video",
      agentid: agentId,
      video: {
        media_id: mediaId,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      },
      safe: 0,
    };
    const sendRes = await wecomFetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom video send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送文件消息（带限流）
async function sendWecomFile({ corpId, corpSecret, agentId, toUser, mediaId }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "file",
      agentid: agentId,
      file: { media_id: mediaId },
      safe: 0,
    };
    const sendRes = await wecomFetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom file send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 从 URL 下载媒体文件
async function fetchMediaFromUrl(url) {
  // 支持本地文件路径
  if (url.startsWith("/") || url.startsWith("~")) {
    const filePath = url.startsWith("~") ? url.replace("~", homedir()) : url;
    const buffer = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      mp4: "video/mp4",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      amr: "audio/amr",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      md: "text/markdown",
      txt: "text/plain",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";
    return { buffer, contentType };
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch media from URL: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
}

// 根据文件路径/URL 判断企业微信媒体类型和文件名
function resolveWecomMediaType(mediaUrl) {
  const filename = mediaUrl.split("/").pop() || "file";
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
  const videoExts = ["mp4", "mov", "avi"];
  const voiceExts = ["amr", "mp3", "wav"];

  if (imageExts.includes(ext)) return { type: "image", filename };
  if (videoExts.includes(ext)) return { type: "video", filename };
  if (voiceExts.includes(ext)) return { type: "voice", filename };
  return { type: "file", filename };
}

const WecomChannelPlugin = {
  id: "wecom",
  meta: {
    id: "wecom",
    label: "WeCom",
    selectionLabel: "WeCom (企业微信自建应用)",
    docsPath: "/channels/wecom",
    blurb: "Enterprise WeChat internal app via callback + send API.",
    aliases: ["wework", "qiwei", "wxwork"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: {
      inbound: true,
      outbound: true, // 阶段二完成：支持发送图片
    },
    markdown: true, // 阶段三完成：支持 Markdown 转换
    multiAgent: true, // 支持多智能体路由
  },
  messaging: {
    targetResolver: {
      hint: "Use a WeCom UserId (e.g. LiXueHeng) or wecom:UserId",
      // Accept any non-empty string as a valid WeCom target (UserId)
      looksLikeId: (raw, normalized) => {
        if (!raw) return false;
        // Accept wecom: prefixed targets
        if (/^wecom:/i.test(raw)) return true;
        // Accept any alphanumeric string (WeCom UserIds are typically alphanumeric)
        if (/^[a-zA-Z0-9_.-]+$/.test(raw)) return true;
        return false;
      },
    },
  },
  config: {
    listAccountIds: (cfg) => {
      const accounts = cfg.channels?.wecom?.accounts;
      if (accounts && Object.keys(accounts).length > 0) return Object.keys(accounts);
      if (cfg.channels?.wecom?.corpId) return ["default"];
      return [];
    },
    resolveAccount: (cfg, accountId) => {
      const id = accountId ?? "default";
      // 1. 优先从 channels.wecom.accounts 读取
      const account = cfg.channels?.wecom?.accounts?.[id];
      if (account && account.corpId && account.corpSecret && account.agentId) {
        return {
          accountId: id,
          corpId: account.corpId,
          corpSecret: account.corpSecret,
          agentId: asNumber(account.agentId),
          callbackToken: account.callbackToken,
          callbackAesKey: account.callbackAesKey,
          webhookPath: account.webhookPath || `/wecom/${id}`,
        };
      }
      // 2. 回退到环境变量
      const envVars = cfg?.env?.vars ?? {};
      const accountPrefix = id === "default" ? "WECOM" : `WECOM_${id.toUpperCase()}`;
      const corpId = envVars[`${accountPrefix}_CORP_ID`] || envVars.WECOM_CORP_ID;
      const corpSecret = envVars[`${accountPrefix}_CORP_SECRET`] || envVars.WECOM_CORP_SECRET;
      const agentId = envVars[`${accountPrefix}_AGENT_ID`] || envVars.WECOM_AGENT_ID;
      const callbackToken = envVars[`${accountPrefix}_CALLBACK_TOKEN`] || envVars.WECOM_CALLBACK_TOKEN;
      const callbackAesKey = envVars[`${accountPrefix}_CALLBACK_AES_KEY`] || envVars.WECOM_CALLBACK_AES_KEY;
      const webhookPath = envVars[`${accountPrefix}_WEBHOOK_PATH`] || (id === "default" ? "/wecom/callback" : `/wecom/${id}`);
      if (corpId && corpSecret && agentId) {
        return {
          accountId: id,
          corpId,
          corpSecret,
          agentId: asNumber(agentId),
          callbackToken,
          callbackAesKey,
          webhookPath,
        };
      }
      return { accountId: id };
    },
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) return { ok: false, error: new Error("WeCom requires --to <UserId>") };
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, sessionKey }) => {
      // 从 sessionKey 或 to 中提取 accountId
      // 支持多智能体格式: agent:<agentId>:wecom:<accountId>:...
      let extractedAccountId = accountId;
      if (!extractedAccountId && sessionKey) {
        const agentMatch = sessionKey.match(/^agent:[^:]+:wecom:([a-z0-9_-]+):/i);
        const simpleMatch = sessionKey.match(/^wecom:([a-z0-9_-]+):/i);
        if (agentMatch) extractedAccountId = agentMatch[1];
        else if (simpleMatch) extractedAccountId = simpleMatch[1];
      }
      if (!extractedAccountId && to) {
        const match = to.match(/^wecom:([a-z0-9_-]+):/i);
        if (match) extractedAccountId = match[1];
      }
      extractedAccountId = extractedAccountId || "default";

      const config = getWecomConfig(gatewayRuntime, extractedAccountId);
      if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
        return { ok: false, error: new Error(`WeCom not configured for accountId=${extractedAccountId}`) };
      }
      const userId = to.startsWith("wecom:") ? to.slice(6) : to;
      await sendWecomText({ corpId: config.corpId, corpSecret: config.corpSecret, agentId: config.agentId, toUser: userId, text });
      return { ok: true, provider: "wecom" };
    },
    sendMedia: async ({ to, text, mediaUrl }) => {
      const config = getWecomConfig();
      if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
        return { ok: false, error: new Error("WeCom not configured") };
      }
      const { corpId, corpSecret, agentId } = config;
      if (mediaUrl) {
        try {
          const { buffer } = await fetchMediaFromUrl(mediaUrl);
          const { type, filename } = resolveWecomMediaType(mediaUrl);
          const mediaId = await uploadWecomMedia({ corpId, corpSecret, type, buffer, filename });
          if (type === "image") {
            await sendWecomImage({ corpId, corpSecret, agentId, toUser: to, mediaId });
          } else if (type === "video") {
            await sendWecomVideo({ corpId, corpSecret, agentId, toUser: to, mediaId });
          } else {
            await sendWecomFile({ corpId, corpSecret, agentId, toUser: to, mediaId });
          }
        } catch (err) {
          // 媒体发送失败，降级为文本
          if (text) {
            await sendWecomText({ corpId, corpSecret, agentId, toUser: to, text: `${text}\n\n[文件：${mediaUrl}]` });
            return { ok: true, provider: "wecom" };
          }
        }
      }
      // 发送 caption 文本
      if (text) {
        await sendWecomText({ corpId, corpSecret, agentId, toUser: to, text });
      }
      return { ok: true, provider: "wecom" };
    },
  },
  // 入站消息处理 - clawdbot 会调用这个方法
  inbound: {
    // 当消息需要回复时，clawdbot 会调用这个方法
    deliverReply: async ({ to, text, accountId, mediaUrl, mediaType, sessionKey }) => {
      // 从 sessionKey 或 to 中提取 accountId
      // 支持多智能体格式: agent:<agentId>:wecom:<accountId>:...
      let extractedAccountId = accountId;
      if (!extractedAccountId && sessionKey) {
        const agentMatch = sessionKey.match(/^agent:[^:]+:wecom:([a-z0-9_-]+):/i);
        const simpleMatch = sessionKey.match(/^wecom:([a-z0-9_-]+):/i);
        if (agentMatch) extractedAccountId = agentMatch[1];
        else if (simpleMatch) extractedAccountId = simpleMatch[1];
      }
      if (!extractedAccountId && to) {
        const match = to.match(/^wecom:([a-z0-9_-]+):/i);
        if (match) extractedAccountId = match[1];
      }
      extractedAccountId = extractedAccountId || "default";

      const config = getWecomConfig(gatewayRuntime, extractedAccountId);
      if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
        throw new Error(`WeCom not configured for accountId=${extractedAccountId}`);
      }
      const { corpId, corpSecret, agentId } = config;
      // to 格式为 "wecom:userid"，需要提取 userid
      const userId = to.startsWith("wecom:") ? to.slice(6) : to;

      // 如果有媒体附件，先发送媒体
      if (mediaUrl) {
        try {
          const { buffer } = await fetchMediaFromUrl(mediaUrl);
          const { type, filename } = resolveWecomMediaType(mediaUrl);
          const mediaId = await uploadWecomMedia({ corpId, corpSecret, type, buffer, filename });
          if (type === "image") {
            await sendWecomImage({ corpId, corpSecret, agentId, toUser: userId, mediaId });
          } else if (type === "video") {
            await sendWecomVideo({ corpId, corpSecret, agentId, toUser: userId, mediaId });
          } else {
            await sendWecomFile({ corpId, corpSecret, agentId, toUser: userId, mediaId });
          }
        } catch (mediaErr) {
          // 媒体发送失败不阻止文本发送，只记录警告
          console.warn?.(`wecom: failed to send media: ${mediaErr.message}`);
        }
      }

      // 发送文本消息
      if (text) {
        await sendWecomText({ corpId, corpSecret, agentId, toUser: userId, text });
      }

      return { ok: true };
    },
  },
};

// 存储 runtime 引用以便在消息处理中使用
let gatewayRuntime = null;

// 存储 gateway broadcast 上下文，用于向 Chat UI 广播消息
let gatewayBroadcastCtx = null;

// 写入消息到 session transcript 文件，使 Chat UI 可以显示
async function writeToTranscript({ sessionKey, role, text, logger, agentId }) {
  try {
    const stateDir = process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || join(homedir(), ".openclaw");
    const resolvedAgentId = agentId || "main";
    const sessionsDir = join(stateDir, "agents", resolvedAgentId, "sessions");
    const sessionsJsonPath = join(sessionsDir, "sessions.json");

    // 读取 sessions.json 获取 sessionId
    if (!existsSync(sessionsJsonPath)) {
      logger?.warn?.("wecom: sessions.json not found");
      return;
    }

    const { readFileSync } = await import("node:fs");
    const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf8"));
    const sessionEntry = sessionsData[sessionKey] || sessionsData[sessionKey.toLowerCase()];

    if (!sessionEntry?.sessionId) {
      logger?.warn?.(`wecom: session entry not found for ${sessionKey}`);
      return;
    }

    const transcriptPath = sessionEntry.sessionFile || join(sessionsDir, `${sessionEntry.sessionId}.jsonl`);
    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);
    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: {
        role,
        content: [{ type: "text", text }],
        timestamp: now,
        stopReason: role === "assistant" ? "end_turn" : undefined,
        usage: role === "assistant" ? { input: 0, output: 0, totalTokens: 0 } : undefined,
      },
    };
    appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    logger?.info?.(`wecom: wrote ${role} message to transcript`);
  } catch (err) {
    logger?.warn?.(`wecom: failed to write transcript: ${err.message}`);
  }
}

// 广播消息到 Chat UI
function broadcastToChatUI({ sessionKey, role, text, runId, state }) {
  if (!gatewayBroadcastCtx) {
    return; // 没有 broadcast 上下文，跳过
  }
  try {
    const chatPayload = {
      runId: runId || `wecom-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: state || "final",
      message: {
        role: role || "user",
        content: [{ type: "text", text: text || "" }],
        timestamp: Date.now(),
      },
    };
    gatewayBroadcastCtx.broadcast("chat", chatPayload);
    gatewayBroadcastCtx.bridgeSendToSession(sessionKey, "chat", chatPayload);
  } catch (err) {
    // 忽略广播错误，不影响主流程
  }
}

// 多账户配置存储
const wecomAccounts = new Map(); // key: accountId, value: config
let defaultAccountId = "default";

// 会话历史存储（对标 Telegram guildHistories）
const sessionHistories = new Map(); // key: sessionKey, value: Array<HistoryEntry>
const DEFAULT_HISTORY_LIMIT = 20; // 默认保留最近 20 条消息

// 获取 wecom 配置（支持多账户）
// 优先级：channels.wecom > env.vars > 进程环境变量
function getWecomConfig(api, accountId = null) {
  const targetAccountId = accountId || defaultAccountId;

  // 如果已缓存，直接返回
  if (wecomAccounts.has(targetAccountId)) {
    return wecomAccounts.get(targetAccountId);
  }

  const cfg = api?.config ?? gatewayRuntime?.config;

  // 1. 优先从 channels.wecom 读取配置
  const channelConfig = cfg?.channels?.wecom;
  if (channelConfig && targetAccountId === "default") {
    const corpId = channelConfig.corpId;
    const corpSecret = channelConfig.corpSecret;
    const agentId = channelConfig.agentId;
    const callbackToken = channelConfig.callbackToken;
    const callbackAesKey = channelConfig.callbackAesKey;
    const webhookPath = channelConfig.webhookPath || "/wecom/callback";

    if (corpId && corpSecret && agentId) {
      const config = {
        accountId: targetAccountId,
        corpId,
        corpSecret,
        agentId: asNumber(agentId),
        callbackToken,
        callbackAesKey,
        webhookPath,
        enabled: channelConfig.enabled !== false,
      };
      wecomAccounts.set(targetAccountId, config);
      return config;
    }
  }

  // 2. 多账户支持：从 channels.wecom.accounts 读取
  const accountConfig = cfg?.channels?.wecom?.accounts?.[targetAccountId];
  if (accountConfig) {
    const corpId = accountConfig.corpId;
    const corpSecret = accountConfig.corpSecret;
    const agentId = accountConfig.agentId;
    const callbackToken = accountConfig.callbackToken;
    const callbackAesKey = accountConfig.callbackAesKey;
    const webhookPath = accountConfig.webhookPath || "/wecom/callback";

    if (corpId && corpSecret && agentId) {
      const config = {
        accountId: targetAccountId,
        corpId,
        corpSecret,
        agentId: asNumber(agentId),
        callbackToken,
        callbackAesKey,
        webhookPath,
        enabled: accountConfig.enabled !== false,
      };
      wecomAccounts.set(targetAccountId, config);
      return config;
    }
  }

  // 3. 回退到 env.vars（兼容旧配置）
  const envVars = cfg?.env?.vars ?? {};
  const accountPrefix = targetAccountId === "default" ? "WECOM" : `WECOM_${targetAccountId.toUpperCase()}`;

  let corpId = envVars[`${accountPrefix}_CORP_ID`];
  let corpSecret = envVars[`${accountPrefix}_CORP_SECRET`];
  let agentId = envVars[`${accountPrefix}_AGENT_ID`];
  let callbackToken = envVars[`${accountPrefix}_CALLBACK_TOKEN`];
  let callbackAesKey = envVars[`${accountPrefix}_CALLBACK_AES_KEY`];
  let webhookPath = envVars[`${accountPrefix}_WEBHOOK_PATH`];

  // 如果特定账户配置不存在，回退到默认 WECOM_* 配置
  if (!corpId && targetAccountId !== "default") {
    corpId = envVars.WECOM_CORP_ID;
    corpSecret = envVars.WECOM_CORP_SECRET;
    agentId = envVars.WECOM_AGENT_ID;
    callbackToken = envVars.WECOM_CALLBACK_TOKEN;
    callbackAesKey = envVars.WECOM_CALLBACK_AES_KEY;
  }
  if (!webhookPath) {
    webhookPath = targetAccountId === "default" ? "/wecom/callback" : `/wecom/${targetAccountId}`;
  }

  // 4. 最后回退到进程环境变量
  if (!corpId) corpId = requireEnv(`${accountPrefix}_CORP_ID`) || requireEnv("WECOM_CORP_ID");
  if (!corpSecret) corpSecret = requireEnv(`${accountPrefix}_CORP_SECRET`) || requireEnv("WECOM_CORP_SECRET");
  if (!agentId) agentId = requireEnv(`${accountPrefix}_AGENT_ID`) || requireEnv("WECOM_AGENT_ID");
  if (!callbackToken) callbackToken = requireEnv(`${accountPrefix}_CALLBACK_TOKEN`) || requireEnv("WECOM_CALLBACK_TOKEN");
  if (!callbackAesKey) callbackAesKey = requireEnv(`${accountPrefix}_CALLBACK_AES_KEY`) || requireEnv("WECOM_CALLBACK_AES_KEY");

  if (corpId && corpSecret && agentId) {
    const config = {
      accountId: targetAccountId,
      corpId,
      corpSecret,
      agentId: asNumber(agentId),
      callbackToken,
      callbackAesKey,
      webhookPath,
    };
    wecomAccounts.set(targetAccountId, config);
    return config;
  }

  return null;
}

// 列出所有已配置的账户 ID
function listWecomAccountIds(api) {
  const cfg = api?.config ?? gatewayRuntime?.config;
  const accountIds = new Set(["default"]);

  // 1. 从 channels.wecom.accounts 读取
  const channelAccounts = cfg?.channels?.wecom?.accounts;
  if (channelAccounts) {
    for (const accountId of Object.keys(channelAccounts)) {
      accountIds.add(accountId);
    }
  }

  // 2. 从 env.vars 读取 (兼容旧配置)
  const envVars = cfg?.env?.vars ?? {};
  for (const key of Object.keys(envVars)) {
    // 检测 WECOM_<ACCOUNT>_CORP_ID 或 WECOM_<ACCOUNT>_WEBHOOK_PATH
    const matchCorp = key.match(/^WECOM_([A-Z0-9]+)_CORP_ID$/);
    const matchWebhook = key.match(/^WECOM_([A-Z0-9]+)_WEBHOOK_PATH$/);
    if (matchCorp && matchCorp[1] !== "CORP") {
      accountIds.add(matchCorp[1].toLowerCase());
    } else if (matchWebhook && matchWebhook[1] !== "WEBHOOK") {
      accountIds.add(matchWebhook[1].toLowerCase());
    }
  }

  return Array.from(accountIds);
}

// 创建 webhook 处理器工厂函数
function createWebhookHandler(api, accountId) {
  return async (req, res) => {
    const config = getWecomConfig(api, accountId);
    const token = config?.callbackToken;
    const aesKey = config?.callbackAesKey;

    const url = new URL(req.url ?? "/", "http://localhost");
    const msg_signature = url.searchParams.get("msg_signature") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    const echostr = url.searchParams.get("echostr") ?? "";

    // Health check
    if (req.method === "GET" && !echostr) {
      res.statusCode = token && aesKey ? 200 : 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(token && aesKey ? "wecom webhook ok" : "wecom webhook not configured");
      return;
    }

    if (!token || !aesKey) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("WeCom plugin not configured (missing token/aesKey)");
      return;
    }

    if (req.method === "GET") {
      const expected = computeMsgSignature({ token, timestamp, nonce, encrypt: echostr });
      if (!msg_signature || expected !== msg_signature) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Invalid signature");
        return;
      }
      const { msg: plainEchostr } = decryptWecom({ aesKey, cipherTextBase64: echostr });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plainEchostr);
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end();
      return;
    }

    const rawXml = await readRequestBody(req);
    const incoming = parseIncomingXml(rawXml);
    const encrypt = incoming?.Encrypt;
    if (!encrypt) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Missing Encrypt");
      return;
    }

    const expected = computeMsgSignature({ token, timestamp, nonce, encrypt });
    if (!msg_signature || expected !== msg_signature) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Invalid signature");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("success");

    const { msg: decryptedXml } = decryptWecom({ aesKey, cipherTextBase64: encrypt });
    const msgObj = parseIncomingXml(decryptedXml);

    const chatId = msgObj.ChatId || null;
    const isGroupChat = !!chatId;

    api.logger.info?.(
      `wecom[${accountId}] inbound: FromUserName=${msgObj?.FromUserName} MsgType=${msgObj?.MsgType} ChatId=${chatId || "N/A"}`
    );

    const fromUser = msgObj.FromUserName;
    const msgType = msgObj.MsgType;

    if (msgType === "text" && msgObj?.Content) {
      processInboundMessage({ api, fromUser, content: msgObj.Content, msgType: "text", chatId, isGroupChat, accountId }).catch((err) => {
        api.logger.error?.(`wecom[${accountId}]: async message processing failed: ${err.message}`);
      });
    } else if (msgType === "image" && msgObj?.MediaId) {
      processInboundMessage({ api, fromUser, mediaId: msgObj.MediaId, msgType: "image", picUrl: msgObj.PicUrl, chatId, isGroupChat, accountId }).catch((err) => {
        api.logger.error?.(`wecom[${accountId}]: async image processing failed: ${err.message}`);
      });
    } else if (msgType === "voice" && msgObj?.MediaId) {
      processInboundMessage({ api, fromUser, mediaId: msgObj.MediaId, msgType: "voice", recognition: msgObj.Recognition, chatId, isGroupChat, accountId }).catch((err) => {
        api.logger.error?.(`wecom[${accountId}]: async voice processing failed: ${err.message}`);
      });
    } else if (msgType === "video" && msgObj?.MediaId) {
      processInboundMessage({ api, fromUser, mediaId: msgObj.MediaId, msgType: "video", thumbMediaId: msgObj.ThumbMediaId, chatId, isGroupChat, accountId }).catch((err) => {
        api.logger.error?.(`wecom[${accountId}]: async video processing failed: ${err.message}`);
      });
    } else if (msgType === "file" && msgObj?.MediaId) {
      processInboundMessage({ api, fromUser, mediaId: msgObj.MediaId, msgType: "file", fileName: msgObj.FileName, fileSize: msgObj.FileSize, chatId, isGroupChat, accountId }).catch((err) => {
        api.logger.error?.(`wecom[${accountId}]: async file processing failed: ${err.message}`);
      });
    } else if (msgType === "link") {
      processInboundMessage({ api, fromUser, msgType: "link", linkTitle: msgObj.Title, linkDescription: msgObj.Description, linkUrl: msgObj.Url, linkPicUrl: msgObj.PicUrl, chatId, isGroupChat, accountId }).catch((err) => {
        api.logger.error?.(`wecom[${accountId}]: async link processing failed: ${err.message}`);
      });
    } else {
      api.logger.info?.(`wecom[${accountId}]: ignoring unsupported message type=${msgType}`);
    }
  };
}

export default function register(api) {
  gatewayRuntime = api.runtime;

  const cfg = getWecomConfig(api);
  if (cfg) {
    api.logger.info?.(`wecom: config loaded (corpId=${cfg.corpId?.slice(0, 8)}..., accountId=${cfg.accountId || "default"})`);
  } else {
    api.logger.warn?.("wecom: no configuration found");
  }

  api.registerChannel({ plugin: WecomChannelPlugin });

  api.registerGatewayMethod("wecom.init", async (ctx, nodeId, params) => {
    gatewayBroadcastCtx = ctx;
    api.logger.info?.("wecom: gateway broadcast context captured");
    return { ok: true };
  });

  api.registerGatewayMethod("wecom.broadcast", async (ctx, nodeId, params) => {
    const { sessionKey, runId, message, state } = params || {};
    if (!sessionKey || !message) {
      return { ok: false, error: { message: "missing sessionKey or message" } };
    }
    const chatPayload = {
      runId: runId || `wecom-${Date.now()}`,
      sessionKey,
      seq: 0,
      state: state || "final",
      message: { role: message.role || "user", content: [{ type: "text", text: message.text || "" }], timestamp: Date.now() },
    };
    ctx.broadcast("chat", chatPayload);
    ctx.bridgeSendToSession(sessionKey, "chat", chatPayload);
    gatewayBroadcastCtx = ctx;
    return { ok: true };
  });

  // 为每个账户注册独立的 webhook 路由
  const accountIds = listWecomAccountIds(api);
  api.logger.info?.(`wecom: discovered ${accountIds.length} account(s): [${accountIds.join(", ")}]`);

  for (const accountId of accountIds) {
    const accountConfig = getWecomConfig(api, accountId);
    if (!accountConfig) {
      api.logger.warn?.(`wecom: skipping account "${accountId}" - no configuration`);
      continue;
    }

    const webhookPath = accountConfig.webhookPath || (accountId === "default" ? "/wecom/callback" : `/wecom/${accountId}`);
    const normalizedPath = normalizePluginHttpPath(webhookPath, "/wecom/callback") ?? webhookPath;

    api.registerHttpRoute({
      path: normalizedPath,
      handler: createWebhookHandler(api, accountId),
    });

    api.logger.info?.(`wecom: registered webhook at ${normalizedPath} for account "${accountId}" (agentId=${accountConfig.agentId}, corpId=${accountConfig.corpId?.slice(0, 8)}...)`);
  }

  if (accountIds.length > 1) {
    api.logger.info?.(`wecom: multi-app mode enabled — ${accountIds.length} applications configured, each with independent webhook and token cache`);
  }
}

// 下载企业微信媒体文件
async function downloadWecomMedia({ corpId, corpSecret, mediaId }) {
  const accessToken = await getWecomAccessToken({ corpId, corpSecret });
  const mediaUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await wecomFetch(mediaUrl);
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // 如果返回 JSON，说明有错误
  if (contentType.includes("application/json")) {
    const json = await res.json();
    throw new Error(`WeCom media download failed: ${JSON.stringify(json)}`);
  }

  const buffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(buffer),
    contentType,
  };
}

// 命令处理函数
async function handleHelpCommand({ api, fromUser, corpId, corpSecret, agentId }) {
  const helpText = `🤖 AI 助手使用帮助

可用命令：
/help - 显示此帮助信息
/clear - 清除会话历史，开始新对话
/status - 查看系统状态

直接发送消息即可与 AI 对话。

支持发送图片，AI 会分析图片内容。`;

  await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: helpText });
  return true;
}

async function handleClearCommand({ api, fromUser, corpId, corpSecret, agentId, sessionId: passedSessionId }) {
  const sessionId = passedSessionId || `wecom:${fromUser.toLowerCase()}`;
  try {
    await execFileAsync("clawdbot", ["session", "clear", "--session-id", sessionId], { timeout: 10000 });

    // 同时清除内存中的会话历史
    clearHistoryEntriesIfEnabled({ historyMap: sessionHistories, historyKey: sessionId, limit: DEFAULT_HISTORY_LIMIT });

    await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: "✅ 会话已清除，我们可以开始新的对话了！" });
  } catch (err) {
    api.logger.warn?.(`wecom: failed to clear session: ${err.message}`);
    // 即使 CLI 失败，也清除内存历史
    clearHistoryEntriesIfEnabled({ historyMap: sessionHistories, historyKey: sessionId, limit: DEFAULT_HISTORY_LIMIT });

    await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: "会话已重置，请开始新的对话。" });
  }

  return true;
}

async function handleStatusCommand({ api, fromUser, corpId, corpSecret, agentId, sessionId, resolvedAgentId, accountId }) {
  const config = getWecomConfig(api);
  const accountIds = listWecomAccountIds(api);

  // 获取当前会话历史消息数量
  const historyKey = sessionId || `wecom:${fromUser}`.toLowerCase();
  const historyEntries = sessionHistories.get(historyKey) || [];
  const historyCount = historyEntries.length;
  const currentAgentId = resolvedAgentId || "main";
  const currentAccountId = accountId || config?.accountId || "default";

  // 检测语音 STT 是否可用
  const sttPython = process.env.WECOM_STT_PYTHON || "python3";
  const sttAvailable = sttPython !== "python3" || existsSync("/usr/bin/python3");

  // 构建已配置账户的路由映射信息
  const cfg = api.config;
  const runtime = api.runtime;
  let routeInfo = "";
  for (const aid of accountIds) {
    const acctConfig = getWecomConfig(api, aid);
    if (!acctConfig) continue;
    const webhookPath = acctConfig.webhookPath || (aid === "default" ? "/wecom/callback" : `/wecom/${aid}`);
    // 尝试获取该 accountId 路由到的 agentId
    let routedAgentId = "main";
    try {
      const testRoute = runtime.channel.routing.resolveAgentRoute({
        cfg,
        sessionKey: `wecom:${aid}:test`,
        channel: "wecom",
        accountId: aid,
      });
      routedAgentId = testRoute.agentId || "main";
    } catch (_) {}
    routeInfo += `  ${aid} → ${webhookPath} → agent:${routedAgentId}\n`;
  }

  const statusText = `📊 系统状态

渠道：企业微信 (WeCom)
会话ID：${historyKey}
当前账户：${currentAccountId}
当前智能体：${currentAgentId}
插件版本：${PLUGIN_VERSION}
对话历史：${historyCount} 条（上限 ${DEFAULT_HISTORY_LIMIT} 条）

📡 已配置的应用路由：
${routeInfo}
功能状态：
✅ 文本消息
✅ 图片发送/接收
✅ 视频消息接收
✅ 文件消息接收
${sttAvailable ? "✅" : "⚠️"} 语音转文字 (STT)
✅ 消息分段 (2048 字节)
✅ 对话历史记忆
✅ 命令系统
✅ Markdown 转换
✅ API 限流
✅ 多应用多智能体路由`;

  await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: statusText });
  return true;
}

const COMMANDS = {
  "/help": handleHelpCommand,
  "/clear": handleClearCommand,
  "/status": handleStatusCommand,
};

// 异步处理入站消息 - 使用 gateway 内部 agent runtime API
async function processInboundMessage({ api, fromUser, content, msgType, mediaId, picUrl, recognition, thumbMediaId, fileName, fileSize, linkTitle, linkDescription, linkUrl, linkPicUrl, chatId, isGroupChat, accountId }) {
  const config = getWecomConfig(api, accountId);
  const cfg = api.config;
  const runtime = api.runtime;

  if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
    api.logger.warn?.("wecom: not configured (check channels.wecom in clawdbot.json)");
    return;
  }

  const { corpId, corpSecret, agentId } = config;

  try {
    // 构建 peer 信息，用于多智能体路由匹配
    const sessionAccountId = accountId || "default";
    const peer = isGroupChat
      ? { kind: "group", id: chatId }
      : { kind: "dm", id: fromUser.toLowerCase() };

    // 先构建一个临时 sessionKey 用于路由查询（不含 agentId）
    const baseSessionKey = isGroupChat
      ? `wecom:${sessionAccountId}:group:${chatId}`.toLowerCase()
      : `wecom:${sessionAccountId}:${fromUser}`.toLowerCase();

    // 获取路由信息 —— 传入 peer 信息以支持多智能体绑定匹配
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      sessionKey: baseSessionKey,
      channel: "wecom",
      accountId: sessionAccountId,
      peer,
    });
    const resolvedAgentId = route.agentId || "main";

    // 会话ID：包含 agentId 以实现多智能体会话隔离
    // 格式：agent:<agentId>:wecom:<accountId>:<userId> （与官方 Telegram 渠道一致）
    const sessionId = `agent:${resolvedAgentId}:${baseSessionKey}`;
    api.logger.info?.(`wecom: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""} (accountId=${sessionAccountId}, agentId=${resolvedAgentId})`);

    // 命令检测（仅对文本消息）
    if (msgType === "text" && content?.startsWith("/")) {
      const commandKey = content.split(/\s+/)[0].toLowerCase();
      const handler = COMMANDS[commandKey];
      if (handler) {
        api.logger.info?.(`wecom: handling command ${commandKey}`);
        await handler({ api, fromUser, corpId, corpSecret, agentId, chatId, isGroupChat, sessionId, resolvedAgentId, accountId });
        return; // 命令已处理，不再调用 AI
      }
    }

    let messageText = content || "";

    // 多模态媒体管线：下载媒体文件后通过 MediaPath 传给 OpenClaw 核心
    // OpenClaw 核心会根据 tools.media.* 配置将媒体传给多模态 LLM
    let mediaTempPath = null;
    const mediaCleanupPaths = [];

    // 处理图片消息 — 通过 OpenClaw 多模态管线传给 LLM
    if (msgType === "image" && mediaId) {
      api.logger.info?.(`wecom: downloading image mediaId=${mediaId}`);

      try {
        let imageBuffer = null;
        let imageContentType = null;

        // 优先使用 mediaId 下载原图
        try {
          const result = await downloadWecomMedia({ corpId, corpSecret, mediaId });
          imageBuffer = result.buffer;
          imageContentType = result.contentType || "image/jpeg";
        } catch (mediaErr) {
          api.logger.warn?.(`wecom: failed to download image via mediaId: ${mediaErr.message}`);
          // 降级：尝试通过 PicUrl 下载
          if (picUrl) {
            const result = await fetchMediaFromUrl(picUrl);
            imageBuffer = result.buffer;
            imageContentType = result.contentType || "image/jpeg";
          }
        }

        if (imageBuffer) {
          const ext = imageContentType?.includes("png") ? "png" : imageContentType?.includes("gif") ? "gif" : "jpg";
          const tempDir = join(tmpdir(), "openclaw-wecom");
          await mkdir(tempDir, { recursive: true });
          mediaTempPath = join(tempDir, `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
          await writeFile(mediaTempPath, imageBuffer);
          mediaCleanupPaths.push(mediaTempPath);
          messageText = "[用户发送了一张图片]";
          api.logger.info?.(`wecom: image saved to ${mediaTempPath}, size=${imageBuffer.length} bytes, type=${imageContentType}`);
        } else {
          messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
        }
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to process image: ${downloadErr.message}`);
        messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
      }
    }

    // 处理语音消息 — 下载并通过 OpenClaw 多模态管线传给 LLM
    // 同时保留本地 FunASR STT 作为降级方案
    if (msgType === "voice" && mediaId) {
      api.logger.info?.(`wecom: received voice message mediaId=${mediaId}`);

      // 始终下载语音文件，供 OpenClaw 多模态管线使用
      let voiceAmrPath = null;
      let voiceWavPath = null;
      try {
        const { buffer, contentType } = await downloadWecomMedia({ corpId, corpSecret, mediaId });
        const tempDir = join(tmpdir(), "openclaw-wecom");
        await mkdir(tempDir, { recursive: true });
        const ts = Date.now();
        voiceAmrPath = join(tempDir, `voice-${ts}.amr`);
        voiceWavPath = join(tempDir, `voice-${ts}.wav`);
        await writeFile(voiceAmrPath, buffer);
        api.logger.info?.(`wecom: saved voice to ${voiceAmrPath}, size=${buffer.length} bytes`);

        // AMR -> WAV (16kHz mono)
        await execFileAsync("ffmpeg", ["-y", "-i", voiceAmrPath, "-ar", "16000", "-ac", "1", voiceWavPath], { timeout: 10000 });
        api.logger.info?.(`wecom: converted voice to WAV`);

        // 设置 mediaTempPath，让 OpenClaw 核心处理音频
        mediaTempPath = voiceWavPath;
        mediaCleanupPaths.push(voiceAmrPath, voiceWavPath);
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download/convert voice: ${downloadErr.message}`);
        // 下载失败时清理已有的临时文件
        if (voiceAmrPath) unlink(voiceAmrPath).catch(() => {});
      }

      // 获取文本内容（作为 caption / 降级方案）
      if (recognition) {
        api.logger.info?.(`wecom: voice recognition result: ${recognition.slice(0, 50)}...`);
        messageText = `[语音消息] ${recognition}`;
      } else if (voiceWavPath && existsSync(voiceWavPath)) {
        // 尝试本地 FunASR STT 作为降级
        try {
          const sttScriptPath = join(dirname(new URL(import.meta.url).pathname), "..", "stt.py");
          const _sttPython = process.env.WECOM_STT_PYTHON || "python3";
          const { stdout } = await execFileAsync(_sttPython, [sttScriptPath, voiceWavPath], { timeout: 30000 });
          const transcription = stdout.trim();
          if (transcription) {
            api.logger.info?.(`wecom: local STT transcribed: ${transcription.slice(0, 80)}`);
            messageText = `[语音消息] ${transcription}`;
          } else {
            messageText = "[用户发送了一条语音消息]";
          }
        } catch (sttErr) {
          api.logger.warn?.(`wecom: local STT failed (will rely on OpenClaw media pipeline): ${sttErr.message}`);
          messageText = "[用户发送了一条语音消息]";
        }
      } else {
        messageText = "[用户发送了一条语音消息，但下载失败]\n\n请告诉用户语音消息处理暂时不可用。";
      }
    }

    // 处理视频消息 — 通过 OpenClaw 多模态管线传给 LLM
    if (msgType === "video" && mediaId) {
      api.logger.info?.(`wecom: received video message mediaId=${mediaId}`);

      try {
        const { buffer, contentType } = await downloadWecomMedia({ corpId, corpSecret, mediaId });
        const tempDir = join(tmpdir(), "openclaw-wecom");
        await mkdir(tempDir, { recursive: true });
        const videoTempPath = join(tempDir, `video-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
        await writeFile(videoTempPath, buffer);
        mediaTempPath = videoTempPath;
        mediaCleanupPaths.push(videoTempPath);
        messageText = "[用户发送了一个视频]";
        api.logger.info?.(`wecom: video saved to ${videoTempPath}, size=${buffer.length} bytes`);
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download video: ${downloadErr.message}`);
        messageText = "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。";
      }
    }

    // 处理文件消息 — 通过 OpenClaw 多模态管线传给 LLM
    if (msgType === "file" && mediaId) {
      api.logger.info?.(`wecom: received file message mediaId=${mediaId}, fileName=${fileName}, size=${fileSize}`);

      try {
        const { buffer, contentType } = await downloadWecomMedia({ corpId, corpSecret, mediaId });
        const ext = fileName ? fileName.split('.').pop() : 'bin';
        const safeFileName = fileName || `file-${Date.now()}.${ext}`;
        const tempDir = join(tmpdir(), "openclaw-wecom");
        await mkdir(tempDir, { recursive: true });
        const fileTempPath = join(tempDir, `${Date.now()}-${safeFileName}`);
        await writeFile(fileTempPath, buffer);
        api.logger.info?.(`wecom: saved file to ${fileTempPath}, size=${buffer.length} bytes`);

        // 设置 mediaTempPath，让 OpenClaw 核心处理文件
        mediaTempPath = fileTempPath;
        mediaCleanupPaths.push(fileTempPath);

        // 对于文本类文件，同时提取内容作为上下文
        const textReadTypes = ['.txt', '.md', '.json', '.xml', '.csv', '.log', '.yaml', '.yml'];
        const isTextFile = textReadTypes.some(t => safeFileName.toLowerCase().endsWith(t));

        if (isTextFile) {
          try {
            const textContent = await readFile(fileTempPath, 'utf8');
            const preview = textContent.length > 3000 ? textContent.slice(0, 3000) + '\n\n...(内容已截断)' : textContent;
            messageText = `[用户发送了文件：${safeFileName}]\n\n${preview}`;
          } catch (_) {
            messageText = `[用户发送了文件：${safeFileName}]`;
          }
        } else {
          messageText = `[用户发送了文件：${safeFileName}，大小：${fileSize || buffer.length} 字节]`;
        }
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download file: ${downloadErr.message}`);
        messageText = `[用户发送了一个文件${fileName ? `：${fileName}` : ''}，但下载失败]\n\n请告诉用户文件处理暂时不可用。`;
      }
    }

    // 处理链接分享消息
    if (msgType === "link") {
      api.logger.info?.(`wecom: received link message title=${linkTitle}, url=${linkUrl}`);
      messageText = `[用户分享了一个链接]\n标题：${linkTitle || '(无标题)'}\n描述：${linkDescription || '(无描述)'}\n链接：${linkUrl || '(无链接)'}\n\n请根据链接内容回复用户。如需要，可以使用 WebFetch 工具获取链接内容。`;
    }

    if (!messageText) {
      api.logger.warn?.("wecom: empty message content");
      return;
    }

    // 日志：多模态媒体管线状态
    if (mediaTempPath) {
      api.logger.info?.(`wecom: media file ready for OpenClaw pipeline: ${mediaTempPath}`);
    }

    // route 已在函数入口通过 peer 信息获取（见上方 resolveAgentRoute 调用）
    // 使用之前已获取的 route 和 resolvedAgentId

    // 获取 storePath
    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: resolvedAgentId,
    });

    // 格式化消息体
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const chatType = isGroupChat ? "group" : "direct";
    const formattedBody = runtime.channel.reply.formatInboundEnvelope({
      channel: "WeCom",
      from: fromUser,
      timestamp: Date.now(),
      body: messageText,
      chatType,
      sender: { name: fromUser, id: fromUser },
      envelope: envelopeOptions,
    });

    // 拼接历史上下文（对标 Telegram/Mattermost 的 buildPendingHistoryContextFromMap）
    const body = buildPendingHistoryContextFromMap({
      historyMap: sessionHistories,
      historyKey: sessionId,
      limit: DEFAULT_HISTORY_LIMIT,
      currentMessage: formattedBody,
      formatEntry: (entry) => runtime.channel.reply.formatInboundEnvelope({
        channel: "WeCom",
        from: fromUser,
        timestamp: entry.timestamp,
        body: entry.body,
        chatType,
        senderLabel: entry.sender,
        envelope: envelopeOptions,
      }),
    });

    // 记录用户消息到会话历史（在 buildPendingHistoryContextFromMap 之后，
    // 避免当前消息同时出现在历史区和当前消息区）
    recordPendingHistoryEntry({
      historyMap: sessionHistories,
      historyKey: sessionId,
      entry: {
        sender: fromUser,
        body: messageText,
        timestamp: Date.now(),
        messageId: `wecom-${Date.now()}`,
      },
      limit: DEFAULT_HISTORY_LIMIT,
    });

    // 构建 Session 上下文对象
    const ctxPayload = {
      Body: body,
      RawBody: content || messageText || "",
      From: isGroupChat ? `wecom:group:${chatId}` : `wecom:${fromUser}`,
      To: `wecom:${fromUser}`,
      SessionKey: sessionId,
      AccountId: config.accountId || "default",
      ChatType: isGroupChat ? "group" : "direct",
      ConversationLabel: fromUser,
      SenderName: fromUser,
      SenderId: fromUser,
      Provider: "wecom",
      Surface: "wecom",
      MessageSid: `wecom-${Date.now()}`,
      Timestamp: Date.now(),
      OriginatingChannel: "wecom",
      OriginatingTo: `wecom:${fromUser}`,
      // 多模态媒体管线：将媒体文件路径传给 OpenClaw 核心
      // OpenClaw 核心会根据 tools.media.* 配置自动处理（图片/音频/视频）
      ...(mediaTempPath ? { MediaPath: mediaTempPath, MediaUrl: `file://${mediaTempPath}` } : {}),
    };

    // 注册会话到 Sessions UI
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: !isGroupChat ? { sessionKey: sessionId, channel: "wecom", to: fromUser, accountId: config.accountId || "default" } : undefined,
      onRecordError: (err) => {
        api.logger.warn?.(`wecom: failed to record session: ${err}`);
      },
    });

    api.logger.info?.(`wecom: session registered for ${sessionId}`);

    // 记录渠道活动
    runtime.channel.activity.record({ channel: "wecom", accountId: config.accountId || "default", direction: "inbound" });

    // 写入用户消息到 transcript 文件（使 Chat UI 可以显示历史）
    await writeToTranscript({
      sessionKey: sessionId,
      role: "user",
      text: messageText,
      logger: api.logger,
      agentId: resolvedAgentId,
    });

    // 广播用户消息到 Chat UI
    const inboundRunId = `wecom-inbound-${Date.now()}`;
    broadcastToChatUI({ sessionKey: sessionId, role: "user", text: messageText, runId: inboundRunId, state: "final" });

    api.logger.info?.(`wecom: dispatching message via agent runtime for session ${sessionId}`);

    // 使用 gateway 内部 agent runtime API 调用 AI
    // 对标 Telegram 的 dispatchReplyWithBufferedBlockDispatcher
    const chunkMode = runtime.channel.text.resolveChunkMode(cfg, "wecom", config.accountId || "default");
    const tableMode = runtime.channel.text.resolveMarkdownTableMode({ cfg, channel: "wecom", accountId: config.accountId || "default" });

    try {
      const outboundRunId = `wecom-outbound-${Date.now()}`;
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            // 发送回复到企业微信
            if (payload.text) {
              api.logger.info?.(`wecom: delivering ${info.kind} reply, length=${payload.text.length}`);

              // 应用 Markdown 转换
              const formattedReply = markdownToWecomText(payload.text);
              await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: formattedReply, logger: api.logger });

              api.logger.info?.(`wecom: sent AI reply to ${fromUser}: ${formattedReply.slice(0, 50)}...`);

              // 写入 AI 回复到 transcript 文件（使 Chat UI 可以显示历史）
              await writeToTranscript({
                sessionKey: sessionId,
                role: "assistant",
                text: payload.text,
                logger: api.logger,
                agentId: resolvedAgentId,
              });

              // 广播 AI 回复到 Chat UI
              broadcastToChatUI({ sessionKey: sessionId, role: "assistant", text: payload.text, runId: outboundRunId, state: info.kind === "final" ? "final" : "streaming" });

              // AI 回复完成后，清除历史缓冲（对标 Telegram clearHistoryEntriesIfEnabled）
              if (info.kind === "final") {
                clearHistoryEntriesIfEnabled({ historyMap: sessionHistories, historyKey: sessionId, limit: DEFAULT_HISTORY_LIMIT });
              }
            }
          },
          onError: (err, info) => {
            api.logger.error?.(`wecom: ${info.kind} reply failed: ${String(err)}`);
            // 失败时也清除历史缓冲，避免脏数据
            clearHistoryEntriesIfEnabled({ historyMap: sessionHistories, historyKey: sessionId, limit: DEFAULT_HISTORY_LIMIT });
          },
        },
        replyOptions: {
          // 禁用流式响应，因为企业微信不支持编辑消息
          disableBlockStreaming: true,
        },
      });
    } finally {
      // 清理临时媒体文件（dispatcher 已完成处理，文件可以安全删除）
      for (const cleanupPath of mediaCleanupPaths) {
        unlink(cleanupPath).catch(() => {});
      }
    }
  } catch (err) {
    api.logger.error?.(`wecom: failed to process message: ${err.message}`);
    api.logger.error?.(`wecom: stack trace: ${err.stack}`);

    // 发送错误提示给用户
    try {
      await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: `抱歉，处理您的消息时出现错误，请稍后重试。\n错误：${err.message?.slice(0, 100) || "未知错误"}`, logger: api.logger });
    } catch (sendErr) {
      api.logger.error?.(`wecom: failed to send error message: ${sendErr.message}`);
      api.logger.error?.(`wecom: send error stack: ${sendErr.stack}`);
      api.logger.error?.(`wecom: original error was: ${err.message}`);
    }
  }
}
