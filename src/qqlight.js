#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { spawn } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const WebSocket = require("ws");

const IMAGE_PLACEHOLDER = "{图片}";
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const INPUT_NEWLINE_PLACEHOLDER = "\u0000";
const SUBMITTED_LINE_BATCH_DELAY_MS = 50;
const UNMARKED_PASTE_IDLE_DELAY_MS = 100;
const HISTORY_LOAD_LIMIT = 20;
const HISTORY_DIR = path.resolve(__dirname, "..", ".qqlight", "history");
const IMAGE_DIR = path.resolve(__dirname, "..", ".qqlight", "images");
const IMAGE_FETCH_ATTEMPTS = 3;
// QQ 图片服务器走的是跨网/跨境链路，单次 8 秒经常不够用；超时太短会把
// 本可成功的下载变成失败，过短的重试间隔又会被服务端当作攻击。
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_FETCH_RETRY_DELAYS_MS = [500, 1500];
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const NAPCAT_IMAGE_RESOLVE_TIMEOUT_MS = 30000;
// 图片来源失败时按“能解释清楚原因”的优先级挑选最终提示：下载失败最能说明问题，
// NapCat 解析失败次之，本地文件读不到（ENOENT）最没有参考价值，不能让它盖掉真正的原因。
const IMAGE_ERROR_PRIORITY = { download: 3, napcat: 2, local: 1 };

const DEFAULT_CONFIG = {
  napcatWsUrl: "ws://127.0.0.1:3001",
  accessToken: "",
  privateIds: [],
  groupIds: [],
  maxHistory: 200,
};

const CONFIG_PATH = process.env.QQLIGHT_CONFIG
  ? path.resolve(process.env.QQLIGHT_CONFIG)
  : path.join(os.homedir(), ".config", "qqlight", "config.json");

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  brightBlue: "\x1b[94m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
};

function color(name, value) {
  if (!process.stdout.isTTY) return value;
  return `${colors[name] || ""}${value}${colors.reset}`;
}

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE_PATTERN, "");
}

function isWideTerminalCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff01 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

function terminalCellWidth(value) {
  return [...stripAnsi(value)].reduce((width, character) => {
    const codePoint = character.codePointAt(0);
    return width + (isWideTerminalCodePoint(codePoint) ? 2 : 1);
  }, 0);
}

function terminalRowCount(value, terminalWidth = process.stdout.columns) {
  const width = Math.max(1, Number(terminalWidth) || 80);
  return String(stripAnsi(value)).split("\n").reduce((rows, line) => (
    rows + Math.max(1, Math.ceil(Math.max(1, terminalCellWidth(line)) / width))
  ), 0);
}

function encodeInputNewlines(value) {
  return String(value || "").replace(/\r\n?|\n/g, INPUT_NEWLINE_PLACEHOLDER);
}

function decodeInputNewlines(value) {
  return String(value || "").replaceAll(INPUT_NEWLINE_PLACEHOLDER, "\n");
}

function alignMessageLine(line, direction, terminalWidth = process.stdout.columns) {
  if (direction !== "outgoing") return line;
  const width = Math.max(20, Number(terminalWidth) || 80);
  const contentWidth = terminalCellWidth(line);
  if (contentWidth >= width) return line;
  return `${" ".repeat(Math.max(0, width - contentWidth - 1))}${line}`;
}

function alignMessageBlock(block, direction, terminalWidth = process.stdout.columns) {
  const lines = String(block || "").split("\n");
  if (direction !== "outgoing") return lines.join("\n");

  const width = Math.max(20, Number(terminalWidth) || 80);
  const blockWidth = Math.max(...lines.map((line) => terminalCellWidth(line)), 1);
  const indent = Math.max(0, width - blockWidth - 1);
  return lines.map((line) => `${" ".repeat(indent)}${line}`).join("\n");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSafeImageError(message, { cause, retryable = false, kind = "" } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.safeForDisplay = true;
  error.retryable = retryable;
  error.kind = kind;
  return error;
}

function getSafeErrorCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const code = String(current.code || "").toUpperCase();
    if (/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    current = current.cause;
  }
  return "";
}

function formatImageError(error) {
  if (error?.safeForDisplay && error.message) return error.message;
  const code = getSafeErrorCode(error);
  return code ? `图片来源不可用（${code}）` : "图片来源不可用";
}

// 多个候选来源都失败时，挑选最能让用户判断问题所在的错误。
// 例如：URL 下载超时 + NapCat 主机上的本地文件读不到，应提示下载超时，
// 而不是提示“读取本地图片失败：ENOENT”。
function selectImageError(errors, fallbackMessage = "图片没有可用来源") {
  const candidates = (Array.isArray(errors) ? errors : []).filter(Boolean);
  if (!candidates.length) return createSafeImageError(fallbackMessage);
  return candidates
    .map((error, index) => ({ error, index }))
    .sort((left, right) => {
      const diff = (IMAGE_ERROR_PRIORITY[right.error.kind] || 0)
        - (IMAGE_ERROR_PRIORITY[left.error.kind] || 0);
      return diff !== 0 ? diff : right.index - left.index;
    })
    .map((item) => item.error)[0];
}

function isDirectImageValue(value) {
  const source = String(value || "");
  return /^(?:base64|data|https?|file):/i.test(source) || path.isAbsolute(source);
}

function readProxyConfig() {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || "";
  if (!value) return null;
  try {
    const proxy = new URL(value);
    // 只支持 HTTP(S) 代理的 CONNECT 隧道；socks 代理保持直连，避免静默失败。
    if (!["http:", "https:"].includes(proxy.protocol)) return null;
    return proxy;
  } catch {
    return null;
  }
}

function isProxyBypassed(hostname) {
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!noProxy.length) return false;
  if (noProxy.includes("*")) return true;
  const host = String(hostname || "").toLowerCase();
  return noProxy.some((entry) => {
    const rule = entry.replace(/^\./, "");
    return host === rule || host.endsWith(`.${rule}`);
  });
}

// Node 的 fetch 默认不读取 HTTP(S)_PROXY，导致配好代理时图片仍然直连失败。
// 这里按环境变量为图片下载补一条 CONNECT 隧道。
function resolveImageProxy(targetUrl) {
  if (!/^https:\/\//i.test(String(targetUrl || ""))) return null;
  const proxy = readProxyConfig();
  if (!proxy) return null;
  try {
    const target = new URL(targetUrl);
    if (isProxyBypassed(target.hostname)) return null;
  } catch {
    return null;
  }
  return proxy;
}

function openProxyTunnel(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
    const socket = net.connect({ host: proxy.hostname, port: proxyPort });
    let settled = false;
    const finish = (error, tunnel) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(tunnel);
      }
    };
    const timer = setTimeout(() => {
      finish(createSafeImageError("代理隧道连接超时", { retryable: true, kind: "download" }));
    }, timeoutMs);
    const onError = (error) => finish(error);
    socket.on("error", onError);
    socket.on("connect", () => {
      const authorization = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authorization}\r\n`,
      );
    });

    let received = Buffer.alloc(0);
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (received.length > 16 * 1024) finish(new Error("代理响应异常"));
        return;
      }
      const statusLine = received.subarray(0, headerEnd).toString("latin1").split("\r\n")[0] || "";
      const status = Number(statusLine.split(/\s+/)[1]);
      if (status !== 200) {
        finish(createSafeImageError(`代理隧道建立失败：HTTP ${Number.isFinite(status) ? status : "未知"}`, { kind: "download" }));
        return;
      }
      const rest = received.subarray(headerEnd + 4);
      if (rest.length) socket.unshift(rest);
      finish(null, socket);
    };
    socket.on("data", onData);
  });
}

class ImageProxyAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const targetHost = options.servername || options.host;
    const targetPort = Number(options.port) || 443;
    openProxyTunnel(this.proxy, targetHost, targetPort, IMAGE_FETCH_TIMEOUT_MS)
      .then((socket) => {
        callback(null, tls.connect({ socket, servername: targetHost }));
      })
      .catch((error) => callback(error));
    return undefined;
  }
}

function requestImageViaProxy(targetUrl, signal, proxy) {
  return new Promise((resolve, reject) => {
    const request = https.request(targetUrl, { agent: new ImageProxyAgent(proxy), signal }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          status: response.statusCode,
          headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
          body: { cancel: async () => response.destroy() },
          arrayBuffer: async () => buffer,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function normalizeIds(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter((item) => /^\d+$/.test(item)))];
}

function mergeIds(existing, additions) {
  return normalizeIds([...normalizeIds(existing), ...normalizeIds(additions)]);
}

function parseGroupMention(value) {
  const source = String(value || "").trim();
  const bracketMatch = source.match(/^\[([^\]\r\n]+)\]([\s\S]*)$/);
  const atMatch = source.match(/^@(\d+)(?:\s+([\s\S]*))?$/);
  if (!bracketMatch && !atMatch) return null;
  const target = String(bracketMatch ? bracketMatch[1] : atMatch[1]).trim();
  if (!target) return null;
  const text = String(bracketMatch ? bracketMatch[2] : atMatch[2] || "").trim();
  return {
    target,
    userId: /^\d+$/.test(target) ? target : "",
    text,
    displayText: `@${target}${text ? ` ${text}` : ""}`,
  };
}

function createAtMessageContent(userId, content) {
  const atSegment = { type: "at", data: { qq: String(userId) } };
  if (Array.isArray(content)) return [atSegment, ...content];
  if (String(content || "").trim()) {
    return [atSegment, { type: "text", data: { text: String(content) } }];
  }
  return [atSegment];
}

function normalizeMentionName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getGroupMemberNameCandidates(member) {
  return [member && member.card, member && member.nickname, member && member.remark, member && member.title]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function getGroupMemberDisplayName(member) {
  const names = getGroupMemberNameCandidates(member);
  if (!names.length) return "（未设置昵称）";
  if (names.length === 1) return names[0];
  return `${names[0]}（昵称：${names[1]}）`;
}

function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(color("yellow", `配置文件读取失败，将使用默认配置：${error.message}`));
    }
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...(stored && typeof stored === "object" ? stored : {}),
  };

  if (process.env.NAPCAT_WS_URL) config.napcatWsUrl = process.env.NAPCAT_WS_URL;
  if (process.env.NAPCAT_ACCESS_TOKEN) config.accessToken = process.env.NAPCAT_ACCESS_TOKEN;
  if (process.env.QQLIGHT_PRIVATE_IDS) config.privateIds = process.env.QQLIGHT_PRIVATE_IDS.split(/[\s,，]+/);
  if (process.env.QQLIGHT_GROUP_IDS) config.groupIds = process.env.QQLIGHT_GROUP_IDS.split(/[\s,，]+/);

  config.napcatWsUrl = String(config.napcatWsUrl || DEFAULT_CONFIG.napcatWsUrl);
  config.accessToken = String(config.accessToken || "");
  config.privateIds = normalizeIds(config.privateIds);
  config.groupIds = normalizeIds(config.groupIds);
  config.maxHistory = Math.max(20, Math.min(2000, Number(config.maxHistory) || DEFAULT_CONFIG.maxHistory));
  return config;
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify({
      napcatWsUrl: config.napcatWsUrl,
      accessToken: config.accessToken,
      privateIds: config.privateIds,
      groupIds: config.groupIds,
      maxHistory: config.maxHistory,
    }, null, 2)}\n`,
    "utf8",
  );
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function runCommand(command, args, { allowEmpty = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      const output = Buffer.concat(stdout);
      if (code === 0 && (output.length || allowEmpty)) {
        resolve(output);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(detail || `${command} 未返回剪贴板内容`));
    });
  });
}

