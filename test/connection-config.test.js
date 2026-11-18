const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { PassThrough, Writable } = require("node:stream");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const { QQlightApp, NapCatConnection } = require("../src/qqlight");
const { validateConnectionSettings, createConfigReadlineOutput } = require("../src/connection-config");

async function editorHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qqlight-config-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const app = new QQlightApp({
    napcatWsUrl: "ws://127.0.0.1:3001", accessToken: "old-private-token",
    privateIds: ["123456"], groupIds: ["654321"], maxFileSizeMb: 50,
  }, { configPath });
  await fs.writeFile(configPath, JSON.stringify(app.config));
  const printed = [];
  let reconnects = 0;
  app.writeLine = (message) => printed.push(message);
  app.promptInput = () => {};
  app.connection.reconnect = () => { reconnects += 1; };
  app.rl = { line: "", cursor: 0, history: ["status"], setPrompt() {}, prompt() {} };
  return { app, configPath, directory, printed, reconnects: () => reconnects };
}

test("TUI 保存连接地址和 Token，保留其他配置并立即重连", async (t) => {
  const h = await editorHarness(t);
  const reference = h.app.config;
  await h.app.runCommand("/config");
  await h.app.runCommand("wss://napcat.example.test:3001/onebot");
  await h.app.runCommand("new-private-token");
  assert.equal(h.app.config.accessToken, "old-private-token");
  assert.equal(h.reconnects(), 0);
  await h.app.runCommand("");

  assert.equal(h.app.connectionEditor, null);
  assert.equal(h.app.config, reference);
  assert.equal(h.app.connection.config, reference);
  assert.equal(h.reconnects(), 1);
  const stored = JSON.parse(await fs.readFile(h.configPath, "utf8"));
  assert.deepEqual(stored, {
    ...reference, napcatWsUrl: "wss://napcat.example.test:3001/onebot", accessToken: "new-private-token",
  });
  assert.deepEqual(h.app.rl.history, ["status"]);
  assert.doesNotMatch(h.printed.join("\n"), /old-private-token|new-private-token/);
  if (process.platform !== "win32") assert.equal((await fs.stat(h.configPath)).mode & 0o777, 0o600);
});

test("回车保留原值，也可以明确清空 Token", async (t) => {
  const h = await editorHarness(t);
  await h.app.runCommand("/config");
  await h.app.runCommand("");
  await h.app.runCommand("");
  await h.app.runCommand("yes");
  assert.equal(h.app.config.accessToken, "old-private-token");
  await h.app.runCommand("/config");
  await h.app.runCommand("");
  await h.app.runCommand("clear");
  await h.app.runCommand("y");
  assert.equal(h.app.config.accessToken, "");
  assert.equal(JSON.parse(await fs.readFile(h.configPath, "utf8")).accessToken, "");
  assert.equal(h.reconnects(), 2);
});

test("各步骤取消或 Ctrl+C 都丢弃草稿，不修改连接或落盘", async (t) => {
  const h = await editorHarness(t);
  const before = await fs.readFile(h.configPath, "utf8");
  for (const step of ["url", "token", "confirm"]) {
    for (const cancel of ["/cancel", "ctrl-c"]) {
      await h.app.runCommand("/config");
      if (step !== "url") await h.app.runCommand("ws://192.0.2.1:3002");
      if (step === "confirm") await h.app.runCommand("discard-this-token");
      if (cancel === "ctrl-c") {
        h.app.rl.line = "unfinished-secret";
        h.app.clearCurrentInput();
        assert.equal(h.app.rl.line, "");
      } else await h.app.runCommand(cancel);
      assert.equal(h.app.connectionEditor, null);
    }
  }
  await h.app.runCommand("/config");
  await h.app.runCommand("");
  await h.app.runCommand("");
  await h.app.runCommand("n");
  assert.equal(h.app.connectionEditor, null);
  assert.equal(h.reconnects(), 0);
  assert.equal(await fs.readFile(h.configPath, "utf8"), before);
  assert.doesNotMatch(h.printed.join("\n"), /discard-this-token|unfinished-secret/);
});

test("配置中的错误输入可重试，聊天中也不会将配置字段作为消息发送", async (t) => {
  const h = await editorHarness(t);
  h.app.activeChat = { chatType: "private", targetId: "123456" };
  h.app.sendToActiveChat = () => assert.fail("配置输入不应发送到聊天");
  await h.app.runCommand("/config");
  await h.app.runCommand("https://example.test");
  assert.equal(h.app.connectionEditor.step, "url");
  await h.app.runCommand("ws://example.test:3001");
  await h.app.runCommand("secret\nX-Injected: value");
  assert.equal(h.app.connectionEditor.step, "token");
  assert.doesNotMatch(h.printed.join("\n"), /X-Injected|secret/);
  await h.app.runCommand("quit");
  assert.equal(h.app.connectionEditor.step, "confirm");
  await h.app.runCommand("maybe");
  assert.equal(h.app.connectionEditor.step, "confirm");
  await h.app.runCommand("/cancel");
  assert.equal(h.app.exiting, false);
  assert.equal(h.reconnects(), 0);
});

