const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const { WebSocketServer } = require("ws");
const { QQlightApp, NapCatConnection, createMessageEvent, createFileNoticeEvent } = require("../src/qqlight");
const { FileTransfer, normalizeFileSource, safeFileName, resolveSendFilePath, formatFileError } = require("../src/file-transfer");

const CHAT = { chatType: "private", targetId: "123456" };

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qqlight-test-files-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function reply(socket, request, data, extra = {}) {
  socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data, ...extra }));
}

function streamFile(socket, request, bytes, name = "附件.pdf") {
  reply(socket, request, { type: "stream", data_type: "file_info", file_size: bytes.length, file_name: name });
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536);
    reply(socket, request, { type: "stream", data_type: "file_chunk", index: index++, size: chunk.length, data: chunk.toString("base64") });
  }
  reply(socket, request, { type: "response", data_type: "file_complete", total_chunks: index, total_bytes: bytes.length });
}

async function websocket(t, handler, callbacks = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => socket.on("message", (raw) => handler(socket, JSON.parse(raw))));
  const connection = new NapCatConnection({
    napcatWsUrl: `ws://127.0.0.1:${server.address().port}`, privateIds: [CHAT.targetId], groupIds: ["987654"],
  }, { onStatus() {}, onMessage() {}, onLog() {}, ...callbacks });
  t.after(async () => {
    connection.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  connection.start();
  await once(connection.socket, "open");
  return { connection, server };
}

async function application(t, directory) {
  const app = new QQlightApp({ privateIds: [CHAT.targetId], groupIds: ["987654"] });
  app.projectDir = directory || await temporaryDirectory(t);
  app.fileDir = path.join(app.projectDir, "files");
  app.historyDir = path.join(app.projectDir, "history");
  app.imageDir = path.join(app.projectDir, "images");
  app.output = [];
  app.writeLine = (line) => app.output.push(line);
  t.after(async () => {
    app.fileTransferControllers.forEach((controller) => controller.abort());
    await app.fileSaveQueue;
    await app.getHistoryStore().flush();
  });
  return app;
}

function message(id = "100", data = { file: "报告.pdf", file_id: "opaque-id", file_size: 9 }, chat = CHAT) {
  return createMessageEvent({
    post_type: "message", message_type: chat.chatType, user_id: chat.targetId,
    ...(chat.chatType === "group" ? { group_id: chat.targetId } : {}),
    message_id: id, sender: { nickname: "测试用户" }, message: [{ type: "file", data }],
  });
}

function response(bytes, { status = 200, length = bytes.length } = {}) {
  return {
    ok: status === 200, status,
    headers: { get: (key) => key === "content-length" && length !== null ? String(length) : null },
    body: { async *[Symbol.asyncIterator]() { yield bytes; }, cancel: async () => {} },
  };
}

test("数组与 CQ 文件消息都保留名称、大小和文件 ID", () => {
  const array = message("1", { file: "计划,终稿.pdf", file_id: "opaque-id", file_size: "2048", busid: 102 });
  assert.equal(array.text, "[文件] 计划,终稿.pdf（2.0 KiB）");
  assert.equal(array.files[0].fileId, "opaque-id");
  assert.equal(array.files[0].size, 2048);
  assert.equal(array.files[0].busId, 102);
  const cq = createMessageEvent({
    post_type: "message", message_type: "private", user_id: CHAT.targetId,
    message: "说明[CQ:file,file=计划&#44;终稿.pdf,file_id=opaque-id,file_size=2048,url=https://private.invalid/a?x=1&amp;y=2]",
  });
  assert.equal(cq.text, "说明[文件] 计划,终稿.pdf（2.0 KiB）");
  assert.equal(cq.files[0].url, "https://private.invalid/a?x=1&y=2");
});

test("群上传和离线文件通知沿用聊天白名单", async (t) => {
  const received = [];
  const { connection } = await websocket(t, () => {}, { onMessage: (event) => received.push(event) });
  const notice = { post_type: "notice", notice_type: "group_upload", group_id: "987654", user_id: "456789", file: { id: "group-file", name: "表格.xlsx", size: 100, busid: 102 } };
  connection.handlePacket(JSON.stringify(notice));
  connection.handlePacket(JSON.stringify({ ...notice, group_id: "111111" }));
  connection.handlePacket(JSON.stringify({ post_type: "notice", notice_type: "offline_file", user_id: CHAT.targetId, file: { id: "private-file", name: "录音.mp3", size: 80, url: "https://private.invalid/file" } }));
  assert.equal(received.length, 2);
  assert.equal(received[0].chatType, "group");
  assert.equal(received[0].files[0].fileId, "group-file");
  assert.equal(received[1].chatType, "private");
  assert.equal(received[1].files[0].name, "录音.mp3");
  assert.equal(createFileNoticeEvent({ post_type: "notice", notice_type: "group_increase" }), null);
});

test("常见文档、压缩包和媒体以原始二进制收取，重名文件不覆盖", async (t) => {
  const directory = await temporaryDirectory(t);
  const bytes = Buffer.from(Array.from({ length: 140000 }, (_, index) => index % 256));
  const requested = [];
  const { connection } = await websocket(t, (socket, request) => {
    requested.push(request.params.file);
    streamFile(socket, request, bytes);
  });
  const transfer = new FileTransfer({ connection });
  const extensions = ["txt", "md", "pdf", "docx", "xlsx", "pptx", "zip", "7z", "rar", "jpg", "png", "mp3", "wav", "mp4", "mkv"];
  for (const extension of extensions) {
    const source = normalizeFileSource({ file: `附件.${extension}`, file_id: `id-${extension}`, file_size: bytes.length });
    const saved = await transfer.save(source, directory, { chat: CHAT });
    assert.equal(path.basename(saved.path), `附件.${extension}`);
    assert.deepEqual(await fs.readFile(saved.path), bytes);
    assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
  }
  const again = await transfer.save(normalizeFileSource({ name: "附件.pdf", file_id: "second-pdf" }), directory);
  assert.equal(path.basename(again.path), "附件.pdf");
  assert.equal((await fs.readdir(directory)).length, extensions.length + 1);
  assert.equal(requested[0], "id-txt");
  assert.equal(connection.pending.size, 0);
});

test("没有文件名时使用 NapCat 名称，空文件也可以完整接收", async (t) => {
  const directory = await temporaryDirectory(t);
  const { connection } = await websocket(t, (socket, request) => streamFile(socket, request, Buffer.alloc(0), "空白.txt"));
  const saved = await new FileTransfer({ connection }).save(normalizeFileSource({ file_id: "empty-id", file_size: 0 }), directory);
  assert.equal(path.basename(saved.path), "空白.txt");
  assert.equal((await fs.stat(saved.path)).size, 0);
});

test("后台保存文件不阻塞消息，并显示保存文件夹和完整路径，重启后仍可查看", async (t) => {
  const app = await application(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  app.fetchImpl = async () => { await gate; return response(Buffer.from("pdf-bytes")); };
  await app.receiveMessage(message("1", { file: "报告.pdf", url: "https://private.invalid/file", file_size: 9 }));
  await app.receiveMessage({ ...message("2"), text: "后续消息", files: [] });
  assert.equal(app.getChatHistory(CHAT).length, 2);
  assert.match(app.output[0], /正在后台保存/);
  release();
  await app.fileSaveQueue;
  const file = app.getChatHistory(CHAT)[0].files[0];
  assert.equal(await fs.readFile(file.path, "utf8"), "pdf-bytes");
  assert.ok(app.output.some((line) => line.includes(`保存文件夹：${path.dirname(file.path)}`) && line.includes(`文件路径：${file.path}`)));
  const restarted = await application(t, app.projectDir);
  const history = await restarted.readChatHistory(CHAT);
  assert.equal(history[0].files[0].path, file.path);
  assert.match(restarted.renderMessage(history[0]), /保存文件夹：/);
  const raw = await fs.readFile(app.getHistoryFilePath("private", CHAT.targetId), "utf8");
  assert.ok(JSON.parse(raw.trim().split("\n").at(-1)).files[0].path.startsWith("files/"));
});

test("同步同一文件以及收到重复通知时复用已保存文件", async (t) => {
  const app = await application(t);
  let downloads = 0;
  app.fetchImpl = async () => { downloads += 1; return response(Buffer.from("pdf-bytes")); };
  const data = { file: "报告.pdf", file_id: "same-file", url: "https://private.invalid/file", file_size: 9 };
  await app.receiveMessage(message("1", data));
  await app.fileSaveQueue;
  const filePath = app.getChatHistory(CHAT)[0].files[0].path;
  await app.receiveMessage(message("1", data), { historical: true });
  await app.receiveMessage(message("file-notice-id", data));
  await app.fileSaveQueue;
  assert.equal(downloads, 1);
  assert.equal(app.getChatHistory(CHAT)[1].files[0].path, filePath);
  const restarted = await application(t, app.projectDir);
  restarted.fetchImpl = async () => assert.fail("已保存的文件不应重新下载");
  await restarted.receiveMessage(message("1", data), { historical: true });
  await restarted.fileSaveQueue;
  assert.equal(restarted.getChatHistory(CHAT)[0].files[0].path, filePath);
});

test("下载期间补同步替换消息对象，完成后的路径仍写回最新历史", async (t) => {
  const app = await application(t);
  let started;
  let release;
  const downloadStarted = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  app.fetchImpl = async () => { started(); await gate; return response(Buffer.from("pdf-bytes")); };
  const data = { name: "报告.pdf", file_id: "racing-id", url: "https://private.invalid/old", size: 9 };
  await app.receiveMessage(message("1", data));
  await downloadStarted;
  await app.receiveMessage(message("1", { ...data, url: "https://private.invalid/new" }), { historical: true });
  release();
  await app.fileSaveQueue;
  const [record] = await app.readChatHistory(CHAT);
  assert.equal(record.files[0].state, "saved");
  assert.equal(record.files[0].url, "https://private.invalid/new");
  assert.equal(await fs.readFile(record.files[0].path, "utf8"), "pdf-bytes");
});

test("一条消息多个文件独立保存，重试失败附件不会重新下载成功附件", async (t) => {
  const app = await application(t);
  app.connection.send = async () => { throw new Error("unsupported"); };
  const downloads = [];
  let fail = true;
  app.fetchImpl = async (url) => {
    downloads.push(url);
    if (url.endsWith("first") && fail) return response(Buffer.alloc(0), { status: 404 });
    return response(Buffer.from("pdf-bytes"));
  };
  const event = message("1");
  event.files = ["first", "second"].map((id) => ({ ...normalizeFileSource({ name: `${id}.pdf`, file_id: id, url: `https://private.invalid/${id}`, size: 9 }), state: "pending" }));
  await app.receiveMessage(event);
  await app.fileSaveQueue;
  let [record] = await app.readChatHistory(CHAT);
  assert.deepEqual(record.files.map((file) => file.state), ["failed", "saved"]);
  const secondPath = record.files[1].path;
  fail = false;
  await app.receiveMessage({ ...event, files: event.files.map((file) => ({ ...file, state: "pending", path: "" })) }, { historical: true });
  await app.fileSaveQueue;
  [record] = await app.readChatHistory(CHAT);
  assert.deepEqual(record.files.map((file) => file.state), ["saved", "saved"]);
  assert.equal(record.files[1].path, secondPath);
  assert.equal(downloads.filter((url) => url.endsWith("second")).length, 1);
});

test("本地副本删除后重新加载聊天可自动补存，隔离会话不显示其他聊天文件提示", async (t) => {
  const app = await application(t);
  app.activeChat = { chatType: "group", targetId: "987654" };
  let downloads = 0;
  app.fetchImpl = async () => { downloads += 1; return response(Buffer.from("pdf-bytes")); };
  await app.receiveMessage(message("1", { name: "报告.pdf", file_id: "deleted-id", url: "https://private.invalid/file", size: 9 }));
  await app.fileSaveQueue;
  assert.equal(app.output.length, 0);
  const original = app.getChatHistory(CHAT)[0].files[0].path;
  await fs.unlink(original);
  const restarted = await application(t, app.projectDir);
  restarted.fetchImpl = app.fetchImpl;
  restarted.connection = { connected: true };
  restarted.activeChat = CHAT;
  await restarted.loadChatHistory(CHAT, restarted.chatRevision, { display: false });
  await restarted.fileSaveQueue;
  const [record] = await restarted.readChatHistory(CHAT);
  assert.equal(downloads, 2);
  assert.equal(record.files[0].state, "saved");
  assert.notEqual(record.files[0].path, original);
  assert.equal(await fs.readFile(record.files[0].path, "utf8"), "pdf-bytes");
});

test("过期链接和残缺下载可切换来源，备用文件从起点写入", async (t) => {
  const directory = await temporaryDirectory(t);
  const requests = [];
  const transfer = new FileTransfer({
    connection: { async send(action, params) {
      requests.push([action, params]);
      if (action === "download_file_stream") throw new Error("unsupported action");
      return { data: { url: "https://private.invalid/fresh" } };
    } },
    request: async (url) => url.endsWith("expired")
      ? response(Buffer.from("long-broken-download"), { length: 100 })
      : response(Buffer.from("valid-pdf")),
  });
  const saved = await transfer.save(normalizeFileSource({ name: "报告.pdf", file_id: "opaque-id", url: "https://private.invalid/expired", size: 9, busid: 102 }), directory, { chat: { chatType: "group", targetId: "987654" } });
  assert.equal(await fs.readFile(saved.path, "utf8"), "valid-pdf");
  assert.deepEqual(requests[1], ["get_group_file_url", { file_id: "opaque-id", group_id: 987654, busid: 102 }]);
});

test("旧版 NapCat 可通过 get_file 的 Base64 或同机路径接收", async (t) => {
  const directory = await temporaryDirectory(t);
  const localPath = path.join(directory, "napcat-cache.zip");
  await fs.writeFile(localPath, "zip-bytes");
  for (const data of [{ base64: Buffer.from("zip-bytes").toString("base64") }, { file: localPath }]) {
    const transfer = new FileTransfer({ connection: {
      async send(action) { if (action !== "get_file") throw new Error("unsupported"); return { data }; },
    } });
    const saved = await transfer.save(normalizeFileSource({ name: "附件.zip", file_id: "legacy-id" }), path.join(directory, "received"), { chat: CHAT });
    assert.equal(await fs.readFile(saved.path, "utf8"), "zip-bytes");
  }
});

test("保存失败记录可重试，后续消息和文件继续处理", async (t) => {
  const app = await application(t);
  app.fetchImpl = async () => response(Buffer.alloc(0), { status: 404 });
  app.connection.send = async () => { throw new Error("secret https://private.invalid/token"); };
  await app.receiveMessage(message("1", { name: "报告.pdf", file_id: "retry-id", url: "https://private.invalid/expired" }));
  await app.fileSaveQueue;
  assert.equal(app.getChatHistory(CHAT)[0].files[0].state, "failed");
  assert.match(app.output.join("\n"), /保存失败：下载文件失败：HTTP 404/);
  assert.doesNotMatch(app.output.join("\n"), /private\.invalid|token/);
  app.fetchImpl = async () => response(Buffer.from("valid-pdf"));
  await app.receiveMessage(message("2", { name: "附件.zip", url: "https://private.invalid/good" }));
  await app.receiveMessage(message("1", { name: "报告.pdf", file_id: "retry-id", url: "https://private.invalid/fresh" }), { historical: true });
  await app.fileSaveQueue;
  assert.ok(app.getChatHistory(CHAT).every((event) => event.files[0].state === "saved"));
});

test("缺片、乱序、无效 Base64、超限和断线都不留下已完成文件", async (t) => {
  const cases = ["missing", "out-of-order", "bad-base64", "too-large", "disconnect"];
  for (const scenario of cases) await t.test(scenario, async (t) => {
    const directory = await temporaryDirectory(t);
    const { connection } = await websocket(t, (socket, request) => {
      if (request.action !== "download_file_stream") return reply(socket, request, null, { status: "failed", retcode: 1404 });
      reply(socket, request, { type: "stream", data_type: "file_info", file_size: scenario === "too-large" ? 1025 : 3 });
      if (scenario === "disconnect") return socket.close();
      if (scenario === "too-large") return;
      if (scenario !== "missing") reply(socket, request, {
        type: "stream", data_type: "file_chunk", index: scenario === "out-of-order" ? 1 : 0,
        size: 3, data: scenario === "bad-base64" ? "%%%%" : "cGRm",
      });
      reply(socket, request, { type: "response", data_type: "file_complete", total_chunks: 1, total_bytes: 3 });
    });
    const transfer = new FileTransfer({ connection, maxBytes: 1024 });
    await assert.rejects(transfer.save(normalizeFileSource({ file_id: "broken-id", name: "报告.pdf" }), directory, { chat: CHAT }));
    assert.deepEqual(await fs.readdir(directory), []);
    assert.equal(connection.pending.size, 0);
  });
});

test("HTTP 收取按流写入并检查无 Content-Length 时的大小上限", async (t) => {
  const directory = await temporaryDirectory(t);
  const server = http.createServer((_req, res) => { res.write(Buffer.alloc(800)); res.end(Buffer.alloc(800)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const transfer = new FileTransfer({ connection: { send: async () => assert.fail("超限不应尝试其他来源") }, maxBytes: 1024 });
  await assert.rejects(transfer.save(normalizeFileSource({ name: "大文件.zip", url: `http://127.0.0.1:${server.address().port}/file` }), directory), /超过/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("取消文件接收会清理部分文件和待响应请求", async (t) => {
  const directory = await temporaryDirectory(t);
  const controller = new AbortController();
  const { connection } = await websocket(t, (socket, request) => {
    reply(socket, request, { type: "stream", data_type: "file_info", file_size: 3 });
    controller.abort();
  });
  const transfer = new FileTransfer({ connection });
  await assert.rejects(transfer.save(normalizeFileSource({ name: "附件.pdf", file_id: "cancel-id" }), directory, { signal: controller.signal }), /abort/i);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(connection.pending.size, 0);
});

test("私聊和群聊通过真实 WebSocket 分块上传，校验后使用 NapCat 路径发送", async (t) => {
  for (const chat of [CHAT, { chatType: "group", targetId: "987654" }]) await t.test(chat.chatType, async (t) => {
    const app = await application(t);
    const filePath = path.join(app.projectDir, "带 空格的文档.pdf");
    const bytes = Buffer.from(Array.from({ length: 150000 }, (_, index) => index % 256));
    await fs.writeFile(filePath, bytes);
    const chunks = [];
    const requests = [];
    const { connection } = await websocket(t, (socket, request) => {
      requests.push(request);
      const params = request.params;
      if (request.action === "upload_file_stream") {
        if (params.is_complete) {
          assert.deepEqual(Buffer.concat(chunks), bytes);
          return reply(socket, request, {
            type: "response", status: "file_complete", stream_id: params.stream_id,
            file_path: "/napcat/remote-only/document.pdf", file_size: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          });
        }
        chunks.push(Buffer.from(params.chunk_data, "base64"));
        assert.equal(params.chunk_index, chunks.length - 1);
        assert.ok(params.filename.endsWith("带 空格的文档.pdf"));
        reply(socket, request, { type: "stream", stream_id: params.stream_id, status: "chunk_received", received_chunks: chunks.length, total_chunks: params.total_chunks });
      } else reply(socket, request, { message_id: 7001 });
    });
    app.activeChat = chat;
    app.connection = connection;
    await app.runCommand(`/${chat.chatType === "private" ? "send file" : "sendfile"} "${filePath}"`);
    const sent = requests.at(-1);
    assert.equal(sent.action, chat.chatType === "private" ? "upload_private_file" : "upload_group_file");
    assert.equal(sent.params.file, "/napcat/remote-only/document.pdf");
    assert.equal(sent.params.name, "带 空格的文档.pdf");
    assert.equal(sent.params[chat.chatType === "private" ? "user_id" : "group_id"], Number(chat.targetId));
    const history = await app.readChatHistory(chat);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, "7001");
    assert.equal(history[0].deliveryStatus, "success");
    assert.equal(history[0].files[0].state, "sent");
    assert.equal(chunks.length, 3);
    assert.equal(connection.pending.size, 0);
  });
});

test("发送校验失败时保留失败记录，不发送损坏文件", async (t) => {
  const app = await application(t);
  const filePath = path.join(app.projectDir, "附件.zip");
  await fs.writeFile(filePath, "zip-bytes");
  const requests = [];
  app.connection = { connected: true, async send(action, params) {
    requests.push(action);
    if (params.reset) throw new Error("reset complete");
    if (params.is_complete) return { data: { status: "file_complete", file_size: 9, file_path: "/remote/file", sha256: "wrong-hash", stream_id: params.stream_id } };
    return { data: { stream_id: params.stream_id, received_chunks: 1, total_chunks: 1 } };
  } };
  app.activeChat = CHAT;
  await app.sendFileToActiveChat(filePath);
  assert.ok(requests.every((action) => action === "upload_file_stream"));
  const history = await app.readChatHistory(CHAT);
  assert.equal(history[0].deliveryStatus, "failed");
  assert.equal(history[0].files[0].state, "send-failed");
  assert.match(app.output.join("\n"), /上传校验失败/);
});

test("发送前检查会话、路径、目录和大小，不发起上传", async (t) => {
  const app = await application(t);
  let requests = 0;
  app.connection = { connected: true, send: async () => { requests += 1; } };
  await assert.rejects(app.sendFileToActiveChat("test.pdf"), /\/sp 或 \/sg/);
  app.activeChat = CHAT;
  await assert.rejects(app.sendFileToActiveChat(""), /\/sendfile .*\/send file/);
  await assert.rejects(app.sendFileToActiveChat(path.join(app.projectDir, "missing.pdf")), /文件不存在/);
  await assert.rejects(app.sendFileToActiveChat(app.projectDir), /文件夹压缩/);
  const large = path.join(app.projectDir, "large.zip");
  await fs.writeFile(large, Buffer.alloc(1024 * 1024 + 1));
  app.config.maxFileSizeMb = 1;
  await assert.rejects(app.sendFileToActiveChat(large), /超过/);
  assert.equal(requests, 0);
});

test("文件名无法越过保存目录，路径支持中文、空格、file URL 和用户目录", () => {
  assert.equal(safeFileName("../../报告.pdf"), "报告.pdf");
  assert.equal(safeFileName("..\\..\\附件.zip"), "附件.zip");
  assert.equal(safeFileName("\x1b[31m文件.pdf"), "_[31m文件.pdf");
  assert.equal(safeFileName("CON.txt"), "_CON.txt");
  const long = safeFileName(`${"中文".repeat(1000)}.docx`);
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith(".docx"));
  assert.equal(resolveSendFilePath('"./中文 文件.pdf"'), path.resolve("中文 文件.pdf"));
  assert.equal(resolveSendFilePath("./中文\\ 文件.pdf"), path.resolve("中文 文件.pdf"));
  assert.equal(resolveSendFilePath("~/文档/报告.pdf"), path.join(os.homedir(), "文档", "报告.pdf"));
  assert.equal(resolveSendFilePath(pathToFileURL(path.resolve("中文 文件.pdf")).href), path.resolve("中文 文件.pdf"));
  assert.doesNotMatch(formatFileError(new Error("https://private.invalid/token")), /private.invalid|token/);
});