async function readClipboard(commands) {
  let lastError;
  for (const [command, args] of commands) {
    try {
      return await runCommand(command, args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未找到可用的剪贴板工具");
}

function getClipboardTextCommands() {
  const commands = [];
  if (process.platform === "darwin") commands.push(["pbpaste", []]);
  commands.push(
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  );
  return commands;
}

async function readClipboardText() {
  const output = await readClipboard(getClipboardTextCommands());
  return output.toString("utf8").replace(/\r\n/g, "\n").trim();
}

async function readClipboardImageMacOS() {
  let tempDir;
  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qqlight-clipboard-"));
    const imagePath = path.join(tempDir, "image.png");
    await fs.promises.writeFile(imagePath, Buffer.alloc(0), { mode: 0o600 });

    const script = [
      "on run argv",
      "  set outputPath to item 1 of argv",
      "  set outputFile to POSIX file outputPath",
      "  set outputRef to missing value",
      "  try",
      "    set imageData to the clipboard as «class PNGf»",
      "    set outputRef to open for access outputFile with write permission",
      "    set eof outputRef to 0",
      "    write imageData to outputRef",
      "    close access outputRef",
      "  on error errorMessage number errorNumber",
      "    if outputRef is not missing value then",
      "      try",
      "        close access outputRef",
      "      end try",
      "    end if",
      "    error errorMessage number errorNumber",
      "  end try",
      "end run",
    ].join("\n");

    await runCommand("osascript", ["-e", script, imagePath], { allowEmpty: true });
    const output = await fs.promises.readFile(imagePath);
    if (!output.length) throw new Error("macOS 剪贴板中没有可读取的图片");
    return { output, extension: "png" };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readClipboardImage() {
  const imageTypes = [
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ];
  if (process.platform === "darwin") return readClipboardImageMacOS();

  let lastError;
  for (const [mime, extension] of imageTypes) {
    try {
      const output = await readClipboard([
        ["wl-paste", ["--type", mime]],
        ["xclip", ["-selection", "clipboard", "-t", mime, "-o"]],
      ]);
      return { output, extension };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("剪贴板中没有图片");
}

const MESSAGE_SEGMENT_LABELS = {
  image: "{图片}",
  record: "[语音]",
  video: "[视频]",
  face: "[表情]",
  file: "[文件]",
  reply: "[回复]",
  at: "@某人",
  json: "[JSON]",
  xml: "[XML]",
};

function decodeMessageEntities(value) {
  return String(value || "")
    .replace(/&#44;/gi, ",")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
}

function parseJsonValue(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current && typeof current === "object") return current;
    if (typeof current !== "string") return null;
    const source = decodeMessageEntities(current).trim();
    if (!source) return null;
    try {
      current = JSON.parse(source);
    } catch {
      return null;
    }
  }
  return current && typeof current === "object" ? current : null;
}

function normalizeCardText(value) {
  return decodeMessageEntities(value)
    .replace(/\\\//g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function isBilibiliLabel(value) {
  return /哔哩哔哩|bilibili/i.test(String(value || ""));
}

function isGenericBilibiliLabel(value) {
  return /^(?:哔哩哔哩|bilibili)$/i.test(String(value || "").trim());
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function formatBilibiliJsonSegment(data) {
  const payloadSource = data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "data")
    ? data.data
    : data;
  const payload = parseJsonValue(payloadSource);
  if (!payload) return null;

  const meta = parseJsonValue(payload.meta) || {};
  const detailCandidates = [
    parseJsonValue(meta.detail_1),
    parseJsonValue(meta.detail1),
    parseJsonValue(payload.detail_1),
    payload,
  ].filter((candidate) => candidate && typeof candidate === "object");
  const detail = detailCandidates.find((candidate) => (
    candidate.qqdocurl || candidate.jumpUrl || candidate.url || candidate.desc || candidate.title
  )) || {};

  const urlCandidates = [];
  [detail, ...detailCandidates, payload].forEach((candidate) => {
    ["qqdocurl", "jumpUrl", "targetUrl", "shareUrl", "link", "url"].forEach((key) => {
      const value = normalizeCardText(candidate[key]);
      if (isHttpUrl(value)) urlCandidates.push(value);
    });
  });
  const url = urlCandidates.find((candidate) => /(?:b23\.tv|bilibili\.com|bili\.com)/i.test(candidate))
    || urlCandidates.find((candidate) => isHttpUrl(candidate))
    || "";

  const cardIdentity = [
    payload.app,
    payload.desc,
    payload.prompt,
    detail.title,
    detail.qqdocurl,
    detail.jumpUrl,
    detail.url,
  ].map(normalizeCardText).join(" ");
  if (!isBilibiliLabel(cardIdentity) && !/(?:b23\.tv|bilibili\.com|bili\.com)/i.test(cardIdentity)) {
    return null;
  }

  const title = [
    detail.desc,
    detail.video_title,
    detail.videoTitle,
    detail.name,
    detail.title,
    payload.title,
    payload.prompt,
  ].map(normalizeCardText)
    .map((candidate) => candidate.replace(/^\[(?:QQ小程序|分享)\]\s*/i, "").trim())
    .find((candidate) => candidate && !isGenericBilibiliLabel(candidate))
    || "未命名视频";

  return `[B站视频] ${title} | ${url || "链接不可用"}`;
}

function parseCqParameters(value) {
  const parameters = {};
  String(value || "").split(",").forEach((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return;
    const key = part.slice(0, separator).trim();
    if (!key) return;
    parameters[key] = decodeMessageEntities(part.slice(separator + 1).trim());
  });
  return parameters;
}

function extractMessageText(message) {
  if (typeof message === "string") {
    return message.replace(/\[CQ:([^,\]]+)(?:,([^\]]*))?\]/g, (_all, type, rawParameters) => {
      if (type === "json") {
        return formatBilibiliJsonSegment(parseCqParameters(rawParameters).data) || MESSAGE_SEGMENT_LABELS.json;
      }
      return MESSAGE_SEGMENT_LABELS[type] || `[${type}]`;
    }).trim();
  }

  if (!Array.isArray(message)) return "";
  return message.map((segment) => {
    if (!segment || typeof segment !== "object") return "";
    const type = segment.type;
    const data = segment.data || {};
    if (type === "text") return String(data.text || "");
    if (type === "at") return `@${data.name || data.qq || "某人"}`;
    if (type === "json") return formatBilibiliJsonSegment(data) || MESSAGE_SEGMENT_LABELS.json;
    return MESSAGE_SEGMENT_LABELS[type] || (type ? `[${type}]` : "");
  }).join("").trim();
}

function extractImageSources(message) {
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment && segment.type === "image")
      .map((segment) => {
        const data = segment.data && typeof segment.data === "object" ? segment.data : {};
        return {
          file: String(data.file || ""),
          url: String(data.url || ""),
          type: String(data.type || ""),
        };
      })
      .filter((source) => source.file || source.url);
  }

  if (typeof message !== "string") return [];
  const sources = [];
  const pattern = /\[CQ:image,([^\]]*)\]/g;
  let match;
  while ((match = pattern.exec(message))) {
    const source = {};
    match[1].split(",").forEach((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (["file", "url", "type"].includes(key)) source[key] = value;
    });
    if (source.file || source.url) sources.push({
      file: String(source.file || ""),
      url: String(source.url || ""),
      type: String(source.type || ""),
    });
  }
  return sources;
}

function formatTime(value) {
  const date = new Date(value || Date.now());
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function normalizeChatName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function createMessageEvent(payload) {
  if (!payload || !["message", "message_sent"].includes(payload.post_type)) return null;
  if (!["private", "group"].includes(payload.message_type)) return null;

  const chatType = payload.message_type;
  const targetId = chatType === "private" ? String(payload.user_id || "") : String(payload.group_id || "");
  if (!/^\d+$/.test(targetId)) return null;

  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};
  const senderId = String(sender.user_id || payload.user_id || "");
  const messageContent = payload.message ?? payload.raw_message ?? "";
  const text = extractMessageText(messageContent);
  if (!text) return null;

  return {
    id: String(payload.message_id || `${Date.now()}-${Math.random()}`),
    time: Date.now(),
    direction: payload.post_type === "message_sent" ? "outgoing" : "incoming",
    chatType,
    targetId,
    chatName: chatType === "group" ? normalizeChatName(payload.group_name) : "",
    senderId,
    senderName: String(sender.card || sender.nickname || ""),
    text,
    rawMessage: typeof payload.raw_message === "string" ? payload.raw_message : safeJson(payload.message),
    imageSources: extractImageSources(messageContent),
  };
}

function messageKey(message) {
  return `${message.chatType}:${message.targetId}:${message.id}`;
}

function messageMatchesChat(message, chat) {
  return !chat || (message.chatType === chat.chatType && message.targetId === chat.targetId);
}

class NapCatConnection {
  constructor(config, { onStatus, onMessage, onLog }) {
    this.config = config;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onLog = onLog;
    this.socket = null;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.stopped = false;
    this.state = "disconnected";
  }

  get connected() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      wsUrl: this.config.napcatWsUrl,
      privateIds: this.config.privateIds,
      groupIds: this.config.groupIds,
    };
  }

  setState(state, detail = "") {
    this.state = state;
    this.onStatus(this.status(), detail);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || ["connecting", "open"].includes(this.state)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let url;
    try {
      url = new URL(this.config.napcatWsUrl);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error("必须使用 ws:// 或 wss:// 地址");
    } catch (error) {
      this.setState("error", `WebSocket 地址无效：${error.message}`);
      return;
    }

    const options = {};
    if (this.config.accessToken) {
      options.headers = {
        Authorization: `Bearer ${this.config.accessToken}`,
        "X-Access-Token": this.config.accessToken,
      };
    }

    this.setState("connecting", `正在连接 NapCat：${this.config.napcatWsUrl}`);
    const socket = new WebSocket(url.toString(), [], options);
    this.socket = socket;

    socket.on("open", () => {
      if (socket !== this.socket) return;
      this.reconnectDelay = 1000;
      this.setState("open", "NapCat WebSocket 已连接");
      this.onLog("已连接 NapCat OneBot 11 WebSocket");
    });

    socket.on("message", (raw) => this.handlePacket(raw));
    socket.on("error", (error) => {
      if (socket === this.socket) this.onLog(`WebSocket 错误：${error.message}`);
    });
    socket.on("close", (code, reason) => {
      if (socket !== this.socket) return;
      this.socket = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("NapCat WebSocket 已断开"));
      }
      this.pending.clear();
      this.setState("disconnected", `连接断开（${code}${reason ? `，${reason}` : ""}）`);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.onLog(`${Math.ceil(delay / 1000)} 秒后自动重连`);
  }

  reconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    this.state = "disconnected";
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("QQlight 已退出"));
    }
    this.pending.clear();
    this.state = "disconnected";
  }

  isAllowed(message) {
    const ids = message.chatType === "private" ? this.config.privateIds : this.config.groupIds;
    return ids.includes(message.targetId);
  }

  handlePacket(raw) {
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      this.onLog("收到无法解析的 NapCat 数据包");
      return;
    }

    if (packet.echo && this.pending.has(String(packet.echo))) {
      const pending = this.pending.get(String(packet.echo));
      this.pending.delete(String(packet.echo));
      clearTimeout(pending.timer);
      if (packet.status === "ok" && Number(packet.retcode) === 0) {
        pending.resolve(packet);
      } else {
        pending.reject(new Error(packet.wording || `NapCat 返回 retcode=${packet.retcode}`));
      }
      return;
    }

    const message = createMessageEvent(packet);
    if (message && this.isAllowed(message)) this.onMessage(message);
  }

  send(action, params, { timeoutMs = 15000 } = {}) {
    if (!this.connected) return Promise.reject(new Error("NapCat 尚未连接"));
    const echo = crypto.randomUUID();
    const packet = JSON.stringify({ action, params, echo });
    const responseTimeoutMs = Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`等待 NapCat 响应超时：${action}`));
      }, responseTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(packet, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      });
    });
  }
}

