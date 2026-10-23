const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { QQlightApp, createMessageEvent } = require("../src/qqlight");
const { HistoryStore } = require("../src/history-store");

const SELF = "999001";
const GROUP = { chatType: "group", targetId: "123456" };
const PRIVATE = { chatType: "private", targetId: "654321" };
const START_TIME = 1780000000;

function raw(index, chat = GROUP, { outgoing = false, sameTime = false } = {}) {
  return {
    message_id: String(index * 7919 % 1000003),
    time: START_TIME + (sameTime ? 0 : index),
    message_type: chat.chatType,
    post_type: outgoing ? "message_sent" : "message",
    self_id: SELF,
    user_id: outgoing ? SELF : chat.chatType === "private" ? chat.targetId : "888001",
    ...(chat.chatType === "group" ? { group_id: chat.targetId } : {}),
    real_seq: chat.chatType === "group" && !sameTime ? String(index) : "0",
    sender: { user_id: outgoing ? SELF : chat.targetId, nickname: outgoing ? "自己" : "测试成员" },
    message: [{ type: "text", data: { text: `消息 ${index}` } }],
  };
}

function remoteMessages(count, chat = GROUP, options) {
  return Array.from({ length: count }, (_, index) => raw(index + 1, chat, options));
}

async function harness(t, { chats = [GROUP], data, dir, seed = [], pageSize = 3, selfId = SELF, beforeRequest } = {}) {
  dir ||= await fs.mkdtemp(path.join(os.tmpdir(), "qqlight-sync-test-"));
  const app = new QQlightApp({
    privateIds: chats.filter((chat) => chat.chatType === "private").map((chat) => chat.targetId),
    groupIds: chats.filter((chat) => chat.chatType === "group").map((chat) => chat.targetId),
    maxHistory: 20, syncPageSize: pageSize,
  });
  app.projectDir = dir;
  app.historyDir = path.join(dir, "history");
  app.imageDir = path.join(dir, "images");
  const printed = [];
  app.writeLine = (line) => printed.push(line);
  app.waitImpl = async () => {};
  const requests = [];
  const remote = data || new Map(chats.map((chat) => [chat.targetId, remoteMessages(8, chat)]));
  app.connection = {
    connected: true,
    async send(action, params, options) {
      requests.push({ action, params, options });
      if (action === "get_login_info") return { data: { user_id: selfId } };
      if (beforeRequest) await beforeRequest({ app, action, params, remote });
      const messages = remote.get(String(params.user_id || params.group_id)) || [];
      const end = params.message_seq === "0" ? messages.length
        : messages.findIndex((message) => String(message.message_id) === params.message_seq) + 1;
      if (end <= 0) throw Object.assign(new Error(`消息${params.message_seq}不存在`), { retcode: 1200 });
      return { data: { messages: messages.slice(Math.max(0, end - params.count), end) } };
    },
  };
  for (const [chat, payload] of seed) {
    await app.persistMessage(createMessageEvent(payload, { chat, selfId: String(payload.self_id) }));
  }
  await app.initializeHistorySync();
  app.historySync.wait = async () => {};
  t.after(async () => {
    await app.historySync.stop();
    await app.messageQueue.catch(() => {});
    await app.imageSaveQueue.catch(() => {});
    await app.getHistoryStore().flush().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, dir, remote, requests, printed, sync: app.historySync };
}

async function connect(h) {
  await h.sync.startSession();
  return h.sync.requestAll();
}

test("跨多页补齐超过内存上限的消息，批次上限不会截断同步", async (t) => {
  const messages = remoteMessages(135);
  const h = await harness(t, { seed: [[GROUP, messages[0]]], data: new Map([[GROUP.targetId, messages]]), pageSize: 10 });
  h.sync.options.batchPages = 2;
  let yields = 0;
  h.sync.wait = async () => { yields += 1; };
  const [result] = await connect(h);
  assert.equal(result.status, "complete");
  assert.equal(result.added, 134);
  const stored = await h.app.readChatHistory(GROUP, Infinity);
  assert.equal(stored.length, 135);
  assert.equal(h.app.getChatHistory(GROUP).length, 20);
  assert.deepEqual(stored.map((message) => message.text), messages.map((message) => message.message[0].data.text));
  assert.equal(h.sync.entry(GROUP).anchor.id, messages.at(-1).message_id);
  assert.ok(yields > 1);
});

test("补拉期间实时消息不会覆盖固定边界，也不会重复写入或跳过旧消息", async (t) => {
  const messages = remoteMessages(12);
  let injected = false;
  const h = await harness(t, {
    seed: [[GROUP, messages[0]]], data: new Map([[GROUP.targetId, messages]]),
    async beforeRequest({ app }) {
      if (injected) return;
      injected = true;
      await app.receiveMessage(createMessageEvent(messages.at(-1)));
      await app.receiveMessage(createMessageEvent(raw(13)));
    },
  });
  const [result] = await connect(h);
  assert.equal(result.status, "complete");
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 13);
  assert.equal(h.sync.entry(GROUP).anchor.id, raw(12).message_id);
  h.remote.get(GROUP.targetId).push(raw(13));
  await h.sync.request(GROUP);
  assert.equal(h.sync.entry(GROUP).anchor.id, raw(13).message_id);
});

