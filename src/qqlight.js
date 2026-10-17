#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const WebSocket = require("ws");

const IMAGE_PLACEHOLDER = "[图片]";
const HISTORY_LOAD_LIMIT = 20;
const HISTORY_DIR = path.resolve(__dirname, "..", ".qqlight", "history");
const IMAGE_DIR = path.resolve(__dirname, "..", ".qqlight", "images");
const IMAGE_FETCH_ATTEMPTS = 3;
const IMAGE_FETCH_TIMEOUT_MS = 8000;
const IMAGE_FETCH_RETRY_DELAYS_MS = [250, 750];
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const NAPCAT_IMAGE_RESOLVE_TIMEOUT_MS = 30000;

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
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
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

function alignMessageLine(line, direction, terminalWidth = process.stdout.columns) {
  if (direction !== "outgoing") return line;
  const width = Math.max(20, Number(terminalWidth) || 80);
  const contentWidth = terminalCellWidth(line);
  if (contentWidth >= width) return line;
  return `${" ".repeat(Math.max(0, width - contentWidth - 1))}${line}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSafeImageError(message, { cause, retryable = false } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.safeForDisplay = true;
  error.retryable = retryable;
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

function isDirectImageValue(value) {
  const source = String(value || "");
  return /^(?:base64|data|https?|file):/i.test(source) || path.isAbsolute(source);
}

function normalizeIds(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter((item) => /^\d+$/.test(item)))];
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

function extractMessageText(message) {
  if (typeof message === "string") {
    return message.replace(/\[CQ:([^,\]]+)(?:,[^\]]*)?\]/g, (_all, type) => {
      const labels = {
        image: "[图片]",
        record: "[语音]",
        video: "[视频]",
        face: "[表情]",
        file: "[文件]",
        reply: "[回复]",
        at: "@某人",
      };
      return labels[type] || `[${type}]`;
    }).trim();
  }

  if (!Array.isArray(message)) return "";
  return message.map((segment) => {
    if (!segment || typeof segment !== "object") return "";
    const type = segment.type;
    const data = segment.data || {};
    if (type === "text") return String(data.text || "");
    if (type === "at") return `@${data.name || data.qq || "某人"}`;
    const labels = {
      image: "[图片]",
      record: "[语音]",
      video: "[视频]",
      face: "[表情]",
      file: "[文件]",
      reply: "[回复]",
      json: "[JSON]",
      xml: "[XML]",
    };
    return labels[type] || (type ? `[${type}]` : "");
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
    this.activeChat = null;
    this.chatRevision = 0;
    this.exiting = false;
    this.runningCommand = false;
    this.commandQueue = Promise.resolve();
    this.lastPasteTime = 0;
    this.pendingImages = [];
    this.keypressHandler = null;
    this.sigintHandler = null;
    this.projectDir = path.resolve(__dirname, "..");
    this.historyDir = HISTORY_DIR;
    this.imageDir = IMAGE_DIR;
    this.lastImagePath = null;
    this.historyWriteQueues = new Map();
    this.persistedMessageKeys = new Map();
    this.messageQueue = Promise.resolve();
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
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      prompt: this.getPrompt(),
      completer: (line) => this.completeInput(line),
    });
    readline.emitKeypressEvents(process.stdin, this.rl);
    this.keypressHandler = (_sequence, key) => {
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
      const pendingImages = this.takePendingImages(line);
      this.commandQueue = this.commandQueue
        .then(() => this.runCommand(line, pendingImages))
        .catch((error) => this.writeLine(color("red", `[错误] ${error.message}`)));
    });
    this.rl.on("close", () => {
      if (!this.exiting) this.exit();
    });
    this.rl.on("SIGINT", () => this.clearCurrentInput());
    this.sigintHandler = () => this.clearCurrentInput();
    process.on("SIGINT", this.sigintHandler);
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

  async receiveMessage(message) {
    if (this.getHistoryMessage(message) || this.isRecentOutgoingImageDuplicate(message)) return;
    const storedMessage = await this.saveMessageImages(message);
    if (!this.addToHistory(storedMessage)) return;
    this.persistMessage(storedMessage).catch((error) => {
      this.writeLine(color("red", `[错误] 聊天记录保存失败：${error.message}`));
    });
    if (this.activeChat?.chatType === "private"
      && storedMessage.chatType === "private"
      && storedMessage.targetId === this.activeChat.targetId
      && storedMessage.senderName) {
      this.activeChat.displayName = storedMessage.senderName;
      this.updatePrompt();
    }
    if (this.activeChat?.chatType === "group"
      && storedMessage.chatType === "group"
      && storedMessage.targetId === this.activeChat.targetId
      && storedMessage.chatName) {
      this.activeChat.displayName = storedMessage.chatName;
      this.updatePrompt();
    }
    if (messageMatchesChat(storedMessage, this.activeChat)) {
      this.writeLine(this.renderMessage(storedMessage));
    }
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

  async fetchImageValue(source, mime = "") {
    const fetchImpl = this.fetchImpl || globalThis.fetch;
    const waitImpl = this.waitImpl || wait;
    let lastError;

    for (let attempt = 0; attempt < IMAGE_FETCH_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(source, { signal: controller.signal });
        if (!response.ok) {
          const retryable = response.status === 408
            || response.status === 429
            || response.status >= 500;
          await response.body?.cancel?.().catch(() => {});
          throw createSafeImageError(`下载图片失败：HTTP ${response.status}`, { retryable });
        }

        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > IMAGE_MAX_BYTES) {
          await response.body?.cancel?.().catch(() => {});
          throw createSafeImageError("下载图片失败：图片超过 25 MiB 限制");
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) {
          throw createSafeImageError("下载图片失败：图片内容为空", { retryable: true });
        }
        if (buffer.length > IMAGE_MAX_BYTES) {
          throw createSafeImageError("下载图片失败：图片超过 25 MiB 限制");
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
          lastError = error;
        } else if (error?.name === "AbortError") {
          lastError = createSafeImageError("下载图片超时", { cause: error, retryable: true });
        } else {
          const code = getSafeErrorCode(error);
          lastError = createSafeImageError(
            `下载图片失败：${code || "网络错误"}`,
            { cause: error, retryable: true },
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
        { cause: lastError },
      );
    }
    throw lastError || createSafeImageError("下载图片失败");
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
      if (!buffer.length) throw createSafeImageError("本地图片为空");
      if (buffer.length > IMAGE_MAX_BYTES) {
        throw createSafeImageError("读取图片失败：图片超过 25 MiB 限制");
      }
      return { buffer, extension: this.getImageExtension(imagePath, mime) };
    } catch (error) {
      if (error?.safeForDisplay) throw error;
      const code = getSafeErrorCode(error);
      throw createSafeImageError(
        `读取本地图片失败${code ? `：${code}` : ""}`,
        { cause: error },
      );
    }
  }

  async readImageSource(source) {
    let lastError;
    const triedValues = new Set();
    const readCandidate = async (value, mime = source.type, filename = "") => {
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
        lastError = error;
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
      try {
        const response = await this.connection.send(
          "get_image",
          { file: napcatReference },
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
        for (const value of resolvedValues) {
          if (!isDirectImageValue(value)) continue;
          const result = await readCandidate(value, source.type, String(data.file_name || ""));
          if (result) return result;
        }
      } catch (error) {
        const timedOut = /响应超时/.test(String(error?.message || ""));
        const code = getSafeErrorCode(error);
        lastError = createSafeImageError(
          timedOut
            ? "NapCat 图片解析超时"
            : `NapCat 图片解析失败${code ? `（${code}）` : ""}`,
          { cause: error },
        );
      }
    }

    throw lastError || createSafeImageError("图片没有可用来源");
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
      }
    }
    return { ...message, imagePaths };
  }

  getPrompt() {
    return "> ";
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
    this.pasteClipboardText().catch((error) => {
      this.writeLine(color("red", `[错误] 文字粘贴失败：${error.message}`));
    });
  }

  async pasteClipboardText() {
    if (!this.activeChat) {
      this.writeLine(color("yellow", "请先使用 sp 或 sg 进入会话。"));
      return;
    }
    const text = await readClipboardText();
    if (!text) {
      this.writeLine(color("yellow", "剪贴板中没有文字。"));
      return;
    }
    await this.sendMessage(this.activeChat.chatType, this.activeChat.targetId, text);
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
    const icon = message.direction === "outgoing" ? "↑" : "↓";
    const kind = message.chatType === "private" ? "私聊" : "群聊";
    const chatLabel = message.chatType === "private"
      ? `${kind} ${message.targetId}`
      : `${kind} ${message.chatName || "（未知群名称）"}`;
    const sender = message.senderName ? ` ${message.senderName}` : "";
    const directionColor = message.direction === "outgoing" ? "magenta" : "cyan";
    const isIsolatedMessage = this.activeChat
      && messageMatchesChat(message, this.activeChat)
      && process.stdout.isTTY;
    if (isIsolatedMessage) {
      const isolatedSender = message.direction === "outgoing"
        ? "我"
        : (message.senderName || (message.chatType === "private" ? "对方" : "群成员"));
      const deliveryStatus = message.deliveryStatus === "failed" ? "failed" : "success";
      const deliveryDot = message.direction === "outgoing"
        ? `${color(deliveryStatus === "failed" ? "red" : "green", "●")} `
        : "";
      const coloredContent = `${deliveryDot}${color(directionColor, `${isolatedSender}: ${message.text}`)}`;
      const isolatedLine = `${coloredContent}  ${color("dim", formatTime(message.time))}`;
      return alignMessageLine(isolatedLine, message.direction, process.stdout.columns);
    }
    return `${color("dim", formatTime(message.time))} ${color(directionColor, `${icon} ${chatLabel}`)}${sender}: ${message.text}`;
  }

  async runCommand(input, pendingImages = []) {
    const line = String(input || "").trim();
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
      "  fp <QQ号...>                 设置私聊白名单（filter private）",
      "  fg <群号...>                 设置群聊白名单（filter group）",
      "  fp clear                     清空私聊白名单（filter private clear）",
      "  fg clear                     清空群聊白名单（filter group clear）",
      "  sp <QQ号>                    进入私聊并隔离其他消息（select private）",
      "  sg <群号>                    进入群聊并隔离其他消息（select group）",
      "  Tab（sp/sg）                 补全白名单账号，连续两次显示候选",
      "  sc                           取消隔离，显示白名单消息（select clear）",
      "  （进入会话后直接输入文字即可发送）",
      "  history [数量]                查看当前隔离聊天的历史消息",
      "  op img [index]               打开图片；1 为最近一张，省略 index 默认使用 1",
      "  status                       查看连接状态",
      "  help                         查看帮助",
      "  Ctrl+C                       清除当前输入",
      "  Ctrl+V                       粘贴剪贴板图片占位符，回车发送",
      "  Ctrl+Shift+V                 粘贴剪贴板文字并发送",
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
    const ids = clearsWhitelist ? [] : normalizeIds(value);
    if (!ids.length && !clearsWhitelist) {
      throw new Error("没有解析到有效的数字 ID");
    }
    if (kind === "private") this.config.privateIds = ids;
    else this.config.groupIds = ids;
    saveConfig(this.config);
    const label = kind === "private" ? "私聊" : "群聊";
    this.writeLine(color("green", `${label}白名单已更新：${ids.length ? ids.join(", ") : "空（不接收）"}`));
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
    this.writeLine(color("green", chat.chatType === "group"
      ? "已进入群聊，正在获取群名称。"
      : `已进入私聊 ${chat.targetId}。`));
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

  async sendToActiveChat(text, pendingImages = []) {
    const draft = this.buildDraftMessage(text, pendingImages);
    return this.sendMessage(
      this.activeChat.chatType,
      this.activeChat.targetId,
      draft.content,
      draft.displayText,
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
    if (this.sigintHandler) process.off("SIGINT", this.sigintHandler);
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
  alignMessageLine,
  terminalCellWidth,
  messageMatchesChat,
};