test("保存失败时保留旧配置和连接，清理临时文件并允许再次保存", async (t) => {
  const h = await editorHarness(t);
  const before = { ...h.app.config };
  await h.app.runCommand("/config");
  await h.app.runCommand("ws://192.0.2.1:3002");
  await h.app.runCommand("retry-private-token");
  h.app.configPath = h.directory;
  await h.app.runCommand("y");
  assert.equal(h.app.connectionEditor.step, "confirm");
  assert.deepEqual(h.app.config, before);
  assert.equal(h.reconnects(), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(h.configPath, "utf8")), before);
  const siblings = await fs.readdir(path.dirname(h.directory));
  assert.equal(siblings.some((name) => name.startsWith(`${path.basename(h.directory)}.`)), false);
  h.app.configPath = h.configPath;
  await h.app.runCommand("y");
  assert.equal(h.app.config.accessToken, "retry-private-token");
  assert.equal(h.reconnects(), 1);
});

test("取消后，排队中的 Token 不会作为聊天消息执行", async (t) => {
  const h = await editorHarness(t);
  h.app.activeChat = { chatType: "private", targetId: "123456" };
  h.app.sendToActiveChat = () => assert.fail("已取消的 Token 不应发送到聊天");
  await h.app.runCommand("/config");
  await h.app.runCommand("");
  let release;
  h.app.commandQueue = new Promise((resolve) => { release = resolve; });
  h.app.submittedLineBatch = ["queued-private-token"];
  h.app.clearSubmittedInput = () => {};
  h.app.flushSubmittedLines();
  h.app.clearCurrentInput();
  release();
  await h.app.commandQueue;
  assert.doesNotMatch(h.printed.join("\n"), /queued-private-token/);
});

test("Token 输入不通过 readline 回显，窗口大小仍传递给 readline", async () => {
  const chunks = [];
  const terminal = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  Object.assign(terminal, { isTTY: true, columns: 80, rows: 24 });
  let secret = false;
  const output = createConfigReadlineOutput(terminal, () => secret);
  const input = new PassThrough();
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    rl.write("visible-address");
    assert.match(chunks.join(""), /visible-address/);
    secret = true;
    rl.write("never-echo-this-token");
    rl.prompt(true);
    assert.doesNotMatch(chunks.join(""), /never-echo/);
    assert.equal(output.columns, 80);
    const resized = once(output, "resize");
    terminal.columns = 100;
    terminal.emit("resize");
    await resized;
    assert.equal(output.columns, 100);
  } finally {
    rl.close();
    const closed = once(output, "close");
    output.destroy();
    await closed;
    assert.equal(terminal.listenerCount("resize"), 0);
  }
});

test("拒绝错误协议、片段、非法端口和不适合 HTTP 认证的 Token", () => {
  for (const napcatWsUrl of ["", "http://localhost", "ws://localhost:99999", "ws://localhost/#", "ws://local\thost"]) {
    assert.throws(() => validateConnectionSettings({ napcatWsUrl, accessToken: "" }), /WebSocket 地址/);
  }
  for (const accessToken of ["a\r\nb", "中文Token", "\u0000"]) {
    assert.throws(() => validateConnectionSettings({ napcatWsUrl: "ws://localhost", accessToken }), /Token/);
  }
});

async function websocketServer(t) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("保存后使用新地址和 Token 建立真实 WebSocket 连接，并取消旧请求", { timeout: 5000 }, async (t) => {
  const h = await editorHarness(t);
  const first = await websocketServer(t);
  const second = await websocketServer(t);
  const connection = new NapCatConnection(h.app.config, {
    onStatus() {}, onMessage() {}, onLog() {},
  });
  t.after(() => connection.stop());
  h.app.connection = connection;
  h.app.config.napcatWsUrl = `ws://127.0.0.1:${first.address().port}`;
  const initial = once(first, "connection");
  connection.start();
  await initial;
  if (!connection.connected) await once(connection.socket, "open");
  const rejected = assert.rejects(connection.send("get_login_info", {}), /正在重连/);
  const next = once(second, "connection");
  await h.app.runCommand("/config");
  await h.app.runCommand(`ws://127.0.0.1:${second.address().port}/onebot`);
  await h.app.runCommand("actual-new-token");
  await h.app.runCommand("y");
  const [, request] = await next;
  await rejected;
  assert.equal(request.url, "/onebot");
  assert.equal(request.headers.authorization, "Bearer actual-new-token");
  assert.equal(request.headers["x-access-token"], "actual-new-token");
  assert.doesNotMatch(h.printed.join("\n"), /actual-new-token/);
});

test("连接尚未建立时修改设置也能安全重连，并清除退避计时器", { timeout: 5000 }, async (t) => {
  const server = await websocketServer(t);
  const connection = new NapCatConnection({ napcatWsUrl: `ws://127.0.0.1:${server.address().port}`, accessToken: "" }, {
    onStatus() {}, onMessage() {}, onLog() {},
  });
  t.after(() => connection.stop());
  connection.start();
  const previous = connection.socket;
  connection.reconnectDelay = 10000;
  connection.reconnectTimer = setTimeout(() => assert.fail("旧的重连计时器不应继续运行"), 1000);
  const opened = once(server, "connection");
  connection.reconnect();
  await opened;
  if (!connection.connected) await once(connection.socket, "open");
  assert.notEqual(connection.socket, previous);
  assert.equal(connection.connected, true);
  assert.equal(connection.reconnectTimer, null);
  assert.equal(connection.reconnectDelay, 1000);
});

test("无效的初始连接配置保留可用的配置入口", async (t) => {
  const h = await editorHarness(t);
  h.app.config.napcatWsUrl = "https://invalid.test";
  const statuses = [];
  h.app.connection.onStatus = (status, detail) => statuses.push(detail);
  h.app.connection.start();
  assert.equal(h.app.connection.state, "error");
  assert.match(statuses.join("\n"), /\/config/);
  await h.app.runCommand("/config");
  assert.equal(h.app.connectionEditor.step, "url");
});
