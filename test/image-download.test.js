const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const { NapCatConnection, QQlightApp, formatImageError } = require("../src/qqlight");

async function connect(t, handleRequest) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connection = new NapCatConnection({
    napcatWsUrl: `ws://127.0.0.1:${server.address().port}`,
    privateIds: [], groupIds: [],
  }, { onStatus() {}, onMessage() {}, onLog() {} });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => handleRequest(socket, JSON.parse(raw)));
  });
  t.after(async () => {
    connection.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  connection.start();
  await once(connection.socket, "open");
  return connection;
}

function reply(socket, request, data, extra = {}) {
  socket.send(JSON.stringify({
    status: "ok", retcode: 0, echo: request.echo, stream: "stream-action", data, ...extra,
  }));
}

function sendImage(socket, request, chunks = [Buffer.from("first-"), Buffer.from("second")]) {
  const fileSize = chunks.reduce((total, chunk) => total + chunk.length, 0);
  reply(socket, request, {
    type: "stream", data_type: "file_info", file_name: "received.webp", file_size: fileSize,
  });
  chunks.forEach((chunk, index) => reply(socket, request, {
    type: "stream", data_type: "file_chunk", index, size: chunk.length, data: chunk.toString("base64"),
  }));
  reply(socket, request, {
    type: "response", data_type: "file_complete", total_chunks: chunks.length, total_bytes: fileSize,
  });
}

function reader(connection, fetchImpl) {
  const app = Object.create(QQlightApp.prototype);
  Object.assign(app, { connection, fetchImpl, imageFetchControllers: new Set() });
  app.waitImpl = async () => assert.fail("应在第一次下载失败后立即切换到 NapCat");
  return app;
}

test("URL 超时后只试一次，通过真实 WebSocket 收齐图片且不干扰普通请求", async (t) => {
  const requests = [];
  const connection = await connect(t, (socket, request) => {
    requests.push(request);
    if (request.action === "get_version_info") reply(socket, request, { app_name: "NapCat" });
    else sendImage(socket, request);
  });
  let fetchCalls = 0;
  const app = reader(connection, async () => {
    fetchCalls += 1;
    throw Object.assign(new Error("private URL"), { name: "AbortError" });
  });

  const [image, version] = await Promise.all([
    app.readImageSource({ file: "opaque-image-id", url: "https://private.invalid/image", type: "" }),
    connection.send("get_version_info", {}),
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal(image.buffer.toString(), "first-second");
  assert.equal(image.extension, ".webp");
  assert.equal(version.data.app_name, "NapCat");
  assert.deepEqual(requests.find((request) => request.action === "download_file_stream").params,
    { file: "opaque-image-id", chunk_size: 65536 });
  assert.equal(requests.length, 2);
  assert.equal(connection.pending.size, 0);
  assert.equal(app.imageFetchControllers.size, 0);
});

test("过期 URL 返回 HTTP 400 后可以从 NapCat 取回图片", async (t) => {
  const connection = await connect(t, (socket, request) => sendImage(socket, request));
  const app = reader(connection, async () => ({ ok: false, status: 400 }));

  const image = await app.readImageSource({ file: "opaque-image-id", url: "https://private.invalid/expired" });

  assert.equal(image.buffer.toString(), "first-second");
  assert.equal(image.extension, ".webp");
});

test("流式图片文件名缺失或不准确时按实际文件头保存扩展名", async (t) => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const connection = await connect(t, (socket, request) => sendImage(socket, request, [bytes]));
  const app = reader(connection, async () => assert.fail("没有 URL 时直接使用 NapCat"));

  const image = await app.readImageSource({ file: "opaque-image-id" });

  assert.deepEqual(image.buffer, bytes);
  assert.equal(image.extension, ".jpg");
});

test("旧版 NapCat 不支持流传输时继续用 get_image 刷新 URL", async (t) => {
  const requests = [];
  const connection = await connect(t, (socket, request) => {
    requests.push(request.action);
    if (request.action === "download_file_stream") {
      reply(socket, request, null, { status: "failed", retcode: 1404, wording: "unsupported action" });
    } else {
      reply(socket, request, { url: "https://private.invalid/fresh" });
    }
  });
  const urls = [];
  const app = reader(connection, async (url) => {
    urls.push(url);
    if (url.endsWith("expired")) return { ok: false, status: 400 };
    return {
      ok: true, headers: { get: (name) => name === "content-type" ? "image/gif" : null },
      arrayBuffer: async () => Buffer.from("fresh-image"),
    };
  });

  const result = await app.readImageSource({ file: "opaque-image-id", url: "https://private.invalid/expired" });

  assert.deepEqual(requests, ["download_file_stream", "get_image"]);
  assert.deepEqual(urls, ["https://private.invalid/expired", "https://private.invalid/fresh"]);
  assert.equal(result.buffer.toString(), "fresh-image");
  assert.equal(result.extension, ".gif");
});

test("流传输和 get_image 都不可用时仍会重试临时 URL 错误", async (t) => {
  const connection = await connect(t, (socket, request) => {
    reply(socket, request, null, { status: "failed", retcode: 1404 });
  });
  let fetchCalls = 0;
  const app = reader(connection, async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw Object.assign(new Error("private URL"), { code: "EAI_AGAIN" });
    return {
      ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("retry-image"),
    };
  });

  const image = await app.readImageSource({ file: "opaque-image-id", url: "https://private.invalid/image" });

  assert.equal(fetchCalls, 2);
  assert.equal(image.buffer.toString(), "retry-image");
});

test("图片流缺片、乱序或损坏时拒绝保存不完整内容", async (t) => {
  const chunk = { type: "stream", data_type: "file_chunk", index: 0, data: "aW1n", size: 3 };
  const complete = { type: "response", data_type: "file_complete", total_chunks: 1, total_bytes: 3 };
  const cases = [
    { name: "缺少末尾数据", size: 4, packets: [chunk, complete] },
    { name: "乱序分片", size: 3, packets: [{ ...chunk, index: 1 }, complete] },
    { name: "分片大小不符", size: 3, packets: [{ ...chunk, size: 4 }, complete] },
    { name: "无效 Base64", size: 3, packets: [{ ...chunk, data: "%%%%" }, complete] },
    { name: "未收到分片就结束", size: 3, packets: [complete] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const connection = await connect(t, (socket, request) => {
        reply(socket, request, { type: "stream", data_type: "file_info", file_size: scenario.size });
        scenario.packets.forEach((data) => reply(socket, request, data));
      });
      await assert.rejects(connection.downloadImage("opaque-image-id"), /NapCat 图片传输不完整/);
      assert.equal(connection.pending.size, 0);
    });
  }
});