test("中途接口失败保留旧边界，重启后从最新页补齐且不漏掉新增区间", async (t) => {
  const messages = remoteMessages(9);
  let fail = true;
  const h = await harness(t, {
    seed: [[GROUP, messages[0]]], data: new Map([[GROUP.targetId, messages]]),
    beforeRequest({ params }) {
      if (fail && params.message_seq !== "0") throw Object.assign(new Error("接口暂不可用"), { retcode: 1200 });
    },
  });
  assert.equal((await connect(h))[0].status, "partial");
  assert.equal(h.sync.entry(GROUP).anchor.id, messages[0].message_id);
  assert.equal(h.sync.entry(GROUP).status, "partial");
  fail = false;
  await h.sync.stop();
  const next = await harness(t, { dir: h.dir, data: new Map([[GROUP.targetId, remoteMessages(15)]]) });
  assert.equal((await connect(next))[0].status, "complete");
  assert.equal((await next.app.readChatHistory(GROUP, Infinity)).length, 15);
  assert.equal(next.sync.entry(GROUP).anchor.id, raw(15).message_id);
});

test("写入失败时不推进边界，重试可以补齐内存中已出现但未落盘的消息", async (t) => {
  const h = await harness(t, { seed: [[GROUP, raw(1)]] });
  const persist = h.app.persistMessage.bind(h.app);
  let fail = true;
  h.app.persistMessage = (message) => {
    if (fail && message.id === raw(7).message_id) throw Object.assign(new Error("disk-full"), { code: "ENOSPC" });
    return persist(message);
  };
  assert.equal((await connect(h))[0].status, "partial");
  assert.equal(h.sync.entry(GROUP).anchor.id, raw(1).message_id);
  fail = false;
  assert.equal((await h.sync.request(GROUP)).status, "complete");
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 8);
});

test("首次仅初始化最近一页，之后离线超过一页仍会完整补到原边界", async (t) => {
  const h = await harness(t);
  assert.equal((await connect(h))[0].added, 3);
  assert.deepEqual((await h.app.readChatHistory(GROUP, Infinity)).map((message) => message.text), ["消息 6", "消息 7", "消息 8"]);
  h.remote.set(GROUP.targetId, remoteMessages(20));
  assert.equal((await h.sync.request(GROUP)).added, 12);
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 15);
});

test("空会话初始化后第一批新消息超过一页也能全部读取", async (t) => {
  const h = await harness(t, { data: new Map() });
  assert.equal((await connect(h))[0].status, "complete");
  assert.equal(h.sync.entry(GROUP).anchor, null);
  h.remote.set(GROUP.targetId, remoteMessages(8));
  assert.equal((await h.sync.request(GROUP)).status, "complete");
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 8);
});

test("历史无法追溯到旧边界时报告缺口，不把反复返回的最后一页视为补齐", async (t) => {
  const h = await harness(t, {
    seed: [[GROUP, raw(1)]], data: new Map([[GROUP.targetId, remoteMessages(20).slice(10)]]),
  });
  assert.equal((await connect(h))[0].status, "partial");
  assert.equal(h.sync.entry(GROUP).anchor.id, raw(1).message_id);
  assert.ok(h.printed.some((line) => line.includes("未找到上次同步边界")));
  assert.ok(h.requests.length < 20);
});

test("私聊历史中自己发出的消息属于查询好友，保留原始时间并显示为发出", async (t) => {
  const messages = [raw(1, PRIVATE), raw(2, PRIVATE, { outgoing: true }), raw(3, PRIVATE)];
  const h = await harness(t, { chats: [PRIVATE], data: new Map([[PRIVATE.targetId, messages]]) });
  await connect(h);
  const stored = await h.app.readChatHistory(PRIVATE, Infinity);
  assert.equal(stored[1].direction, "outgoing");
  assert.equal(stored[1].targetId, PRIVATE.targetId);
  assert.equal(stored[1].time, messages[1].time * 1000);
  assert.equal(stored[1].selfId, SELF);
  assert.equal((await h.app.readChatHistory({ chatType: "private", targetId: SELF }, Infinity)).length, 0);
});

