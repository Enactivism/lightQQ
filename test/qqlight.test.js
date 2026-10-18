const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  QQlightApp,
  alignMessageBlock,
  alignMessageLine,
  createMessageEvent,
  formatImageError,
  mergeIds,
  resolveImageProxy,
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

test("图片下载失败时报告下载原因而不是 NapCat 主机路径的 ENOENT", async () => {
  const app = createImageReader({
    fetchImpl: async () => {
      const error = new Error("fetch failed");
      error.cause = { code: "ECONNRESET" };
      throw error;
    },
    connection: {
      send: async () => ({ data: { file: "/app/.config/QQ/nt_data/Pic/Ori/image.png" } }),
    },
  });

  await assert.rejects(
    app.readImageSource({
      file: "D4F1C0A1B2C3D4E5.png",
      url: "https://multimedia.invalid/image",
      type: "",
    }),
    (error) => {
      assert.match(error.message, /下载图片失败：ECONNRESET（已尝试 3 次）/);
      assert.doesNotMatch(error.message, /ENOENT/);
      assert.equal(error.message.includes("multimedia.invalid"), false);
      return true;
    },
  );
});

test("图片只存在于 NapCat 主机时提示本机无法读取", async () => {
  const app = createImageReader({
    connection: {
      send: async () => ({ data: { file: "/app/.config/QQ/nt_data/Pic/Ori/image.png" } }),
    },
  });

  await assert.rejects(
    app.readImageSource({ file: "D4F1C0A1B2C3D4E5.png", url: "", type: "" }),
    /NapCat 主机上的图片文件本机无法读取/,
  );
});

test("消息自带的 URL 失效时改用 get_image 返回的可用 URL", async () => {
  const app = createImageReader({
    fetchImpl: async (url) => (String(url).includes("expired")
      ? mockResponse({ status: 404 })
      : mockResponse({ body: "fresh-image", contentType: "image/png" })),
    connection: {
      send: async () => ({ data: { url: "https://multimedia.invalid/fresh.png" } }),
    },
  });

  const result = await app.readImageSource({
    file: "D4F1C0A1B2C3D4E5.png",
    url: "https://multimedia.invalid/expired",
    type: "",
  });

  assert.equal(result.buffer.toString(), "fresh-image");
  assert.equal(result.extension, ".png");
});

test("按环境变量选择图片下载代理并支持 NO_PROXY", (t) => {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
  keys.forEach((key) => { delete process.env[key]; });

  assert.equal(resolveImageProxy("https://multimedia.nt.qq.com.cn/download?a=1"), null);

  process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
  assert.equal(resolveImageProxy("https://multimedia.nt.qq.com.cn/download?a=1")?.port, "7890");
  // HTTP 图片和 socks 代理不进入隧道逻辑。
  assert.equal(resolveImageProxy("http://multimedia.nt.qq.com.cn/x.png"), null);
  process.env.HTTPS_PROXY = "socks5://127.0.0.1:7890";
  assert.equal(resolveImageProxy("https://multimedia.nt.qq.com.cn/x.png"), null);

  process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
  process.env.NO_PROXY = "qq.com.cn, localhost";
  assert.equal(resolveImageProxy("https://multimedia.nt.qq.com.cn/x.png"), null);
  assert.equal(resolveImageProxy("https://example.org/x.png")?.port, "7890");
});

test("代理拒绝隧道时报告代理错误而不是直连失败", async (t) => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.HTTPS_PROXY;
  t.after(() => {
    server.close();
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  });
  process.env.HTTPS_PROXY = `http://127.0.0.1:${server.address().port}`;

  const app = createImageReader({ fetchImpl: globalThis.fetch });
  await assert.rejects(
    app.readImageValue("https://multimedia.invalid/image.png"),
    /代理隧道建立失败：HTTP 403/,
  );
});