class QQlightApp {
  constructor() {
    this.config = loadConfig();
    this.historyByChat = new Map();
    this.groupMembersById = new Map();
    this.activeChat = null;
    this.chatRevision = 0;
    this.exiting = false;
    this.runningCommand = false;
    this.commandQueue = Promise.resolve();
    this.lastPasteTime = 0;
    this.pendingImages = [];
    this.pasteSession = null;
    this.pasteSessionFinishTimer = null;
    this.bracketedPasteEnabled = false;
    this.submittedLineBatch = [];
    this.submittedLineFlushTimer = null;
    this.keypressHandler = null;
    this.inputDataHandler = null;
    this.sigintHandler = null;
    this.projectDir = path.resolve(__dirname, "..");
    this.historyDir = HISTORY_DIR;
    this.imageDir = IMAGE_DIR;
    this.lastImagePath = null;
    this.historyWriteQueues = new Map();
    this.persistedMessageKeys = new Map();
    this.messageQueue = Promise.resolve();
    this.imageSaveQueue = Promise.resolve();
    this.imageDownloadHintShown = false;
    this.fetchImpl = globalThis.fetch;
    this.waitImpl = wait;
    this.rl = null;
    this.connection = new NapCatConnection(this.config, {
      onStatus: (status, detail) => {
        if (detail) this.writeLine(color(status.state === "open" ? "green" : "yellow", `[状态] ${detail}`));
      },
      onMessage: (message) => {
        this.messageQueue = this.messageQueue
          .then(() => this.receiveMessage(message))
          .catch((error) => this.writeLine(color("red", `[错误] 消息处理失败：${error.message}`)));
      },
      onLog: (message) => this.writeLine(color("dim", `[NapCat] ${message}`)),
    });
  }