test("同秒且没有真实序号的消息，跨页补拉后仍保持接口中的先后顺序", async (t) => {
  const messages = remoteMessages(12, PRIVATE, { sameTime: true });
  const h = await harness(t, { chats: [PRIVATE], seed: [[PRIVATE, messages[0]]], data: new Map([[PRIVATE.targetId, messages]]) });
  await connect(h);
  assert.deepEqual((await h.app.readChatHistory(PRIVATE, Infinity)).map((message) => message.text), messages.map((message) => message.message[0].data.text));
});

test("重复同步使用磁盘索引去重，已有本地图片和原始时间不被覆盖", async (t) => {
  const messages = remoteMessages(8);
  const h = await harness(t, { seed: [[GROUP, messages[0]]] });
  const imagePath = path.join(h.app.imageDir, "saved.png");
  await fs.mkdir(h.app.imageDir);
  await fs.writeFile(imagePath, "image");
  await h.app.persistMessage({ ...createMessageEvent(messages[5]), imagePaths: [imagePath] });
  await connect(h);
  // The initial local tail is message 6; the older record is intentionally outside this sync interval.
  const before = await fs.readFile(h.app.getHistoryFilePath(GROUP.chatType, GROUP.targetId), "utf8");
  await h.sync.request(GROUP);
  const after = await fs.readFile(h.app.getHistoryFilePath(GROUP.chatType, GROUP.targetId), "utf8");
  assert.equal(after, before);
  const stored = await h.app.readChatHistory(GROUP, Infinity);
  assert.deepEqual(stored.find((message) => message.id === messages[5].message_id).imagePaths, [imagePath]);
  assert.equal(stored.at(-1).time, messages.at(-1).time * 1000);
});

test("不同账号的同步边界和新历史记录隔离，旧格式记录只归首次绑定账号", async (t) => {
  const h = await harness(t, { seed: [[GROUP, raw(1)]] });
  await connect(h);
  await h.sync.stop();
  const secondId = "999002";
  const data = remoteMessages(3).map((message) => ({ ...message, self_id: secondId }));
  const next = await harness(t, { dir: h.dir, selfId: secondId, data: new Map([[GROUP.targetId, data]]) });
  await connect(next);
  assert.equal((await next.app.readChatHistory(GROUP, Infinity)).length, 3);
  assert.ok(next.sync.state.accounts[SELF]);
  assert.ok(next.sync.state.accounts[secondId]);
  assert.equal(next.sync.state.legacyAccountId, SELF);
});

test("损坏的末行不会吞掉新写入记录，读取最近记录依据消息时间", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qqlight-store-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new HistoryStore({ historyDir: dir });
  const message = (index) => ({ id: String(index), chatType: "group", targetId: "1", direction: "incoming", text: String(index), time: index });
  await store.upsert(message(10));
  await fs.appendFile(store.filePath(message(10)), '{"id":');
  await store.upsert(message(1));
  await store.upsert(message(5));
  assert.deepEqual((await store.read(message(1), 2)).map((record) => record.id), ["5", "10"]);
});

test("任务合并并限制并发，单个聊天失败不影响其他聊天", async (t) => {
  let active = 0;
  let peak = 0;
  const chats = [GROUP, PRIVATE, { chatType: "group", targetId: "111222" }];
  const h = await harness(t, { chats, async beforeRequest({ params }) {
    active += 1;
    peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (params.group_id === GROUP.targetId) throw Object.assign(new Error("unsupported"), { retcode: 1404 });
  } });
  await h.sync.startSession();
  const first = h.sync.request(PRIVATE);
  assert.equal(h.sync.request(PRIVATE), first);
  const results = await h.sync.requestAll();
  assert.deepEqual(results.map((result) => result.status).sort(), ["complete", "complete", "partial"]);
  assert.ok(peak <= 2);
});

test("临时错误按策略重试，永久接口错误不重复请求", async (t) => {
  let calls = 0;
  const h = await harness(t, { beforeRequest() {
    calls += 1;
    if (calls <= 2) throw new Error("temporary-network-error");
  } });
  assert.equal((await connect(h))[0].status, "complete");
  assert.equal(calls, 3);
  h.app.config.groupIds = [];
  assert.equal((await h.sync.request(GROUP)).status, "unavailable");
});

test("同步状态提交失败时磁盘和内存边界均保持原值，重试不会跳过记录", async (t) => {
  const h = await harness(t, { seed: [[GROUP, raw(1)]] });
  const persist = h.sync.persistState.bind(h.sync);
  let fail = true;
  h.sync.persistState = (change) => persist((state) => {
    change(state);
    if (fail && state.accounts[SELF]?.[`group:${GROUP.targetId}`]?.status === "complete") throw new Error("state-write-failed");
  });
  assert.equal((await connect(h))[0].status, "partial");
  assert.equal(h.sync.entry(GROUP).anchor.id, raw(1).message_id);
  const diskState = JSON.parse(await fs.readFile(h.sync.statePath, "utf8"));
  assert.equal(diskState.accounts[SELF][`group:${GROUP.targetId}`].anchor.id, raw(1).message_id);
  fail = false;
  assert.equal((await h.sync.request(GROUP)).status, "complete");
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 8);
});