test("接收图片消息时先显示消息，图片在后台保存", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qqlight-test-"));

  let releaseDownload;
  const downloadGate = new Promise((resolve) => {
    releaseDownload = resolve;
  });

  const app = new QQlightApp({
    napcatWsUrl: "ws://127.0.0.1:3001",
    accessToken: "",
    privateIds: [],
    groupIds: [],
    maxHistory: 200,
  });
  t.after(async () => {
    await app.imageSaveQueue.catch(() => {});
    await Promise.all([...app.historyWriteQueues.values()]).catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  app.projectDir = dir;
  app.imageDir = path.join(dir, "images");
  app.historyDir = path.join(dir, "history");
  app.fetchImpl = async () => {
    await downloadGate;
    return mockResponse({ body: "image-bytes", contentType: "image/png" });
  };
  app.waitImpl = async () => {};

  const printed = [];
  app.writeLine = (line) => printed.push(line);

  const message = {
    id: "9001",
    time: Date.now(),
    direction: "incoming",
    chatType: "group",
    targetId: "123456",
    chatName: "测试群",
    senderId: "111",
    senderName: "小明",
    text: "{图片}",
    rawMessage: "[CQ:image,file=x.png]",
    imageSources: [{ file: "x.png", url: "https://multimedia.invalid/x.png", type: "" }],
  };

  // 下载被挂起时，消息仍应立即展示出来。
  await app.receiveMessage(message);

  assert.equal(printed.length, 1);
  assert.match(printed[0], /小明/);
  assert.match(printed[0], /\{图片\}/);
  const chat = { chatType: "group", targetId: "123456" };
  assert.deepEqual(app.getChatHistory(chat)[0].imagePaths, []);

  releaseDownload();
  await app.imageSaveQueue;

  const stored = app.getChatHistory(chat)[0];
  assert.equal(stored.imagePaths.length, 1);
  assert.equal(fs.existsSync(stored.imagePaths[0]), true);
  assert.equal(await fs.promises.readFile(stored.imagePaths[0], "utf8"), "image-bytes");

  // 历史文件在图片保存完成后补写本地路径，重启后仍能打开图片。
  const persisted = await fs.promises.readFile(
    path.join(dir, "history", "group-123456.jsonl"),
    "utf8",
  );
  assert.match(persisted, /\{图片\}/);
  assert.match(persisted, /images\//);
});

test("图片保存失败不会影响后续消息处理", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qqlight-test-"));
  const app = new QQlightApp({
    napcatWsUrl: "ws://127.0.0.1:3001",
    accessToken: "",
    privateIds: [],
    groupIds: [],
    maxHistory: 200,
  });
  t.after(async () => {
    await app.imageSaveQueue.catch(() => {});
    await Promise.all([...app.historyWriteQueues.values()]).catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  app.projectDir = dir;
  app.imageDir = path.join(dir, "images");
  app.historyDir = path.join(dir, "history");
  app.fetchImpl = async () => mockResponse({ status: 403 });
  app.waitImpl = async () => {};
  app.connection.send = async () => {
    throw new Error("get_image failed");
  };

  const printed = [];
  app.writeLine = (line) => printed.push(line);
  const chat = { chatType: "private", targetId: "123456" };

  await app.receiveMessage({
    id: "1",
    time: Date.now(),
    direction: "incoming",
    chatType: "private",
    targetId: "123456",
    senderId: "123456",
    senderName: "对方",
    text: "{图片}",
    rawMessage: "[CQ:image,file=x.png]",
    imageSources: [{ file: "x.png", url: "https://multimedia.invalid/x.png", type: "" }],
  });
  await app.imageSaveQueue;

  assert.match(printed.join("\n"), /接收图片保存失败：下载图片失败：HTTP 403/);
  assert.deepEqual(app.getChatHistory(chat)[0].imagePaths, []);

  // 后续纯文本消息照常进入历史。
  await app.receiveMessage({
    id: "2",
    time: Date.now(),
    direction: "incoming",
    chatType: "private",
    targetId: "123456",
    senderId: "123456",
    senderName: "对方",
    text: "后面的消息",
    imageSources: [],
  });
  assert.equal(app.getChatHistory(chat)[1].text, "后面的消息");
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

test("隔离聊天消息使用分层气泡并按方向排列", () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = { chatType: "private", targetId: "123456" };
  const originalDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    const stripAnsi = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const incoming = app.renderMessage({
      time: "2026-10-17T12:34:00.000Z",
      direction: "incoming",
      chatType: "private",
      targetId: "123456",
      senderName: "小明",
      text: "第一行\n第二行",
    });
    const outgoing = app.renderMessage({
      time: "2026-10-17T12:35:00.000Z",
      direction: "outgoing",
      chatType: "private",
      targetId: "123456",
      text: "收到",
    });

    const plainIncoming = stripAnsi(incoming);
    const plainOutgoing = stripAnsi(outgoing);
    assert.match(plainIncoming, /╭─ 小明/);
    assert.match(plainIncoming, /╰─ 第一行\n   第二行/);
    assert.match(plainOutgoing, /╭─ 我/);
    assert.ok(plainOutgoing.startsWith(" "));
    const alignedLines = alignMessageBlock("╭─ 我\n╰─ 收到", "outgoing", 30).split("\n");
    assert.equal(alignedLines[0].match(/^ */)[0].length, alignedLines[1].match(/^ */)[0].length);
    assert.equal(terminalCellWidth(alignedLines[1]), 29);
  } finally {
    if (originalDescriptor) Object.defineProperty(process.stdout, "isTTY", originalDescriptor);
    else delete process.stdout.isTTY;
  }
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

test("同一群聊中的不同用户获得不重复的昵称颜色", () => {
  const app = Object.create(QQlightApp.prototype);
  app.groupSenderColors = new Map();
  const messages = [
    {
      chatType: "group",
      targetId: "123456",
      direction: "incoming",
      senderId: "10001",
      senderName: "小明",
    },
    {
      chatType: "group",
      targetId: "123456",
      direction: "incoming",
      senderId: "10002",
      senderName: "小红",
    },
    {
      chatType: "group",
      targetId: "123456",
      direction: "outgoing",
      senderName: "",
    },
  ];
  const assignedColors = messages.map((message) => app.getGroupSenderColor(message));

  assert.equal(new Set(assignedColors).size, messages.length);
  assert.equal(app.getGroupSenderColor(messages[0]), assignedColors[0]);
});

test("聊天头部显示群聊名称和当前时间", () => {
  const app = Object.create(QQlightApp.prototype);
  app.connection = { connected: true };
  const lines = [];
  app.writeLine = (line) => lines.push(line);

  app.renderChatHeader({
    chatType: "group",
    targetId: "123456",
    displayName: "测试群",
  });

  assert.match(lines[1], /群聊.*测试群/);
  assert.match(lines[1], /\b\d{2}:\d{2}:\d{2}\b/);
  assert.match(lines[2], /群号 123456/);
  assert.match(lines[2], /在线/);
  assert.match(lines[0], /^╔═+╗$/);
  assert.match(lines[3], /^╚═+╝$/);
  assert.doesNotMatch(lines.join("\n"), /╭─|╰─/);
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

test("群聊输入 [QQ号]消息 会构造标准 at 消息段", async () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = { chatType: "group", targetId: "987654" };
  app.buildDraftMessage = QQlightApp.prototype.buildDraftMessage;
  let sent;
  app.sendMessage = async (...args) => {
    sent = args;
  };

  await app.sendToActiveChat("[123456789]你好");

  assert.deepEqual(sent, [
    "group",
    "987654",
    [
      { type: "at", data: { qq: "123456789" } },
      { type: "text", data: { text: "你好" } },
    ],
    "@123456789 你好",
  ]);
});

test("群聊可以按群名片解析昵称并@成员", async () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = { chatType: "group", targetId: "987654" };
  app.groupMembersById = new Map();
  app.connection = {
    send: async (action, params) => {
      assert.equal(action, "get_group_member_list");
      assert.deepEqual(params, { group_id: 987654 });
      return { data: [{ user_id: 123456789, card: "叉叉.L", nickname: "测试昵称" }] };
    },
  };
  app.buildDraftMessage = QQlightApp.prototype.buildDraftMessage;
  let sent;
  app.sendMessage = async (...args) => {
    sent = args;
  };

  await app.sendToActiveChat("[叉叉.L]你好");

  assert.deepEqual(sent, [
    "group",
    "987654",
    [
      { type: "at", data: { qq: "123456789" } },
      { type: "text", data: { text: "你好" } },
    ],
    "@叉叉.L 你好",
  ]);
});

test("粘贴图片使用花括号占位符且不会被解析成群聊@成员", async () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = { chatType: "group", targetId: "987654" };
  app.buildDraftMessage = QQlightApp.prototype.buildDraftMessage;
  let sent;
  app.sendMessage = async (...args) => {
    sent = args;
  };

  await app.sendToActiveChat("{图片}", [{
    type: "image",
    data: { file: "base64://image-data" },
  }]);

  assert.deepEqual(sent, [
    "group",
    "987654",
    [{ type: "image", data: { file: "base64://image-data" } }],
    "{图片}",
  ]);
});

test("多行文字粘贴只写入输入框，按回车前不会发送", () => {
  const app = Object.create(QQlightApp.prototype);
  let promptCalls = 0;
  app.rl = {
    line: "前缀",
    cursor: 2,
    closed: false,
    prompt: () => {
      promptCalls += 1;
    },
  };

  assert.equal(app.insertTextIntoInput("第一行\r\n第二行"), true);
  assert.equal(app.rl.line, "前缀第一行\u0000第二行");
  assert.equal(app.rl.cursor, "前缀第一行\u0000第二行".length);
  assert.equal(promptCalls, 1);
});

test("终端多行粘贴结束后会合并为一次输入", () => {
  const app = Object.create(QQlightApp.prototype);
  let promptCalls = 0;
  app.pasteSession = { lines: ["第一行"] };
  app.rl = {
    line: "第二行",
    cursor: 3,
    closed: false,
    prompt: () => {
      promptCalls += 1;
    },
  };

  app.finishPasteSession();

  assert.equal(app.rl.line, "第一行\u0000第二行");
  assert.equal(app.rl.cursor, "第一行\u0000第二行".length);
  assert.equal(app.pasteSession, null);
  assert.equal(promptCalls, 1);
});

test("文字粘贴读取完成后会替换暂存输入而不是追加一份", () => {
  const app = Object.create(QQlightApp.prototype);
  app.pasteSession = {
    kind: "manual",
    lines: ["旧的第一行"],
    lineBefore: "前缀",
    cursorBefore: 2,
  };
  app.rl = {
    line: "旧的第二行",
    cursor: 5,
    closed: false,
    prompt: () => {},
  };

  app.finishPasteSession("第一行\n第二行");

  assert.equal(app.rl.line, "前缀第一行\u0000第二行");
  assert.equal(app.pasteSession, null);
});

test("按下回车提交时才恢复粘贴文本中的换行", async () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = { chatType: "private", targetId: "123456789" };
  let sent;
  app.sendToActiveChat = async (...args) => {
    sent = args;
  };

  await app.runCommand("第一行\u0000第二行");

  assert.deepEqual(sent, ["第一行\n第二行", []]);
});

test("同一批次的多行输入只提交一次", async () => {
  const app = Object.create(QQlightApp.prototype);
  app.submittedLineBatch = [];
  app.submittedLineFlushTimer = null;
  app.commandQueue = Promise.resolve();
  app.pendingImages = [];
  app.clearSubmittedInput = () => {};
  app.takePendingImages = () => [];
  const sent = [];
  app.runCommand = async (line, pendingImages) => {
    sent.push([line, pendingImages]);
  };

  app.queueSubmittedLine("第一行");
  app.queueSubmittedLine("第二行");
  await new Promise((resolve) => setTimeout(resolve, 70));
  await app.commandQueue;

  assert.deepEqual(sent, [["第一行\n第二行", []]]);
});

test("gls 可以列出或模糊搜索群成员", async () => {
  const app = Object.create(QQlightApp.prototype);
  app.activeChat = { chatType: "group", targetId: "987654" };
  app.groupMembersById = new Map([[
    "987654",
    [
      { user_id: 123456789, card: "叉叉.L", nickname: "测试昵称" },
      { user_id: 222222222, card: "小明", nickname: "小明" },
      { user_id: 333333333, card: "", nickname: "叉烧" },
    ],
  ]]);
  const output = [];
  app.writeLine = (line) => output.push(line);

  await app.showGroupMembers("gls 叉");

  assert.match(output[0], /匹配“叉”的群成员（2）：/);
  assert.match(output[1], /叉叉\.L.*123456789/);
  assert.match(output[2], /叉烧.*333333333/);
  assert.doesNotMatch(output.join("\n"), /小明/);
});

test("白名单追加会保留已有号码并自动去重", () => {
  assert.deepEqual(
    mergeIds(["123456789", "222222222"], ["222222222", "333333333"]),
    ["123456789", "222222222", "333333333"],
  );
});
