const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");

function chatKey(chat) {
  if (!chat || !["private", "group"].includes(chat.chatType) || !/^\d+$/.test(String(chat.targetId))) {
    throw new Error("无法确定聊天记录文件");
  }
  return `${chat.chatType}:${chat.targetId}`;
}

function isRemoteId(id) {
  return /^-?\d+$/.test(String(id));
}

function compareMessages(left, right) {
  const time = (Number(left.time) || 0) - (Number(right.time) || 0);
  if (time) return time;
  if (/^[1-9]\d*$/.test(String(left.realSeq)) && /^[1-9]\d*$/.test(String(right.realSeq))) {
    const a = BigInt(left.realSeq);
    const b = BigInt(right.realSeq);
    if (a !== b) return a < b ? -1 : 1;
  }
  if (Number.isFinite(left.historyOrder) && Number.isFinite(right.historyOrder)) {
    const order = left.historyOrder - right.historyOrder;
    if (order) return order;
  }
  return (Number(left.receivedAt) || 0) - (Number(right.receivedAt) || 0);
}

function mergeRecord(previous, next) {
  if (!previous) return { ...next };
  const merged = { ...previous, ...next };
  merged.receivedAt = previous.receivedAt || next.receivedAt;
  if (previous.serverTime && !next.serverTime) {
    merged.time = previous.time;
    merged.serverTime = true;
    merged.realSeq = previous.realSeq;
    merged.historyOrder = previous.historyOrder;
  }
  if (previous.imagePaths?.length && !next.imagePaths?.length
    && !["pending", "failed"].includes(next.imageState)) {
    merged.imagePaths = previous.imagePaths;
    merged.imageState = "saved";
  }
  if (!next.imageSources?.length && previous.imageSources?.length && !merged.imagePaths?.length) {
    merged.imageSources = previous.imageSources;
  }
  return merged;
}

function fingerprint(record) {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

// Keep IDs and merge metadata in memory, rather than retaining every message body.
function metadata(record) {
  const { time, receivedAt, serverTime, realSeq, historyOrder, selfId, imagePaths, imageState } = record;
  return { time, receivedAt, serverTime, realSeq, historyOrder, selfId, imagePaths, imageState,
    hash: fingerprint(record) };
}

class HistoryStore {
  constructor({ historyDir, serialize = (message) => message }) {
    this.historyDir = historyDir;
    this.serialize = serialize;
    this.selfId = "";
    this.legacyAccountId = "";
    this.writeQueues = new Map();
    this.indexes = new Map();
    this.indexLoads = new Map();
    this.accountRevision = 0;
  }

  setAccount(selfId, legacyAccountId = selfId) {
    if (this.selfId !== String(selfId)) {
      this.indexes.clear();
      this.indexLoads.clear();
      this.accountRevision += 1;
    }
    this.selfId = String(selfId || "");
    this.legacyAccountId = String(legacyAccountId || "");
  }

  accepts(record, selfId = this.selfId, legacyAccountId = this.legacyAccountId) {
    if (!selfId) return true;
    return record.selfId
      ? String(record.selfId) === selfId
      : !legacyAccountId || legacyAccountId === selfId;
  }

  filePath(chat) {
    chatKey(chat);
    return path.join(this.historyDir, `${chat.chatType}-${chat.targetId}.jsonl`);
  }

  async scan(chat, { allAccounts = false } = {}) {
    const stream = fs.createReadStream(this.filePath(chat), { encoding: "utf8" });
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const records = new Map();
    const { selfId, legacyAccountId } = this;
    try {
      for await (const line of input) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || record.id === undefined || record.id === null || typeof record.text !== "string"
          || !["incoming", "outgoing"].includes(record.direction)
          || record.chatType !== chat.chatType || String(record.targetId) !== String(chat.targetId)) continue;
        if (!allAccounts && !this.accepts(record, selfId, legacyAccountId)) continue;
        record.id = String(record.id);
        const key = allAccounts ? `${record.selfId || "legacy"}:${record.id}` : record.id;
        records.set(key, mergeRecord(records.get(key), record));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      input.close();
      stream.destroy();
    }
    return [...records.values()].sort(compareMessages);
  }

  async captureAnchors(chat) {
    const records = await this.scan(chat, { allAccounts: true });
    const anchors = {};
    for (const record of records) {
      if (isRemoteId(record.id) && record.deliveryStatus !== "failed") {
        anchors[record.selfId || "legacy"] = { id: record.id, time: Number(record.time) || 0 };
      }
    }
    return anchors;
  }

  async ensureIndex(chat) {
    const key = chatKey(chat);
    if (this.indexes.has(key)) return this.indexes.get(key);
    if (this.indexLoads.has(key)) return this.indexLoads.get(key);
    const revision = this.accountRevision;
    const load = this.scan(chat).then((records) => {
      if (revision !== this.accountRevision) throw new Error("历史账号已切换");
      const index = new Map(records.map((record) => [record.id, metadata(record)]));
      this.indexes.set(key, index);
      return index;
    });
    this.indexLoads.set(key, load);
    try { return await load; } finally { if (this.indexLoads.get(key) === load) this.indexLoads.delete(key); }
  }

  async read(chat, limit = 20) {
    await (this.writeQueues.get(chatKey(chat)) || Promise.resolve()).catch(() => {});
    const revision = this.accountRevision;
    const records = await this.scan(chat);
    if (revision !== this.accountRevision) throw new Error("历史账号已切换");
    if (!this.indexes.has(chatKey(chat))) {
      this.indexes.set(chatKey(chat), new Map(records.map((record) => [record.id, metadata(record)])));
    }
    return Number.isFinite(limit) ? records.slice(-Math.max(1, limit)) : records;
  }

  upsert(message) {
    const key = chatKey(message);
    const previousTask = this.writeQueues.get(key) || Promise.resolve();
    const task = previousTask.catch(() => {}).then(async () => {
      if (!this.accepts(message)) throw new Error("消息账号与当前历史账号不一致");
      const index = await this.ensureIndex(message);
      const previous = index.get(String(message.id));
      const merged = mergeRecord(previous, message);
      delete merged.hash;
      const record = this.serialize(merged);
      if (previous?.hash === fingerprint(record)) return { added: false, changed: false, record };
      await fs.promises.mkdir(this.historyDir, { recursive: true, mode: 0o700 });
      const filePath = this.filePath(message);
      // A killed process may leave a partial final line. Separate the next record
      // so that one damaged line cannot swallow a successfully written message.
      const file = await fs.promises.open(filePath, "a+", 0o600);
      try {
        const stat = await file.stat();
        let prefix = "";
        if (stat.size) {
          const last = Buffer.alloc(1);
          await file.read(last, 0, 1, stat.size - 1);
          if (last[0] !== 10) prefix = "\n";
        }
        await file.writeFile(`${prefix}${JSON.stringify(record)}\n`, "utf8");
        await file.chmod(0o600);
      } finally { await file.close(); }
      index.set(String(message.id), metadata(record));
      return { added: !previous, changed: true, record };
    });
    this.writeQueues.set(key, task);
    return task;
  }

  async flush() {
    await Promise.all([...this.writeQueues.values()]);
  }
}

module.exports = { HistoryStore, chatKey, compareMessages, mergeRecord, isRemoteId };
