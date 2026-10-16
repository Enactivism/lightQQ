#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const IMAGE_PLACEHOLDER = "[图片]";

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

function readClipboardCommand(command, args) {
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
      if (code === 0 && output.length) {
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
      return await readClipboardCommand(command, args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未找到可用的剪贴板工具");
}

async function readClipboardText() {
  const output = await readClipboard([
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ]);
  return output.toString("utf8").replace(/\r\n/g, "\n").trim();
}

async function readClipboardImage() {
  const imageTypes = [
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ];
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

function formatTime(value) {
  const date = new Date(value || Date.now());
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function createMessageEvent(payload) {
  if (!payload || !["message", "message_sent"].includes(payload.post_type)) return null;
  if (!["private", "group"].includes(payload.message_type)) return null;

  const chatType = payload.message_type;
  const targetId = chatType === "private" ? String(payload.user_id || "") : String(payload.group_id || "");
  if (!/^\d+$/.test(targetId)) return null;

  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender : {};
  const senderId = String(sender.user_id || payload.user_id || "");
  const text = extractMessageText(payload.message || payload.raw_message || "");
  if (!text) return null;

  return {
    id: String(payload.message_id || `${Date.now()}-${Math.random()}`),
    time: Date.now(),
    direction: payload.post_type === "message_sent" ? "outgoing" : "incoming",
    chatType,
    targetId,
    senderId,
    senderName: String(sender.card || sender.nickname || ""),
    text,
    rawMessage: typeof payload.raw_message === "string" ? payload.raw_message : safeJson(payload.message),
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

  send(action, params) {
    if (!this.connected) return Promise.reject(new Error("NapCat 尚未连接"));
    const echo = crypto.randomUUID();
    const packet = JSON.stringify({ action, params, echo });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`等待 NapCat 响应超时：${action}`));
      }, 15000);
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
    this.history = [];
    this.activeChat = null;
    this.chatRevision = 0;
    this.exiting = false;
    this.runningCommand = false;
    this.commandQueue = Promise.resolve();
    this.lastPasteTime = 0;
    this.pendingImages = [];
    this.keypressHandler = null;
    this.sigintHandler = null;
    this.rl = null;
    this.connection = new NapCatConnection(this.config, {
      onStatus: (status, detail) => {
        if (detail) this.writeLine(color(status.state === "open" ? "green" : "yellow", `[状态] ${detail}`));
      },
      onMessage: (message) => this.receiveMessage(message),
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

  receiveMessage(message) {
    this.addToHistory(message);
    if (this.activeChat?.chatType === "private"
      && message.chatType === "private"
      && message.targetId === this.activeChat.targetId
      && message.senderName) {
      this.activeChat.displayName = message.senderName;
      this.updatePrompt();
    }
    if (messageMatchesChat(message, this.activeChat)) this.writeLine(this.renderMessage(message));
  }

  getPrompt() {
    if (!this.activeChat) return "> ";
    if (this.activeChat.chatType === "private") {
      return `${this.activeChat.displayName || this.activeChat.targetId} > `;
    }
    return `群聊 ${this.activeChat.targetId} > `;
  }

  updatePrompt() {
    if (!this.rl) return;
    this.rl.setPrompt(this.getPrompt());
    if (!this.runningCommand && !this.exiting) this.rl.prompt(true);
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
    const key = messageKey(message);
    const existingIndex = this.history.findIndex((item) => messageKey(item) === key);
    if (existingIndex >= 0) {
      this.history[existingIndex] = message;
      return;
    }
    this.history.push(message);
    while (this.history.length > this.config.maxHistory) this.history.shift();
  }

  getVisibleHistory() {
    return this.history.filter((message) => messageMatchesChat(message, this.activeChat));
  }

  renderMessage(message) {
    const icon = message.direction === "outgoing" ? "↑" : "↓";
    const kind = message.chatType === "private" ? "私聊" : "群聊";
    const sender = message.senderName ? ` ${message.senderName}` : "";
    const directionColor = message.direction === "outgoing" ? "magenta" : "cyan";
    return `${color("dim", formatTime(message.time))} ${color(directionColor, `${icon} ${kind} ${message.targetId}`)}${sender}: ${message.text}`;
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
      if (lower === "reconnect" || lower === "r") {
        this.connection.reconnect();
        return;
      }
      if (lower === "quit" || lower === "exit" || lower === "q") return this.exit();
      if (/^(sp|sg|sc)(?:\s|$)/.test(lower)) return await this.selectChat(command);
      if (lower === "history" || lower.startsWith("history ")) return this.showHistory(command);
      if (/^(fp|fg)(?:\s|$)/.test(lower)) return this.setFilter(command);
      if (lower.startsWith("send ") || /^(p|private|g|group)\s+\d+\s+/.test(command)) {
        return await this.sendFromCommand(command);
      }
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
      "  sc                           取消隔离，显示白名单消息（select clear）",
      "  （进入会话后直接输入文字即可发送）",
      "  p <QQ号> <消息>              发送私聊消息",
      "  g <群号> <消息>              发送群聊消息",
      "  send private <QQ号> <消息>   发送私聊消息",
      "  send group <群号> <消息>      发送群聊消息",
      "  history [数量]                查看本次运行收到/发送的消息",
      "  status                       查看连接状态",
      "  help                         查看帮助",
      "  Ctrl+C                       清除当前输入",
      "  Ctrl+V                       粘贴剪贴板图片占位符，回车发送",
      "  Ctrl+Shift+V                 粘贴剪贴板文字并发送",
      "  Ctrl+D                       退出程序",
      "  reconnect                    立即重连 NapCat",
      "  quit                         退出 QQlight",
      "",
      "示例：send group 123456789 大家好",
    ].forEach((line) => this.writeLine(line));
  }

  showStatus() {
    const status = this.connection.status();
    this.writeLine(`连接：${status.connected ? color("green", "已连接") : color("yellow", status.state)}`);
    this.writeLine(`地址：${status.wsUrl}`);
    this.writeLine(`私聊白名单：${status.privateIds.length ? status.privateIds.join(", ") : "空（不接收）"}`);
    this.writeLine(`群聊白名单：${status.groupIds.length ? status.groupIds.join(", ") : "空（不接收）"}`);
    this.writeLine(`当前会话：${this.activeChat ? `${this.activeChat.chatType === "private" ? "私聊" : "群聊"} ${this.activeChat.targetId}` : "全部白名单消息"}`);
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
    this.writeLine(color("green", `已进入${chat.chatType === "group" ? "群聊" : "私聊"} ${chat.targetId}。`));
    if (chat.chatType === "private") this.loadPrivateNickname(chat, revision);
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

  async sendFromCommand(command) {
    let match = command.match(/^send\s+(private|group|p|g)\s+(\d+)\s+([\s\S]+)$/i);
    if (!match) match = command.match(/^(private|p|group|g)\s+(\d+)\s+([\s\S]+)$/i);
    if (!match) throw new Error("用法：send private|group <ID> <消息>");

    const typeValue = match[1].toLowerCase();
    const chatType = ["private", "p"].includes(typeValue) ? "private" : "group";
    return this.sendMessage(chatType, match[2], match[3].trim());
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

    await this.connection.send(action, params);
    const message = {
      id: `local-${Date.now()}`,
      time: Date.now(),
      direction: "outgoing",
      chatType,
      targetId,
      senderId: "",
      senderName: "",
      text: displayText,
      rawMessage: typeof content === "string" ? content : safeJson(content),
    };
    this.addToHistory(message);
    if (messageMatchesChat(message, this.activeChat)) {
      this.writeLine(color("green", "发送成功") + ` ${this.renderMessage(message)}`);
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
  messageMatchesChat,
};
