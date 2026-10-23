const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chatKey, isRemoteId } = require("./history-store");

const SYNC_DEFAULTS = Object.freeze({
  pageSize: 50, concurrency: 2, batchPages: 20, timeoutMs: 15000,
  freshnessMs: 60000, retryDelaysMs: [1000, 3000], batchDelayMs: 1000,
});

function validState(state) {
  if (state?.version !== 1 || !state.accounts || typeof state.accounts !== "object" || Array.isArray(state.accounts)) return false;
  if (state.legacyAccountId && !/^\d+$/.test(String(state.legacyAccountId))) return false;
  return Object.entries(state.accounts).every(([selfId, chats]) => /^\d+$/.test(selfId)
    && chats && typeof chats === "object" && !Array.isArray(chats)
    && Object.entries(chats).every(([key, entry]) => /^(private|group):\d+$/.test(key)
      && entry && typeof entry === "object" && typeof entry.initialized === "boolean"
      && ["partial", "complete"].includes(entry.status) && Number.isFinite(entry.lastSuccessAt)
      && (entry.anchor === null || (entry.anchor && isRemoteId(entry.anchor.id) && Number.isFinite(entry.anchor.time)))));
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

class HistorySync {
  constructor({ connection, statePath, getChats, captureAnchors, onIdentity, applyPage,
    onEvent = () => {}, options = {}, wait = pause }) {
    Object.assign(this, { connection, statePath, getChats, captureAnchors, onIdentity, applyPage, onEvent, wait });
    this.options = { ...SYNC_DEFAULTS, ...options };
    this.state = { version: 1, legacyAccountId: "", accounts: {} };
    this.stateWrites = Promise.resolve();
    this.anchors = new Map();
    this.tasks = new Map();
    this.results = new Map();
    this.queue = [];
    this.workers = 0;
    this.generation = 0;
    this.selfId = "";
    this.ready = false;
    this.abort = new AbortController();
  }

  async prepare() {
    let recover = false;
    try {
      const stored = JSON.parse(await fs.promises.readFile(this.statePath, "utf8"));
      if (!validState(stored)) throw new Error("invalid-state");
      this.state = stored;
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (!(error instanceof SyntaxError) && error.message !== "invalid-state") throw error;
        recover = true;
        await fs.promises.rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
        this.onEvent({ type: "warning", message: "同步状态损坏，已保留原文件；将重新初始化近期记录，旧历史完整性无法确认。" });
      }
    }
    this.recovering = recover;
    await this.prepareChats(this.getChats());
  }

  async prepareChats(chats) {
    for (const chat of chats) {
      const key = chatKey(chat);
      if (!this.anchors.has(key)) this.anchors.set(key, await this.captureAnchors(chat));
    }
  }

  persistState(change) {
    const task = this.stateWrites.catch(() => {}).then(async () => {
      const next = JSON.parse(JSON.stringify(this.state));
      change(next);
      await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temp = `${this.statePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await fs.promises.rename(temp, this.statePath);
      } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
      this.state = next;
    });
    this.stateWrites = task;
    return task;
  }

  entry(chat) {
    return this.state.accounts[this.selfId]?.[chatKey(chat)];
  }

  allowed(chat) {
    return this.getChats().some((item) => chatKey(item) === chatKey(chat));
  }

  disconnect() {
    this.ready = false;
    this.generation += 1;
    this.abort.abort();
    for (const task of this.queue.splice(0)) task.resolve({ status: "partial", added: 0 });
    this.tasks.clear();
  }

  async startSession() {
    this.disconnect();
    this.abort = new AbortController();
    const generation = this.generation;
    const response = await this.connection.send("get_login_info", {}, { timeoutMs: this.options.timeoutMs });
    if (generation !== this.generation) return;
    const selfId = String(response.data?.user_id || "");
    if (!/^\d+$/.test(selfId)) throw new Error("无法确认 NapCat 登录账号，历史同步未启动");
    await this.persistState((state) => {
      state.legacyAccountId ||= selfId;
      state.accounts[selfId] ||= {};
    });
    if (generation !== this.generation) return;
    this.selfId = selfId;
    await this.onIdentity(selfId, this.state.legacyAccountId);
    if (generation !== this.generation) return;
    this.results.clear();
    this.ready = true;
    // Resolve account setup before page ingestion joins the application's message queue.
    queueMicrotask(() => { if (generation === this.generation) this.requestAll(); });
    return selfId;
  }

  requestAll() {
    const chats = this.getChats();
    if (this.ready && chats.length) this.onEvent({ type: "start", count: chats.length });
    return Promise.all(chats.map((chat) => this.request(chat)));
  }

  request(chat, { fresh = false, priority = false } = {}) {
    const key = chatKey(chat);
    if (!this.ready || !this.allowed(chat)) return Promise.resolve({ status: "unavailable", added: 0 });
    const existing = this.tasks.get(key);
    if (existing) {
      if (priority && this.queue.includes(existing)) {
        this.queue.splice(this.queue.indexOf(existing), 1);
        this.queue.unshift(existing);
      }
      return existing.promise;
    }
    const entry = this.entry(chat);
    if (fresh && entry?.status === "complete" && Date.now() - entry.lastSuccessAt < this.options.freshnessMs) {
      return Promise.resolve({ status: "fresh", added: 0 });
    }
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const task = { chat: { ...chat }, generation: this.generation, selfId: this.selfId,
      signal: this.abort.signal, resolve, promise };
    this.tasks.set(key, task);
    if (priority) this.queue.unshift(task); else this.queue.push(task);
    this.pump();
    return promise;
  }

  pump() {
    while (this.workers < this.options.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this.workers += 1;
      this.run(task).catch(() => ({ status: "partial", added: 0 })).then((result) => {
        this.workers -= 1;
        const key = chatKey(task.chat);
        if (this.tasks.get(key) === task) this.tasks.delete(key);
        this.pump();
        task.resolve(result);
      });
    }
  }

  check(task) {
    if (task.generation !== this.generation || task.signal.aborted || !this.allowed(task.chat)) {
      throw new Error("同步已中断");
    }
  }

  async fetchPage(task, cursor) {
    const { chat } = task;
    const action = chat.chatType === "private" ? "get_friend_msg_history" : "get_group_msg_history";
    const params = {
      [chat.chatType === "private" ? "user_id" : "group_id"]: String(chat.targetId),
      message_seq: cursor, count: this.options.pageSize, reverse_order: true,
      disable_get_url: true, parse_mult_msg: false, quick_reply: true,
    };
    for (let attempt = 0; ; attempt += 1) {
      this.check(task);
      try {
        const response = await this.connection.send(action, params, { timeoutMs: this.options.timeoutMs });
        this.check(task);
        if (!Array.isArray(response.data?.messages)) throw Object.assign(new Error("历史接口返回格式无效"), { permanent: true });
        return response.data.messages;
      } catch (error) {
        this.check(task);
        // These actions report an empty first page as an error on some versions.
        if (cursor === "0" && /消息(?:0|undefined)?不存在/.test(error.message)) return [];
        const transientResponse = /timeout|超时|temporary|网络/i.test(error.message);
        if (error.permanent || (Number.isFinite(error.retcode) && !transientResponse)
          || attempt >= this.options.retryDelaysMs.length) throw error;
        await this.wait(this.options.retryDelaysMs[attempt], task.signal);
      }
    }
  }

  async run(task) {
    const { chat, selfId } = task;
    const key = chatKey(chat);
    let added = 0;
    let changed = false;
    try {
      this.check(task);
      if (!this.anchors.has(key)) await this.prepareChats([chat]);
      let entry = this.entry(chat);
      if (!entry) {
        const anchors = this.anchors.get(key) || {};
        const legacy = this.state.legacyAccountId === selfId ? anchors.legacy : null;
        const baseline = this.recovering ? null : anchors[selfId] || legacy || null;
        await this.persistState((state) => {
          state.accounts[selfId][key] = { anchor: baseline, initialized: Boolean(baseline), status: "partial", lastSuccessAt: 0 };
        });
        entry = this.entry(chat);
      }
      const boundary = entry.anchor?.id ? String(entry.anchor.id) : "";
      const bootstrap = !entry.initialized;
      await this.persistState((state) => { state.accounts[selfId][key].status = "partial"; });
      this.check(task);
      let cursor = "0";
      let head = null;
      let pages = 0;
      const seen = new Set();
      while (true) {
        const raw = await this.fetchPage(task, cursor);
        const page = raw.map((message) => {
          if (!message || !isRemoteId(message.message_id) || !(Number(message.time) > 0)) {
            throw new Error("历史消息缺少有效 ID 或原始时间");
          }
          return message;
        }).sort((a, b) => Number(a.time) - Number(b.time));
        if (cursor === "0") {
          const latest = page.at(-1);
          head = latest ? { id: String(latest.message_id), time: Number(latest.time) * 1000 } : null;
        }
        const reached = boundary && page.some((message) => String(message.message_id) === boundary);
        const unseen = page.filter((message) => !seen.has(String(message.message_id)));
        if (!page.length || !unseen.length) {
          if (boundary) throw new Error("未找到上次同步边界，NapCat 可提供的历史可能不完整");
          break;
        }
        this.check(task);
        const result = await this.applyPage(chat, page, selfId);
        added += result.added || 0;
        changed ||= Boolean(result.changed);
        this.check(task);
        page.forEach((message) => seen.add(String(message.message_id)));
        pages += 1;
        this.onEvent({ type: "progress", chat, added, pages });
        if (reached || bootstrap) break;
        cursor = String(page[0].message_id);
        if (pages % this.options.batchPages === 0) await this.wait(this.options.batchDelayMs, task.signal);
      }
      this.check(task);
      await this.persistState((state) => {
        state.accounts[selfId][key] = { anchor: head, initialized: true, status: "complete", lastSuccessAt: Date.now() };
      });
      this.check(task);
      const result = { status: "complete", added, changed };
      this.results.set(key, result);
      this.onEvent({ type: "complete", chat, ...result });
      return result;
    } catch (error) {
      if (task.generation === this.generation && this.allowed(chat)) {
        this.results.set(key, { status: "partial", added });
        await this.persistState((state) => {
          const entry = state.accounts[selfId]?.[key];
          if (entry) entry.status = "partial";
        }).catch(() => {});
        this.onEvent({ type: "partial", chat, added, changed, message: error.message });
      }
      return { status: "partial", added, changed };
    }
  }

  summary() {
    const entries = this.state.accounts[this.selfId] || {};
    const chats = this.getChats();
    const times = chats.map((chat) => entries[chatKey(chat)]?.lastSuccessAt || 0).filter(Boolean);
    return { running: this.tasks.size,
      partial: chats.filter((chat) => entries[chatKey(chat)]?.status === "partial").length,
      lastSuccessAt: times.length ? Math.max(...times) : 0 };
  }

  async stop() {
    const tasks = [...this.tasks.values()].map((task) => task.promise);
    this.disconnect();
    await Promise.all(tasks);
    await this.stateWrites.catch(() => {});
  }
}

module.exports = { HistorySync, SYNC_DEFAULTS };