  start() {
    this.printBanner();
    this.inputDataHandler = (chunk) => this.observeInputData(chunk);
    process.stdin.on("data", this.inputDataHandler);
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      prompt: this.getPrompt(),
      completer: (line) => this.completeInput(line),
    });
    readline.emitKeypressEvents(process.stdin, this.rl);
    this.keypressHandler = (_sequence, key) => {
      if (key?.name === "paste-start" || key?.sequence === BRACKETED_PASTE_START) {
        this.beginPasteSession("bracketed");
        return;
      }
      if (key?.name === "paste-end" || key?.sequence === BRACKETED_PASTE_END) {
        this.finishPasteSession();
        return;
      }
      if (!key || !key.ctrl) return;
      if (key.name === "c" && !key.shift) {
        this.clearCurrentInput();
        return;
      }
      if (key.name === "d") {
        this.exit();
        return;
      }
      if (key.name !== "v") return;
      if (key.shift) this.handleTextPaste();
      else this.handleImagePaste();
    };
    process.stdin.on("keypress", this.keypressHandler);
    this.rl.on("line", (line) => {
      if (this.pasteSession) {
        this.pasteSession.lines.push(String(line));
        return;
      }
      this.queueSubmittedLine(line);
    });
    this.rl.on("close", () => {
      if (!this.exiting) this.exit();
    });
    this.rl.on("SIGINT", () => this.clearCurrentInput());
    this.sigintHandler = () => this.clearCurrentInput();
    process.on("SIGINT", this.sigintHandler);
    this.setBracketedPaste(true);
    this.rl.prompt();
    this.connection.start();
  }

  printBanner() {
    console.log(color("cyan", "QQlight 0.1.0 — NapCat 终端客户端"));
    console.log(color("dim", `配置文件：${CONFIG_PATH}`));
    console.log(color("dim", "输入 help 查看命令；只有白名单中的私聊和群聊消息会被接收。"));
    console.log(color("yellow", "提示：按 Ctrl+D 退出程序"));
  }

  writeLine(message) {
    if (!this.rl || !process.stdout.isTTY) {
      console.log(message);
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${message}\n`);
    if (!this.runningCommand && !this.exiting) this.rl.prompt(true);
  }

  clearSubmittedInput(line) {
    if (!this.rl || !process.stdout.isTTY) return;

    const terminalWidth = Math.max(1, Number(process.stdout.columns) || 80);
    const prompt = typeof this.rl.getPrompt === "function" ? this.rl.getPrompt() : "> ";
    const rowCount = terminalRowCount(`${prompt}${String(line || "")}`, terminalWidth);

    // readline 已经在提交时换到了下一行，回到输入行清除后再回到当前行，
    // 这样输入内容不会作为“反馈消息”残留在聊天记录中。
    process.stdout.write(`\x1b[${rowCount}A\r`);
    for (let row = 0; row < rowCount; row += 1) {
      process.stdout.write("\x1b[2K");
      if (row < rowCount - 1) process.stdout.write("\x1b[1B\r");
    }
    if (rowCount > 1) process.stdout.write(`\x1b[${rowCount - 1}A\r`);
  }

  async receiveMessage(message) {
    if (this.getHistoryMessage(message) || this.isRecentOutgoingImageDuplicate(message)) return;
    const needsImageSave = Boolean(message.imageSources?.length);
    // 图片要从 QQ 图片服务器下载，慢的时候一条消息可能卡住几十秒。
    // 先把消息显示出来，图片在后台保存，避免整个聊天界面被一张图片拖住。
    const historyMessage = needsImageSave ? { ...message, imagePaths: [] } : message;
    if (!this.addToHistory(historyMessage)) return;
    this.persistMessage(historyMessage).catch((error) => {
      this.writeLine(color("red", `[错误] 聊天记录保存失败：${error.message}`));
    });
    if (this.activeChat?.chatType === "private"
      && historyMessage.chatType === "private"
      && historyMessage.targetId === this.activeChat.targetId
      && historyMessage.senderName) {
      this.activeChat.displayName = historyMessage.senderName;
      this.updatePrompt();
    }
    if (this.activeChat?.chatType === "group"
      && historyMessage.chatType === "group"
      && historyMessage.targetId === this.activeChat.targetId
      && historyMessage.chatName) {
      this.activeChat.displayName = historyMessage.chatName;
      this.updatePrompt();
    }
    if (messageMatchesChat(historyMessage, this.activeChat)) {
      this.writeLine(this.renderMessage(historyMessage));
    }
    if (needsImageSave) this.scheduleImageSave(historyMessage);
  }

  // 图片保存在独立队列里执行：即使一张图片失败或超时，也不会阻塞后续消息。
  scheduleImageSave(message) {
    this.imageSaveQueue = this.imageSaveQueue
      .then(() => this.saveMessageImages(message))
      .then((stored) => this.applySavedImages(message, stored))
      .catch((error) => {
        this.writeLine(color("red", `[错误] 图片保存失败：${formatImageError(error)}`));
        if (error?.kind === "download") this.printImageDownloadHint();
      });
    return this.imageSaveQueue;
  }

  async applySavedImages(message, stored) {
    const imagePaths = Array.isArray(stored?.imagePaths) ? stored.imagePaths : [];
    if (!imagePaths.length) return;
    message.imagePaths = imagePaths;
    await this.persistMessageImages(message);
  }

  async persistMessageImages(message) {
    const chatKey = this.getChatHistoryKey(message.chatType, message.targetId);
    await (this.historyWriteQueues.get(chatKey) || Promise.resolve()).catch(() => {});
    const persistedKeys = this.persistedMessageKeys.get(chatKey);
    // 先补存图片路径，再写一遍同一条记录；读取时按 id 合并，后写入的 imagePaths 生效。
    if (persistedKeys) persistedKeys.delete(messageKey(message));
    await this.persistMessage(message);
  }

  getImageExtension(value, mime = "") {
    const mimeExtensions = {
      "image/avif": ".avif",
      "image/bmp": ".bmp",
      "image/gif": ".gif",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    };
    const mimeType = String(mime).split(";", 1)[0].trim().toLowerCase();
    if (mimeExtensions[mimeType]) return mimeExtensions[mimeType];

    let pathname = String(value || "");
    try {
      if (/^[a-z][a-z\d+.-]*:/i.test(pathname)) pathname = new URL(pathname).pathname;
    } catch {
      // 路径格式异常时继续使用原始字符串推断扩展名。
    }
    const extension = path.extname(pathname).toLowerCase();
    if ([".avif", ".bmp", ".gif", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
      return extension === ".jpeg" ? ".jpg" : extension;
    }
    return ".png";
  }

  async requestImage(source, signal) {
    const fetchImpl = this.fetchImpl || globalThis.fetch;
    // 测试或调用方显式替换 fetchImpl 时保持原样，只有真实网络请求才走代理隧道。
    if (fetchImpl === globalThis.fetch && !this.imageProxyDisabled) {
      const proxy = resolveImageProxy(source);
      if (proxy) {
        try {
          return await requestImageViaProxy(source, signal, proxy);
        } catch (error) {
          const code = getSafeErrorCode(error);
          if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
            // 代理没开（环境变量残留）时退回直连，不要因此判定图片保存失败。
            this.imageProxyDisabled = true;
          } else {
            throw error;
          }
        }
      }
    }
    return fetchImpl(source, { signal });
  }

  async fetchImageValue(source, mime = "") {
    const waitImpl = this.waitImpl || wait;
    let lastError;

    for (let attempt = 0; attempt < IMAGE_FETCH_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        const response = await this.requestImage(source, controller.signal);
        if (!response.ok) {
          const retryable = response.status === 408
            || response.status === 429
            || response.status >= 500;
          await response.body?.cancel?.().catch(() => {});
          throw createSafeImageError(`下载图片失败：HTTP ${response.status}`, { retryable, kind: "download" });
        }

        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > IMAGE_MAX_BYTES) {
          await response.body?.cancel?.().catch(() => {});
          throw createSafeImageError("下载图片失败：图片超过 25 MiB 限制", { kind: "download" });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) {
          throw createSafeImageError("下载图片失败：图片内容为空", { retryable: true, kind: "download" });
        }
        if (buffer.length > IMAGE_MAX_BYTES) {
          throw createSafeImageError("下载图片失败：图片超过 25 MiB 限制", { kind: "download" });
        }
        return {
          buffer,
          extension: this.getImageExtension(
            source,
            response.headers.get("content-type") || mime,
          ),
        };
      } catch (error) {
        if (error?.safeForDisplay) {
          lastError = error.kind ? error : createSafeImageError(error.message, {
            cause: error,
            retryable: error.retryable,
            kind: "download",
          });
        } else if (error?.name === "AbortError") {
          lastError = createSafeImageError("下载图片超时", { cause: error, retryable: true, kind: "download" });
        } else {
          const code = getSafeErrorCode(error);
          lastError = createSafeImageError(
            `下载图片失败：${code || "网络错误"}`,
            { cause: error, retryable: true, kind: "download" },
          );
        }
      } finally {
        clearTimeout(timer);
      }

      if (!lastError.retryable || attempt >= IMAGE_FETCH_ATTEMPTS - 1) break;
      const delay = IMAGE_FETCH_RETRY_DELAYS_MS[attempt] || 0;
      if (delay) await waitImpl(delay);
    }

    if (lastError?.retryable) {
      throw createSafeImageError(
        `${lastError.message}（已尝试 ${IMAGE_FETCH_ATTEMPTS} 次）`,
        { cause: lastError, kind: "download" },
      );
    }
    throw lastError || createSafeImageError("下载图片失败", { kind: "download" });
  }

  async readImageValue(value, mime = "") {
    const source = String(value || "");
    if (!source) throw createSafeImageError("图片来源为空");

    if (source.startsWith("base64://")) {
      const buffer = Buffer.from(source.slice("base64://".length), "base64");
      if (!buffer.length) throw createSafeImageError("Base64 图片内容为空");
      return { buffer, extension: this.getImageExtension(source, mime) };
    }

    if (source.startsWith("data:")) {
      const match = source.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
      if (!match) throw createSafeImageError("无法解析图片数据 URI");
      let buffer;
      try {
        buffer = match[2]
          ? Buffer.from(match[3], "base64")
          : Buffer.from(decodeURIComponent(match[3]), "utf8");
      } catch (error) {
        throw createSafeImageError("无法解析图片数据 URI", { cause: error });
      }
      if (!buffer.length) throw createSafeImageError("图片数据为空");
      return { buffer, extension: this.getImageExtension(source, match[1]) };
    }

    if (/^https?:\/\//i.test(source)) {
      return this.fetchImageValue(source, mime);
    }

    let imagePath;
    try {
      imagePath = /^file:\/\//i.test(source) ? fileURLToPath(source) : source;
      const buffer = await fs.promises.readFile(imagePath);
      if (!buffer.length) throw createSafeImageError("本地图片为空", { kind: "local" });
      if (buffer.length > IMAGE_MAX_BYTES) {
        throw createSafeImageError("读取图片失败：图片超过 25 MiB 限制", { kind: "local" });
      }
      return { buffer, extension: this.getImageExtension(imagePath, mime) };
    } catch (error) {
      if (error?.safeForDisplay) throw error;
      const code = getSafeErrorCode(error);
      throw createSafeImageError(
        code === "ENOENT"
          ? "读取本地图片失败：文件不存在或本机无法访问该路径"
          : `读取本地图片失败${code ? `：${code}` : ""}`,
        { cause: error, kind: "local" },
      );
    }
  }

  async readImageSource(source) {
    const errors = [];
    const triedValues = new Set();
    const readCandidate = async (value, mime = source.type, filename = "", viaNapcat = false) => {
      const normalizedValue = String(value || "");
      if (!normalizedValue || triedValues.has(normalizedValue)) return null;
      triedValues.add(normalizedValue);
      try {
        const result = await this.readImageValue(normalizedValue, mime);
        if (filename && /^(?:base64|data):/i.test(normalizedValue)) {
          result.extension = this.getImageExtension(filename, mime);
        }
        return result;
      } catch (error) {
        // NapCat 返回的 file 字段是 NapCat 主机上的绝对路径。NapCat 和本项目
        // 不在同一台机器（例如 NapCat 跑在容器里）时，这个路径在本机不存在，
        // 单独记成 napcat 错误，避免它盖掉真正的下载失败原因。
        if (viaNapcat && error?.kind === "local") {
          errors.push(createSafeImageError(
            `NapCat 主机上的图片文件本机无法读取${getSafeErrorCode(error) ? `（${getSafeErrorCode(error)}）` : ""}`,
            { cause: error, kind: "napcat" },
          ));
        } else {
          errors.push(error);
        }
        return null;
      }
    };

    for (const value of [source.url, source.file]) {
      if (!isDirectImageValue(value)) continue;
      const result = await readCandidate(value);
      if (result) return result;
    }

    const napcatReference = String(source.file || source.url || "");
    if (napcatReference && !/^(?:base64|data):/i.test(napcatReference)) {
      // NapCat 的 get_image 既能接受文件名，也能接受它自己主机上的绝对路径；
      // 路径来自别的容器前缀时按文件名再解析一次。
      const references = [napcatReference];
      const basename = path.basename(napcatReference);
      if (basename && basename !== napcatReference) references.push(basename);
      for (const reference of references) {
        try {
          const response = await this.connection.send(
            "get_image",
            { file: reference },
            { timeoutMs: NAPCAT_IMAGE_RESOLVE_TIMEOUT_MS },
          );
          const data = response?.data && typeof response.data === "object" ? response.data : {};
          const base64 = String(data.base64 || "");
          // get_image 完成后，同一个 URL 可能才真正可用，因此允许重新下载一次。
          triedValues.clear();
          const resolvedValues = [
            base64 && (/^(?:base64|data):/i.test(base64) ? base64 : `base64://${base64}`),
            String(data.url || ""),
            String(data.file || ""),
          ];
          let resolvedAny = false;
          for (const value of resolvedValues) {
            if (!isDirectImageValue(value)) continue;
            resolvedAny = true;
            const result = await readCandidate(value, source.type, String(data.file_name || ""), true);
            if (result) return result;
          }
          if (resolvedAny) break;
        } catch (error) {
          const timedOut = /响应超时/.test(String(error?.message || ""));
          const code = getSafeErrorCode(error);
          errors.push(createSafeImageError(
            timedOut
              ? "NapCat 图片解析超时"
              : `NapCat 图片解析失败${code ? `（${code}）` : ""}`,
            { cause: error, kind: "napcat" },
          ));
        }
      }
    }

    throw selectImageError(errors);
  }

  async saveMessageImages(message) {
    if (!message.imageSources?.length) return message;

    const directionLabel = message.direction === "outgoing" ? "发送" : "接收";
    const directionPrefix = message.direction === "outgoing" ? "outgoing" : "incoming";

    try {
      await fs.promises.mkdir(this.imageDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.writeLine(color("red", `[错误] 图片目录创建失败：${error.message}`));
      return { ...message, imagePaths: [] };
    }
    const imagePaths = [];
    for (const source of message.imageSources) {
      try {
        const { buffer, extension } = await this.readImageSource(source);
        const imagePath = path.join(
          this.imageDir,
          `${directionPrefix}-${Date.now()}-${crypto.randomUUID()}${extension}`,
        );
        await fs.promises.writeFile(imagePath, buffer, { mode: 0o600 });
        await fs.promises.chmod(imagePath, 0o600);
        imagePaths.push(imagePath);
        this.lastImagePath = imagePath;
      } catch (error) {
        this.writeLine(color("red", `[错误] ${directionLabel}图片保存失败：${formatImageError(error)}`));
        if (error?.kind === "download") this.printImageDownloadHint();
      }
    }
    return { ...message, imagePaths };
  }

  printImageDownloadHint() {
    if (this.imageDownloadHintShown) return;
    this.imageDownloadHintShown = true;
    this.writeLine(color("dim", "[提示] 图片需要从 QQ 图片服务器下载。若本机直连不稳定，可先设置 HTTPS_PROXY（例如 http://127.0.0.1:7890）再重启 QQlight；跨机器部署时还要确认 NapCat 能访问下载链接。"));
  }

  renderChatHeader(chat = this.activeChat) {
    if (!chat) return;
    const isGroup = chat.chatType === "group";
    const kind = isGroup ? "群聊" : "私聊";
    const name = chat.displayName || (isGroup ? "未命名群聊" : "对方");
    const target = `${kind} · ${name}`;
    const detail = `${chat.targetId}  ·  ${this.connection?.connected ? "在线" : "等待连接"}`;
    this.writeLine(`${color("brightCyan", "╭─")} ${color("bold", target)}`);
    this.writeLine(`${color("gray", "╰─")} ${color("dim", detail)}  ${color("gray", "输入 /sc 返回全部消息")}`);
  }

  getPrompt() {
    return this.activeChat ? "› " : "> ";
  }

  updatePrompt() {
    if (!this.rl) return;
    this.rl.setPrompt(this.getPrompt());
    if (!this.runningCommand && !this.exiting) this.rl.prompt(true);
  }

  completeInput(line) {
    const match = String(line || "").match(/^(\/)?(sp|sg)(?:\s+(\d*))?$/i);
    if (!match) return [[], line];

    const slash = match[1] || "";
    const command = match[2].toLowerCase();
    const typedId = match[3];
    if (typedId === undefined) {
      return [[`${slash}${command} `], line];
    }

    const ids = command === "sp" ? this.config.privateIds : this.config.groupIds;
    const prefix = `${slash}${command} `;
    const matches = ids
      .filter((id) => id.startsWith(typedId))
      .map((id) => `${prefix}${id}`);
    return [matches, line];
  }

  clearCurrentInput() {
    this.pendingImages = [];
    if (!this.rl || this.exiting) return;
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.prompt(true);
  }

  queueSubmittedLine(line) {
    this.submittedLineBatch.push(String(line));
    if (this.submittedLineFlushTimer) return;
    this.submittedLineFlushTimer = setTimeout(() => {
      this.submittedLineFlushTimer = null;
      this.flushSubmittedLines();
    }, SUBMITTED_LINE_BATCH_DELAY_MS);
  }

  flushSubmittedLines() {
    const lines = this.submittedLineBatch.splice(0);
    if (!lines.length) return;

    const line = lines.join("\n");
    this.clearSubmittedInput(line);
    const pendingImages = this.takePendingImages(line);
    this.commandQueue = this.commandQueue
      .then(() => this.runCommand(line, pendingImages))
      .catch((error) => this.writeLine(color("red", `[错误] ${error.message}`)));
  }

  setBracketedPaste(enabled) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write(enabled ? "\u001b[?2004h" : "\u001b[?2004l");
    this.bracketedPasteEnabled = enabled;
  }

  observeInputData(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    if (!text) return;

    if (text.includes(BRACKETED_PASTE_START)) this.beginPasteSession("bracketed");
    if (text.includes(BRACKETED_PASTE_END)) return;

    const hasLineEnding = /[\r\n]/.test(text);
    const content = text.replace(/[\r\n]/g, "");
    if (!hasLineEnding || !content) return;

    // Some terminals do not send bracketed-paste markers. In raw mode a
    // normal Enter is usually its own input chunk, while pasted text and its
    // line endings arrive together. Capture that chunk before readline turns
    // each line ending into a separate "line" event.
    this.beginPasteSession("unmarked");
    this.schedulePasteSessionFinish();
  }

  schedulePasteSessionFinish() {
    if (!this.pasteSession || this.pasteSession.kind !== "unmarked") return;
    if (this.pasteSessionFinishTimer) clearTimeout(this.pasteSessionFinishTimer);
    this.pasteSessionFinishTimer = setTimeout(() => {
      this.pasteSessionFinishTimer = null;
      this.finishPasteSession();
    }, UNMARKED_PASTE_IDLE_DELAY_MS);
  }

  beginPasteSession(kind = "bracketed") {
    if (this.pasteSession) return;
    const currentLine = String(this.rl?.line || "");
    const rawCursor = Number(this.rl?.cursor);
    const cursor = Number.isInteger(rawCursor)
      ? Math.max(0, Math.min(currentLine.length, rawCursor))
      : currentLine.length;
    this.pasteSession = {
      kind,
      lines: [],
      lineBefore: currentLine,
      cursorBefore: cursor,
    };
  }

  finishPasteSession(replacementText) {
    const pasteSession = this.pasteSession;
    this.pasteSession = null;
    if (this.pasteSessionFinishTimer) clearTimeout(this.pasteSessionFinishTimer);
    this.pasteSessionFinishTimer = null;
    if (!pasteSession || !this.rl || this.rl.closed) return false;

    if (replacementText !== undefined) {
      return this.setInputWithPastedText(replacementText, pasteSession);
    }
    if (!pasteSession.lines.length) return true;

    const currentLine = String(this.rl.line || "");
    const line = [...pasteSession.lines, currentLine].join(INPUT_NEWLINE_PLACEHOLDER);
    this.rl.line = line;
    this.rl.cursor = line.length;
    if (typeof this.rl.prompt === "function") this.rl.prompt(true);
    return true;
  }

  setInputWithPastedText(text, inputState = null) {
    if (!this.rl || this.rl.closed) return false;
    const pastedText = encodeInputNewlines(text);

    const currentLine = String(inputState?.lineBefore ?? this.rl.line ?? "");
    const rawCursor = Number(inputState?.cursorBefore ?? this.rl.cursor);
    const cursor = Number.isInteger(rawCursor)
      ? Math.max(0, Math.min(currentLine.length, rawCursor))
      : currentLine.length;
    const line = `${currentLine.slice(0, cursor)}${pastedText}${currentLine.slice(cursor)}`;
    this.rl.line = line;
    this.rl.cursor = cursor + pastedText.length;
    if (typeof this.rl.prompt === "function") this.rl.prompt(true);
    return true;
  }

  insertTextIntoInput(text) {
    if (!String(text || "")) return false;
    return this.setInputWithPastedText(text);
  }

  handleImagePaste() {
    const now = Date.now();
    if (now - this.lastPasteTime < 250) return;
    this.lastPasteTime = now;
    this.pasteClipboardImage().catch((error) => {
      this.writeLine(color("red", `[错误] 图片粘贴失败：${error.message}`));
    });
  }

  handleTextPaste() {
    const now = Date.now();
    if (now - this.lastPasteTime < 250) return;
    this.lastPasteTime = now;
    if (this.activeChat) this.beginPasteSession("manual");
    this.pasteClipboardText().catch((error) => {
      if (this.pasteSession?.kind === "manual") this.finishPasteSession("");
      this.writeLine(color("red", `[错误] 文字粘贴失败：${error.message}`));
    });
  }

  async pasteClipboardText() {
    if (!this.activeChat) {
      this.writeLine(color("yellow", "请先使用 sp 或 sg 进入会话。"));
      if (this.pasteSession?.kind === "manual") this.finishPasteSession("");
      return;
    }
    const text = await readClipboardText();
    if (!text) {
      this.writeLine(color("yellow", "剪贴板中没有文字。"));
      if (this.pasteSession?.kind === "manual") this.finishPasteSession("");
      return;
    }
    const pasted = this.pasteSession
      ? this.finishPasteSession(text)
      : this.insertTextIntoInput(text);
    if (pasted === false) {
      this.writeLine(color("yellow", "输入框尚未就绪，无法粘贴文字。"));
    }
  }

  async pasteClipboardImage() {
    if (!this.activeChat) {
      this.writeLine(color("yellow", "请先使用 sp 或 sg 进入会话。"));
      return;
    }
    const { output } = await readClipboardImage();
    this.pendingImages.push({
      type: "image",
      data: { file: `base64://${output.toString("base64")}` },
    });
    if (this.rl) this.rl.write(IMAGE_PLACEHOLDER);
  }

  takePendingImages(input) {
    const line = String(input || "");
    const placeholderCount = line.split(IMAGE_PLACEHOLDER).length - 1;
    const images = placeholderCount ? this.pendingImages.slice(0, placeholderCount) : [];
    this.pendingImages = [];
    return images;
  }

  buildDraftMessage(text, images) {
    const line = String(text || "").trim();
    if (!images.length) return { content: line, displayText: line };

    const pieces = line.split(IMAGE_PLACEHOLDER);
    const content = [];
    let imageIndex = 0;
    pieces.forEach((piece, index) => {
      if (piece) content.push({ type: "text", data: { text: piece } });
      if (index >= pieces.length - 1) return;
      const image = images[imageIndex++];
      content.push(image || { type: "text", data: { text: IMAGE_PLACEHOLDER } });
    });
    return { content, displayText: line };
  }

  addToHistory(message) {
    const chatKey = this.getChatHistoryKey(message.chatType, message.targetId);
    let history = this.historyByChat.get(chatKey);
    if (!history) {
      history = [];
      this.historyByChat.set(chatKey, history);
    }
    const key = messageKey(message);
    const existingIndex = history.findIndex((item) => messageKey(item) === key);
    if (existingIndex >= 0) {
      return false;
    }
    history.push(message);
    while (history.length > this.config.maxHistory) history.shift();
    return true;
  }

  getChatHistoryKey(chatType, targetId) {
    return `${chatType}:${String(targetId)}`;
  }

  getChatHistory(chat) {
    if (!chat) return [];
    return this.historyByChat.get(this.getChatHistoryKey(chat.chatType, chat.targetId)) || [];
  }

  getHistoryMessage(message) {
    return this.getChatHistory(message).find((item) => messageKey(item) === messageKey(message)) || null;
  }

  isRecentOutgoingImageDuplicate(message) {
    if (message.direction !== "outgoing" || !message.imageSources?.length) return false;
    const timestamp = Number(message.time) || Date.now();
    return this.getChatHistory(message).some((item) => item.direction === "outgoing"
      && String(item.id).startsWith("local-")
      && item.text === message.text
      && Array.isArray(item.imagePaths)
      && item.imagePaths.length > 0
      && Math.abs((Number(item.time) || 0) - timestamp) <= 30000);
  }

  getHistoryFilePath(chatType, targetId) {
    if (!['private', 'group'].includes(chatType) || !/^\d+$/.test(String(targetId))) {
      throw new Error("无法确定聊天记录文件");
    }
    return path.join(this.historyDir, `${chatType}-${targetId}.jsonl`);
  }

  serializeHistoryMessage(message) {
    const imageRoot = path.resolve(this.imageDir);
    const imagePaths = (Array.isArray(message.imagePaths) ? message.imagePaths : [])
      .map((imagePath) => path.resolve(String(imagePath)))
      .filter((imagePath) => imagePath.startsWith(`${imageRoot}${path.sep}`))
      .map((imagePath) => path.relative(this.projectDir, imagePath));
    return {
      id: String(message.id),
      time: message.time,
      direction: message.direction,
      deliveryStatus: message.direction === "outgoing"
        ? (message.deliveryStatus === "failed" ? "failed" : "success")
        : "",
      chatType: message.chatType,
      targetId: String(message.targetId),
      chatName: message.chatType === "group" ? normalizeChatName(message.chatName) : "",
      senderId: String(message.senderId || ""),
      senderName: String(message.senderName || ""),
      text: String(message.text || ""),
      imagePaths,
    };
  }

  resolveStoredImagePath(imagePath) {
    if (typeof imagePath !== "string" || !imagePath) return null;
    const imageRoot = path.resolve(this.imageDir);
    const resolved = path.resolve(this.projectDir, imagePath);
    if (!resolved.startsWith(`${imageRoot}${path.sep}`)) return null;
    return resolved;
  }

  persistMessage(message) {
    const filePath = this.getHistoryFilePath(message.chatType, message.targetId);
    const record = `${JSON.stringify(this.serializeHistoryMessage(message))}\n`;
    const chatKey = this.getChatHistoryKey(message.chatType, message.targetId);
    const previousTask = this.historyWriteQueues.get(chatKey) || Promise.resolve();
    const task = previousTask
      .catch(() => {})
      .then(async () => {
        let persistedKeys = this.persistedMessageKeys.get(chatKey);
        if (!persistedKeys) {
          persistedKeys = new Set();
          try {
            const existing = await fs.promises.readFile(filePath, "utf8");
            existing.split(/\r?\n/).forEach((line) => {
              if (!line.trim()) return;
              try {
                const stored = JSON.parse(line);
                if (stored && stored.id) persistedKeys.add(messageKey(stored));
              } catch {
                // 忽略损坏的旧记录，保留后续可用记录。
              }
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          this.persistedMessageKeys.set(chatKey, persistedKeys);
        }
        const key = messageKey(message);
        if (persistedKeys.has(key)) return;
        await fs.promises.mkdir(this.historyDir, { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(filePath, record, { encoding: "utf8", mode: 0o600 });
        await fs.promises.chmod(filePath, 0o600);
        persistedKeys.add(key);
      });
    this.historyWriteQueues.set(chatKey, task);
    return task;
  }

  async readChatHistory(chat, limit = HISTORY_LOAD_LIMIT) {
    const filePath = this.getHistoryFilePath(chat.chatType, chat.targetId);
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const recordsByKey = new Map();
    const recordOrder = [];

    try {
      for await (const line of input) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!record || !["incoming", "outgoing"].includes(record.direction)) continue;
          if (record.chatType !== chat.chatType || String(record.targetId) !== chat.targetId) continue;
          if (!record.id || typeof record.text !== "string") continue;
          const stored = {
            id: String(record.id),
            time: record.time || Date.now(),
            direction: record.direction,
            deliveryStatus: record.direction === "outgoing" && record.deliveryStatus === "failed"
              ? "failed"
              : record.direction === "outgoing" ? "success" : "",
            chatType: record.chatType,
            targetId: chat.targetId,
            chatName: record.chatType === "group" ? normalizeChatName(record.chatName) : "",
            senderId: String(record.senderId || ""),
            senderName: String(record.senderName || ""),
            text: record.text,
            rawMessage: record.text,
            imagePaths: Array.isArray(record.imagePaths)
              ? record.imagePaths.map((imagePath) => this.resolveStoredImagePath(imagePath)).filter(Boolean)
              : [],
            historySource: "persisted",
          };
          const key = messageKey(stored);
          const previous = recordsByKey.get(key);
          if (!previous) {
            recordsByKey.set(key, stored);
            recordOrder.push(key);
          } else {
            recordsByKey.set(key, {
              ...previous,
              ...stored,
              imagePaths: stored.imagePaths.length ? stored.imagePaths : previous.imagePaths,
            });
          }
        } catch {
          // 忽略损坏的旧记录，继续加载其他聊天记录。
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    return recordOrder.slice(-limit).map((key) => recordsByKey.get(key)).filter(Boolean);
  }

  async loadChatHistory(chat, revision) {
    const chatKey = this.getChatHistoryKey(chat.chatType, chat.targetId);
    await (this.historyWriteQueues.get(chatKey) || Promise.resolve()).catch(() => {});
    const messages = await this.readChatHistory(chat);
    if (revision !== this.chatRevision || !messageMatchesChat(this.activeChat, chat)) return;
    const storedChatName = messages
      .slice()
      .reverse()
      .find((message) => message.chatName)?.chatName;
    if (storedChatName) {
      chat.displayName = storedChatName;
      this.updatePrompt();
    }
    messages.forEach((message) => this.addToHistory(message));
    if (!messages.length) return;
    this.writeLine(color("dim", `已加载最近 ${messages.length} 条本地聊天记录。`));
    messages.forEach((message) => this.writeLine(this.renderMessage(message)));
  }

  async findStoredImageCandidates() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.imageDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(entry.name)) continue;
      const imagePath = path.join(this.imageDir, entry.name);
      try {
        const stat = await fs.promises.stat(imagePath);
        candidates.push({ imagePath, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件可能在扫描期间被清理，跳过即可。
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return candidates.map((candidate) => candidate.imagePath);
  }

  findActiveChatImageCandidates() {
    const candidates = [];
    this.getChatHistory(this.activeChat).forEach((message, messageIndex) => {
      const imagePaths = Array.isArray(message.imagePaths) ? message.imagePaths : [];
      imagePaths.forEach((imagePath, imageIndex) => {
        const resolvedPath = this.resolveStoredImagePath(imagePath);
        if (!resolvedPath) return;
        candidates.push({
          imagePath: resolvedPath,
          time: Number(message.time) || 0,
          messageIndex,
          imageIndex,
        });
      });
    });
    candidates.sort((left, right) => right.time - left.time
      || right.messageIndex - left.messageIndex
      || right.imageIndex - left.imageIndex);
    return candidates.map((candidate) => candidate.imagePath);
  }

  async findImageByIndex(index = 1) {
    const candidates = this.activeChat
      ? this.findActiveChatImageCandidates()
      : await this.findStoredImageCandidates();
    this.lastImagePath = candidates[index - 1] || null;
    return this.lastImagePath;
  }

  launchImageViewer(imagePath) {
    const commands = process.platform === "darwin"
      ? [["open", [imagePath]]]
      : process.platform === "win32"
        ? [["cmd.exe", ["/c", "start", "", imagePath]]]
        : [["xdg-open", [imagePath]], ["gio", ["open", imagePath]]];

    return new Promise((resolve, reject) => {
      let index = 0;
      let lastError;
      const tryNext = () => {
        if (index >= commands.length) {
          reject(lastError || new Error("未找到可用的本机图像查看器"));
          return;
        }
        const [command, args] = commands[index++];
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("error", (error) => {
          lastError = error;
          tryNext();
        });
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      };
      tryNext();
    });
  }

  async openLatestImage(index = 1) {
    const imagePath = await this.findImageByIndex(index);
    if (!imagePath) {
      const scope = this.activeChat ? "当前隔离聊天中" : "当前图片记录中";
      this.writeLine(color("yellow", `${scope}没有第 ${index} 张图片。`));
      return;
    }
    try {
      await this.launchImageViewer(imagePath);
      this.writeLine(color("green", `已打开第 ${index} 张图片（按最近顺序）：${imagePath}`));
    } catch (error) {
      this.writeLine(color("red", `[错误] 图片查看器打开失败：${error.message}`));
    }
  }

  getVisibleHistory() {
    if (!this.activeChat) return [];
    return [...this.getChatHistory(this.activeChat)];
  }

  renderMessage(message) {
    const isOutgoing = message.direction === "outgoing";
    const icon = isOutgoing ? "↑" : "↓";
    const kind = message.chatType === "private" ? "私聊" : "群聊";
    const chatLabel = message.chatType === "private"
      ? `${kind} ${message.targetId}`
      : `${kind} ${message.chatName || "（未知群名称）"}`;
    const sender = isOutgoing
      ? "我"
      : (message.senderName || (message.chatType === "private" ? "对方" : "群成员"));
    const directionColor = isOutgoing ? "brightMagenta" : "brightCyan";
    const senderLabel = color(directionColor, color("bold", `【${sender}】`));
    const separator = color("gray", " │ ");
    const messageText = String(message.text || "");
    const time = color("dim", formatTime(message.time));
    const isIsolatedMessage = this.activeChat
      && messageMatchesChat(message, this.activeChat)
      && process.stdout.isTTY;
    if (isIsolatedMessage) {
      const deliveryStatus = message.deliveryStatus === "failed" ? "failed" : "success";
      const status = isOutgoing
        ? color(deliveryStatus === "failed" ? "red" : "green", deliveryStatus === "failed" ? "!" : "✓")
        : color(directionColor, "•");
      const senderText = color(directionColor, color("bold", sender));
      const messageLines = messageText.split(/\r?\n/);
      const bubble = [
        `${color(directionColor, "╭─")} ${senderText}  ${time}  ${status}`,
        `${color(directionColor, "╰─")} ${messageLines[0] || ""}`,
        ...messageLines.slice(1).map((line) => `   ${line}`),
      ].join("\n");
      return alignMessageBlock(bubble, message.direction, process.stdout.columns);
    }
    return `${time} ${color(directionColor, icon)} ${color("brightBlue", chatLabel)}  ${senderLabel}${separator}${messageText}`;
  }

  async runCommand(input, pendingImages = []) {
    const line = decodeInputNewlines(input).trim();
    if (!line) {
      if (this.rl) this.rl.prompt();
      return;
    }
    const command = line.startsWith("/") ? line.slice(1).trim() : line;
    const lower = command.toLowerCase();

    this.runningCommand = true;
    try {
      if (lower === "help" || lower === "h" || lower === "?") return this.showHelp();
      if (lower === "status" || lower === "s") return this.showStatus();
      if (lower === "ls") return this.showWhitelist();
      if (/^op(?:\s|$)/.test(lower)) {
        const match = command.match(/^op\s+img(?:\s+(\d+))?$/i);
        if (!match) throw new Error("用法：op img [index]");
        const index = match[1] ? Number(match[1]) : 1;
        if (!Number.isSafeInteger(index) || index < 1) {
          throw new Error("图片索引必须是大于等于 1 的整数");
        }
        return await this.openLatestImage(index);
      }
      if (lower === "reconnect" || lower === "r") {
        this.connection.reconnect();
        return;
      }
      if (lower === "quit" || lower === "exit" || lower === "q") return this.exit();
      if (/^(sp|sg|sc)(?:\s|$)/.test(lower)) return await this.selectChat(command);
      if (lower === "history" || lower.startsWith("history ")) return this.showHistory(command);
      if (/^gls(?:\s|$)/.test(lower)) return await this.showGroupMembers(command);
      if (/^(fp|fg)(?:\s|$)/.test(lower)) return this.setFilter(command);
      if (this.activeChat && !line.startsWith("/")) {
        return await this.sendToActiveChat(line, pendingImages);
      }
      this.writeLine(color("yellow", "未知命令，输入 help 查看帮助。"));
    } catch (error) {
      this.writeLine(color("red", `[错误] ${error.message}`));
    } finally {
      this.runningCommand = false;
      if (this.rl && !this.exiting) this.rl.prompt();
    }
  }

  showHelp() {
    [
      "命令：",
      "  ls                           查看私聊和群聊白名单",
      "  fp <QQ号...>                 追加私聊白名单（filter private）",
      "  fg <群号...>                 追加群聊白名单（filter group）",
      "  fp clear                     清空私聊白名单（filter private clear）",
      "  fg clear                     清空群聊白名单（filter group clear）",
      "  sp <QQ号>                    进入私聊并隔离其他消息（select private）",
      "  sg <群号>                    进入群聊并隔离其他消息（select group）",
      "  Tab（sp/sg）                 补全白名单账号，连续两次显示候选",
      "  sc                           取消隔离，显示白名单消息（select clear）",
      "  （进入会话后直接输入文字即可发送）",
      "  history [数量]                查看当前隔离聊天的历史消息",
      "  [QQ号/昵称]消息               群聊中@指定成员并发送消息",
      "  gls [关键词]                  列出群成员或按昵称模糊搜索",
      "  op img [index]               打开图片；1 为最近一张，省略 index 默认使用 1",
      "  status                       查看连接状态",
      "  help                         查看帮助",
      "  Ctrl+C                       清除当前输入",
      "  Ctrl+V                       粘贴剪贴板图片占位符，回车发送",
      "  Ctrl+Shift+V                 粘贴剪贴板文字到输入栏，回车发送",
      "  Ctrl+D                       退出程序",
      "  reconnect                    立即重连 NapCat",
      "  quit                         退出 QQlight",
      "",
      "示例：sp <QQ号>，然后直接输入消息",
    ].forEach((line) => this.writeLine(line));
  }

  showStatus() {
    const status = this.connection.status();
    this.writeLine(`连接：${status.connected ? color("green", "已连接") : color("yellow", status.state)}`);
    this.writeLine(`地址：${status.wsUrl}`);
    this.writeLine(`私聊白名单：${status.privateIds.length ? status.privateIds.join(", ") : "空（不接收）"}`);
    this.writeLine(`群聊白名单：${status.groupIds.length ? status.groupIds.join(", ") : "空（不接收）"}`);
    const currentChat = !this.activeChat
      ? "全部白名单消息"
      : this.activeChat.chatType === "private"
        ? `私聊 ${this.activeChat.displayName || this.activeChat.targetId}`
        : `群聊 ${this.activeChat.displayName || "（正在获取群名称）"}`;
    this.writeLine(`当前会话：${currentChat}`);
  }

  showWhitelist() {
    this.writeLine("白名单：");
    this.writeLine(`私聊：${this.config.privateIds.length ? this.config.privateIds.join(", ") : "空（不接收）"}`);
    this.writeLine(`群聊：${this.config.groupIds.length ? this.config.groupIds.join(", ") : "空（不接收）"}`);
  }

  setFilter(command) {
    const match = command.match(/^(fp|fg)\s+(.+)$/i);
    if (!match) throw new Error("用法：fp|fg <ID...>，或填 clear 清空白名单");
    const kind = match[1].toLowerCase() === "fp" ? "private" : "group";
    const value = match[2].trim();
    const clearsWhitelist = /^(clear|none)$/i.test(value);
    if (/^all$/i.test(value)) {
      throw new Error("当前仅支持白名单模式，不能设置为接收全部；请使用 clear 清空白名单");
    }
    const additions = clearsWhitelist ? [] : normalizeIds(value);
    if (!additions.length && !clearsWhitelist) {
      throw new Error("没有解析到有效的数字 ID");
    }
    const currentIds = kind === "private" ? this.config.privateIds : this.config.groupIds;
    const ids = clearsWhitelist ? [] : mergeIds(currentIds, additions);
    if (kind === "private") this.config.privateIds = ids;
    else this.config.groupIds = ids;
    saveConfig(this.config);
    const label = kind === "private" ? "私聊" : "群聊";
    this.writeLine(color("green", clearsWhitelist
      ? `${label}白名单已清空。`
      : `${label}白名单已添加：${additions.join(", ")}；当前共 ${ids.length} 个：${ids.join(", ")}`));
  }

  showHistory(command) {
    if (!this.activeChat) {
      this.writeLine(color("yellow", "请先使用 sp 或 sg 进入隔离聊天，再查看对应聊天历史。"));
      return;
    }
    const countText = command.slice("history".length).trim();
    const visibleHistory = this.getVisibleHistory();
    const count = countText ? Math.max(1, Math.min(visibleHistory.length, Number(countText) || 20)) : 20;
    const items = visibleHistory.slice(-count);
    if (!items.length) {
      this.writeLine(color("dim", this.activeChat ? "当前会话没有消息历史。" : "当前没有消息历史。"));
      return;
    }
    items.forEach((message) => this.writeLine(this.renderMessage(message)));
  }

  async selectChat(command) {
    if (/^sc$/i.test(command)) {
      this.activeChat = null;
      this.chatRevision += 1;
      this.updatePrompt();
      this.writeLine(color("green", "已取消会话隔离，显示白名单消息。"));
      return;
    }

    const match = command.match(/^(sg|sp)\s+(\d+)$/i);
    if (!match) throw new Error("用法：sp <QQ号>、sg <群号> 或 sc");

    const mode = match[1].toLowerCase();
    const chat = {
      chatType: mode === "sg" ? "group" : "private",
      targetId: match[2],
      displayName: "",
    };
    const whitelist = chat.chatType === "private" ? this.config.privateIds : this.config.groupIds;
    if (!whitelist.includes(chat.targetId)) {
      const label = chat.chatType === "private" ? "私聊" : "群聊";
      this.writeLine(color("yellow", `${label} ${chat.targetId} 不在白名单中，无法进入。请先使用 ${chat.chatType === "private" ? "fp" : "fg"} 添加。`));
      return;
    }
    const revision = ++this.chatRevision;
    this.activeChat = chat;
    this.updatePrompt();
    this.renderChatHeader(chat);
    try {
      await this.loadChatHistory(chat, revision);
    } catch (error) {
      this.writeLine(color("red", `[错误] 本地聊天记录加载失败：${error.message}`));
    }
    if (chat.chatType === "private") this.loadPrivateNickname(chat, revision);
    else this.loadGroupName(chat, revision);
  }

  async loadPrivateNickname(chat, revision) {
    try {
      const response = await this.connection.send("get_stranger_info", {
        user_id: Number(chat.targetId),
      });
      if (revision !== this.chatRevision || !messageMatchesChat(this.activeChat, chat)) return;
      const data = response && response.data;
      const nickname = String(data && (data.nickname || data.remark) || "").trim();
      if (!nickname) return;
      chat.displayName = nickname;
      this.updatePrompt();
    } catch {
      // 进入会话不依赖资料接口；资料获取失败时继续使用 QQ 号作为提示。
    }
  }

  async loadGroupName(chat, revision) {
    try {
      const response = await this.connection.send("get_group_info", {
        group_id: Number(chat.targetId),
      });
      if (revision !== this.chatRevision || !messageMatchesChat(this.activeChat, chat)) return;
      const data = response && response.data;
      const groupName = normalizeChatName(data && data.group_name);
      if (!groupName) return;
      chat.displayName = groupName;
      this.updatePrompt();
    } catch {
      // 群名称获取失败时继续使用无号码提示，不影响进入隔离聊天。
    }
  }

  async getGroupMembers(groupId) {
    const normalizedGroupId = String(groupId);
    if (!this.groupMembersById) this.groupMembersById = new Map();
    if (this.groupMembersById.has(normalizedGroupId)) {
      return this.groupMembersById.get(normalizedGroupId);
    }

    const response = await this.connection.send("get_group_member_list", {
      group_id: Number(normalizedGroupId),
    });
    const members = Array.isArray(response && response.data) ? response.data : [];
    this.groupMembersById.set(normalizedGroupId, members);
    return members;
  }

  async showGroupMembers(command) {
    if (!this.activeChat || this.activeChat.chatType !== "group") {
      this.writeLine(color("yellow", "gls 只能在群聊隔离会话中使用，请先使用 sg <群号>。"));
      return;
    }

    const query = String(command || "").replace(/^gls/i, "").trim();
    let members;
    try {
      members = await this.getGroupMembers(this.activeChat.targetId);
    } catch (error) {
      throw new Error(`群成员列表获取失败：${error.message}`);
    }

    const normalizedQuery = normalizeMentionName(query);
    const matches = normalizedQuery
      ? members.filter((member) => getGroupMemberNameCandidates(member)
        .some((name) => normalizeMentionName(name).includes(normalizedQuery)))
      : members;
    if (!matches.length) {
      this.writeLine(color("yellow", query
        ? `没有找到名称包含“${query}”的群成员。`
        : "当前群没有可显示的成员。"));
      return;
    }

    this.writeLine(color("cyan", query
      ? `匹配“${query}”的群成员（${matches.length}）：`
      : `群成员（${matches.length}）：`));
    matches.forEach((member, index) => {
      const userId = String(member && member.user_id || "未知QQ号");
      this.writeLine(`  ${index + 1}. ${getGroupMemberDisplayName(member)}  [${userId}]`);
    });
  }

  async resolveGroupMention(mention) {
    if (mention.userId) return mention;

    const members = await this.getGroupMembers(this.activeChat.targetId);
    const targetName = normalizeMentionName(mention.target);
    const matches = members.filter((member) => getGroupMemberNameCandidates(member)
      .some((name) => normalizeMentionName(name) === targetName));

    if (!matches.length) {
      throw new Error(`群成员“${mention.target}”不存在，请改用 QQ 号或检查群名片。`);
    }
    if (matches.length > 1) {
      throw new Error(`群成员“${mention.target}”有多个匹配对象，请改用 QQ 号。`);
    }

    const userId = String(matches[0].user_id || "");
    if (!/^\d+$/.test(userId)) {
      throw new Error(`群成员“${mention.target}”缺少有效 QQ 号，无法@。`);
    }
    return { ...mention, userId };
  }

  async sendToActiveChat(text, pendingImages = []) {
    let mention = this.activeChat.chatType === "group" ? parseGroupMention(text) : null;
    if (mention) mention = await this.resolveGroupMention(mention);
    const draft = this.buildDraftMessage(mention ? mention.text : text, pendingImages);
    const content = mention ? createAtMessageContent(mention.userId, draft.content) : draft.content;
    const displayText = mention
      ? `@${mention.target}${draft.displayText ? ` ${draft.displayText}` : ""}`
      : draft.displayText;
    return this.sendMessage(
      this.activeChat.chatType,
      this.activeChat.targetId,
      content,
      displayText,
    );
  }

  async sendMessage(chatType, targetId, content, displayText = content) {
    if (!content || (typeof content === "string" && !content.trim())) return;
    const action = chatType === "private" ? "send_private_msg" : "send_group_msg";
    const params = chatType === "private"
      ? { user_id: Number(targetId), message: content }
      : { group_id: Number(targetId), message: content };

    const message = {
      id: `local-${Date.now()}-${crypto.randomUUID()}`,
      time: Date.now(),
      direction: "outgoing",
      deliveryStatus: "success",
      chatType,
      targetId,
      senderId: "",
      senderName: "",
      chatName: chatType === "group" && this.activeChat?.chatType === "group"
        && this.activeChat.targetId === targetId
        ? normalizeChatName(this.activeChat.displayName)
        : "",
      text: displayText,
      rawMessage: typeof content === "string" ? content : safeJson(content),
      imageSources: extractImageSources(content),
    };
    let response;
    try {
      response = await this.connection.send(action, params);
    } catch {
      message.id = `failed-${Date.now()}-${crypto.randomUUID()}`;
      message.deliveryStatus = "failed";
      const storedFailedMessage = await this.saveMessageImages(message);
      if (this.addToHistory(storedFailedMessage)) {
        await this.persistMessage(storedFailedMessage);
        if (messageMatchesChat(storedFailedMessage, this.activeChat)) {
          this.writeLine(this.renderMessage(storedFailedMessage));
        }
      }
      return;
    }
    const responseMessageId = response && response.data && response.data.message_id;
    if (responseMessageId !== undefined && responseMessageId !== null) {
      message.id = String(responseMessageId);
    }
    const existingMessage = this.getHistoryMessage(message);
    if (existingMessage) {
      if (messageMatchesChat(existingMessage, this.activeChat)) {
        this.writeLine(this.renderMessage(existingMessage));
      }
      return;
    }
    const storedMessage = await this.saveMessageImages(message);
    if (!this.addToHistory(storedMessage)) return;
    await this.persistMessage(storedMessage);
    if (messageMatchesChat(storedMessage, this.activeChat)) {
      this.writeLine(this.renderMessage(storedMessage));
    } else {
      this.writeLine(color("green", "发送成功（当前会话已隔离）"));
    }
  }

  exit() {
    if (this.exiting) return;
    this.exiting = true;
    if (this.keypressHandler) process.stdin.off("keypress", this.keypressHandler);
    if (this.inputDataHandler) process.stdin.off("data", this.inputDataHandler);
    if (this.sigintHandler) process.off("SIGINT", this.sigintHandler);
    if (this.pasteSessionFinishTimer) clearTimeout(this.pasteSessionFinishTimer);
    this.pasteSessionFinishTimer = null;
    if (this.submittedLineFlushTimer) clearTimeout(this.submittedLineFlushTimer);
    this.submittedLineFlushTimer = null;
    this.submittedLineBatch = [];
    if (this.bracketedPasteEnabled) this.setBracketedPaste(false);
    this.connection.stop();
    if (this.rl) this.rl.close();
    process.stdout.write("QQlight 已退出。\n");
  }
}

if (require.main === module) {
  saveConfig(loadConfig());
  new QQlightApp().start();
}

module.exports = {
  QQlightApp,
  NapCatConnection,
  createMessageEvent,
  formatImageError,
  resolveImageProxy,
  mergeIds,
  alignMessageBlock,
  alignMessageLine,
  terminalCellWidth,
  messageMatchesChat,
};