test("断线后旧响应不会推进状态，新连接仍能补齐固定边界之后的消息", async (t) => {
  let entered;
  let release;
  let block = true;
  const requestStarted = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, { seed: [[GROUP, raw(1)]], async beforeRequest() {
    if (!block) return;
    entered();
    await gate;
  } });
  await h.sync.startSession();
  const first = h.sync.request(GROUP);
  await requestStarted;
  h.sync.disconnect();
  block = false;
  release();
  assert.equal((await first).status, "partial");
  assert.equal(h.sync.entry(GROUP).anchor.id, raw(1).message_id);
  h.remote.set(GROUP.targetId, remoteMessages(12));
  assert.equal((await connect(h))[0].status, "complete");
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 12);
});

test("损坏状态保留备份并明确初始化近期记录，不从部分补存记录推断完整边界", async (t) => {
  const h = await harness(t, { seed: [[GROUP, raw(1)]] });
  await fs.writeFile(h.sync.statePath, '{"version":1,"accounts":');
  await h.sync.prepare();
  assert.equal((await connect(h))[0].status, "complete");
  assert.equal((await h.app.readChatHistory(GROUP, Infinity)).length, 4);
  assert.ok((await fs.readdir(h.dir)).some((name) => name.startsWith("sync-state.json.corrupt-")));
  assert.ok(h.printed.some((line) => line.includes("旧历史完整性无法确认")));
});

test("图片失败不阻塞同步边界，持久化引用可以在重启后的同步中补存", async (t) => {
  const image = { ...raw(8), message: [{ type: "image", data: { file: "opaque-image", url: "https://image.invalid/retry.png" } }] };
  const data = new Map([[GROUP.targetId, [...remoteMessages(7), image]]]);
  const h = await harness(t, { data });
  h.app.fetchImpl = async () => ({ ok: false, status: 403, body: { cancel: async () => {} } });
  assert.equal((await connect(h))[0].status, "complete");
  await h.app.imageSaveQueue;
  const failed = (await h.app.readChatHistory(GROUP, Infinity)).at(-1);
  assert.equal(failed.imageState, "failed");
  assert.equal(failed.imageSources.length, 1);
  await h.sync.stop();
  const next = await harness(t, { dir: h.dir, data });
  next.app.fetchImpl = async () => ({
    ok: true, headers: { get: (name) => name === "content-type" ? "image/png" : "5" },
    arrayBuffer: async () => Buffer.from("image"),
  });
  await connect(next);
  await next.app.imageSaveQueue;
  const saved = (await next.app.readChatHistory(GROUP, Infinity)).at(-1);
  assert.equal(saved.imageState, "saved");
  assert.equal(saved.imagePaths.length, 1);
  assert.equal(await fs.readFile(saved.imagePaths[0], "utf8"), "image");
});

test("真实 WebSocket 连接回调会自动确认账号并补拉，重连也会补拉", async (t) => {
  const h = await harness(t);
  await h.sync.stop();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const app = new QQlightApp({ napcatWsUrl: `ws://127.0.0.1:${server.address().port}`, groupIds: [GROUP.targetId] });
  Object.assign(app, { projectDir: h.dir, historyDir: h.app.historyDir, imageDir: h.app.imageDir });
  app.writeLine = () => {};
  let historyRequests = 0;
  server.on("connection", (socket) => socket.on("message", (bytes) => {
    const packet = JSON.parse(bytes);
    const data = packet.action === "get_login_info" ? { user_id: SELF } : { messages: [raw(1)] };
    if (packet.action === "get_group_msg_history") historyRequests += 1;
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: packet.echo }));
  }));
  t.after(async () => {
    app.connection.stop();
    await app.historySync?.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await app.initializeHistorySync();
  async function waitForComplete(expectedRequests) {
    const deadline = Date.now() + 3000;
    while (historyRequests < expectedRequests || app.historySync.summary().running || !app.historySync.ready) {
      if (Date.now() > deadline) throw new Error("websocket-sync-timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  app.connection.start();
  await waitForComplete(1);
  assert.equal((await app.readChatHistory(GROUP, Infinity)).length, 1);
  app.connection.reconnect();
  await waitForComplete(2);
  assert.equal((await app.readChatHistory(GROUP, Infinity)).length, 1);
});