test("图片流超过 25 MiB 时在接收正文前终止", async (t) => {
  const connection = await connect(t, (socket, request) => {
    reply(socket, request, { type: "stream", data_type: "file_info", file_size: 26 * 1024 * 1024 });
  });

  await assert.rejects(connection.downloadImage("opaque-image-id"), /超过 25 MiB/);
  assert.equal(connection.pending.size, 0);
});

test("图片流中途断线时拒绝下载并清理待响应请求", async (t) => {
  const connection = await connect(t, (socket, request) => {
    reply(socket, request, { type: "stream", data_type: "file_info", file_size: 3 });
    socket.close();
  });

  await assert.rejects(connection.downloadImage("opaque-image-id"), /WebSocket 已断开/);
  assert.equal(connection.pending.size, 0);
});

test("退出时中止图片流，不再启动解析或 URL 重试", async (t) => {
  let app;
  const requests = [];
  const connection = await connect(t, (socket, request) => {
    requests.push(request.action);
    reply(socket, request, { type: "stream", data_type: "file_info", file_size: 3 });
    app.exiting = true;
    app.imageFetchControllers.forEach((controller) => controller.abort());
  });
  app = reader(connection, async () => {
    throw Object.assign(new Error("https://private.invalid/token"), { name: "AbortError" });
  });

  await assert.rejects(
    app.readImageSource({ file: "opaque-image-id", url: "https://private.invalid/token" }),
    (error) => {
      assert.doesNotMatch(formatImageError(error), /private.invalid|token/);
      return true;
    },
  );
  assert.deepEqual(requests, ["download_file_stream"]);
  assert.equal(connection.pending.size, 0);
  assert.equal(app.imageFetchControllers.size, 0);
});

test("图片流持续收到分片时刷新等待期限，停传时正常超时", async (t) => {
  await t.test("持续传输", async (t) => {
    const connection = await connect(t, (socket, request) => {
      reply(socket, request, { type: "stream", data_type: "file_info" });
      const chunkTimer = setTimeout(() => reply(socket, request, { type: "stream", data_type: "file_chunk" }), 600);
      const completeTimer = setTimeout(() => reply(socket, request, { type: "response" }), 1200);
      t.after(() => { clearTimeout(chunkTimer); clearTimeout(completeTimer); });
    });
    let packets = 0;
    const result = await connection.send("download_file_stream", { file: "image" }, {
      timeoutMs: 1000, onStream: () => { packets += 1; },
    });
    assert.equal(packets, 2);
    assert.equal(result.data.type, "response");
    assert.equal(connection.pending.size, 0);
  });
  await t.test("停止传输", async (t) => {
    const connection = await connect(t, (socket, request) => {
      reply(socket, request, { type: "stream", data_type: "file_info" });
    });
    await assert.rejects(connection.send("download_file_stream", { file: "image" }, {
      timeoutMs: 1000, onStream() {},
    }), /等待 NapCat 响应超时/);
    assert.equal(connection.pending.size, 0);
  });
});
