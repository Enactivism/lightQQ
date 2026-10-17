const test = require("node:test");
const assert = require("node:assert/strict");

const {
  QQlightApp,
  alignMessageLine,
  createMessageEvent,
  formatImageError,
  terminalCellWidth,
} = require("../src/qqlight");

function mockResponse({ status = 200, body = "image", contentType = "image/png" } = {}) {
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return contentType;
        if (name.toLowerCase() === "content-length") return String(bytes.length);
        return null;
      },
    },
    body: { cancel: async () => {} },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

function createImageReader({ fetchImpl, connection } = {}) {
  const app = Object.create(QQlightApp.prototype);
  app.fetchImpl = fetchImpl;
  app.waitImpl = async () => {};
  app.connection = connection || {
    send: async () => {
      throw new Error("unexpected NapCat request");
    },
  };
  return app;
}

test("图片 URL 遇到暂时网络错误后会重试", async () => {
  let calls = 0;
  const app = createImageReader({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("fetch failed: https://private.invalid/secret");
        error.cause = { code: "ECONNRESET" };
        throw error;
      }
      return mockResponse({ body: "gif-data", contentType: "image/gif" });
    },
  });

  const result = await app.readImageValue("https://private.invalid/secret");

  assert.equal(calls, 2);
  assert.equal(result.buffer.toString(), "gif-data");
  assert.equal(result.extension, ".gif");
});

test("永久 HTTP 错误不会重复下载且不会泄露 URL", async () => {
  let calls = 0;
  const app = createImageReader({
    fetchImpl: async () => {
      calls += 1;
      return mockResponse({ status: 404 });
    },
  });

  await assert.rejects(
    app.readImageValue("https://private.invalid/token"),
    (error) => {
      assert.equal(error.message, "下载图片失败：HTTP 404");
      assert.equal(error.message.includes("private.invalid"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("消息自带 URL 可用时优先使用 URL", async () => {
  let resolveCalls = 0;
  const app = createImageReader({
    fetchImpl: async () => mockResponse({ body: "remote-image" }),
    connection: {
      send: async () => {
        resolveCalls += 1;
        throw new Error("should not resolve");
      },
    },
  });

  const result = await app.readImageSource({
    file: "opaque-napcat-image-id",
    url: "https://private.invalid/image",
    type: "",
  });

  assert.equal(result.buffer.toString(), "remote-image");
  assert.equal(resolveCalls, 0);
});

test("不透明图片标识通过 NapCat get_image 解析", async () => {
  let request;
  const app = createImageReader({
    connection: {
      send: async (...args) => {
        request = args;
        return {
          data: {
            base64: Buffer.from("resolved-image").toString("base64"),
            file_name: "resolved.gif",
          },
        };
      },
    },
  });

  const result = await app.readImageSource({
    file: "opaque-napcat-image-id",
    url: "",
    type: "",
  });

  assert.deepEqual(request, [
    "get_image",
    { file: "opaque-napcat-image-id" },
    { timeoutMs: 30000 },
  ]);
  assert.equal(result.buffer.toString(), "resolved-image");
  assert.equal(result.extension, ".gif");
});

test("get_image 完成后会重新尝试此前尚未就绪的 URL", async () => {
  let fetchCalls = 0;
  let resolveCalls = 0;
  const imageUrl = "https://private.invalid/delayed-image";
  const app = createImageReader({
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls <= 3) return mockResponse({ status: 503 });
      return mockResponse({ body: "ready-image", contentType: "image/jpeg" });
    },
    connection: {
      send: async () => {
        resolveCalls += 1;
        return { data: { url: imageUrl, file_name: "ready.jpg" } };
      },
    },
  });

  const result = await app.readImageSource({
    file: "opaque-napcat-image-id",
    url: imageUrl,
    type: "",
  });

  assert.equal(fetchCalls, 4);
  assert.equal(resolveCalls, 1);
  assert.equal(result.buffer.toString(), "ready-image");
  assert.equal(result.extension, ".jpg");
});

test("未知图片异常只显示安全错误码", () => {
  const error = new Error("fetch failed: https://private.invalid/secret-token");
  error.cause = { code: "ENOTFOUND" };

  const message = formatImageError(error);

  assert.equal(message, "图片来源不可用（ENOTFOUND）");
  assert.equal(message.includes("secret-token"), false);
});

test("隔离聊天消息按终端宽度将我的消息靠右显示", () => {
  const line = "12:34 ↑ 我: 你好";

  assert.equal(terminalCellWidth("你好"), 4);
  assert.equal(alignMessageLine(line, "incoming", 30), line);
  assert.equal(
    terminalCellWidth(alignMessageLine(line, "outgoing", 30)),
    29,
  );
  assert.match(alignMessageLine(line, "outgoing", 30), /^ +12:34/);
});

test("消息渲染将昵称和正文明确分层", () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = null;

  const line = app.renderMessage({
    time: "2026-10-17T12:34:00.000Z",
    direction: "incoming",
    chatType: "group",
    targetId: "123456",
    chatName: "测试群",
    senderName: "小明",
    text: "你好",
  });

  assert.match(line, /【小明】 │ 你好/);
  assert.doesNotMatch(line, /小明: 你好/);
});

test("B站 JSON 卡片提取视频标题和分享链接", () => {
  const card = {
    app: "com.tencent.miniapp_01",
    desc: "哔哩哔哩",
    prompt: "[QQ小程序]哔哩哔哩",
    meta: {
      detail_1: {
        title: "哔哩哔哩",
        desc: "测试视频标题",
        qqdocurl: "https://b23.tv/test-video",
      },
    },
  };
  const event = createMessageEvent({
    post_type: "message",
    message_type: "private",
    user_id: 123456,
    message: [{ type: "json", data: { data: JSON.stringify(card) } }],
  });

  assert.equal(event.text, "[B站视频] 测试视频标题 | https://b23.tv/test-video");
});

test("CQ 字符串格式的 B站 JSON 卡片也能提取", () => {
  const card = JSON.stringify({
    desc: "哔哩哔哩",
    meta: {
      detail_1: {
        title: "哔哩哔哩",
        desc: "另一个视频",
        qqdocurl: "https://b23.tv/another-video",
      },
    },
  }).replace(/,/g, "&#44;");
  const event = createMessageEvent({
    post_type: "message",
    message_type: "private",
    user_id: 123456,
    message: `[CQ:json,data=${card}]`,
  });

  assert.equal(event.text, "[B站视频] 另一个视频 | https://b23.tv/another-video");
});
