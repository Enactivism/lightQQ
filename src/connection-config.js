const { validateHeaderValue } = require("node:http");
const { Writable } = require("node:stream");

function validateConnectionSettings({ napcatWsUrl, accessToken }) {
  const address = String(napcatWsUrl || "").trim();
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error("WebSocket 地址无效，请填写 ws://主机:端口 或 wss://主机:端口。");
  }
  if (!/^wss?:\/\//i.test(address) || !["ws:", "wss:"].includes(url.protocol)
    || !url.hostname || address.includes("#") || /[\u0000-\u0020\u007f]/.test(address)) {
    throw new Error("WebSocket 地址必须使用 ws:// 或 wss://，且不能包含片段或换行。");
  }
  const token = String(accessToken || "");
  try {
    validateHeaderValue("Authorization", `Bearer ${token}`);
  } catch {
    throw new Error("Token 包含无法用于连接认证的字符，请检查是否误粘贴了换行或非英文字符。");
  }
  return { napcatWsUrl: address, accessToken: token };
}

// 只过滤 readline 的回显，状态消息仍可正常显示。Token 不进入终端输出。
function createConfigReadlineOutput(stdout, shouldHideInput) {
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (shouldHideInput()) callback();
      else stdout.write(chunk, encoding, callback);
    },
  });
  for (const property of ["isTTY", "columns", "rows"]) {
    Object.defineProperty(output, property, { get: () => stdout[property] });
  }
  const resize = () => output.emit("resize");
  stdout.on("resize", resize);
  output.once("close", () => stdout.off("resize", resize));
  return output;
}

module.exports = { validateConnectionSettings, createConfigReadlineOutput };
