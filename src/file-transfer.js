const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");

const FILE_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_SIZE_MB = 100;
const FILE_TIMEOUT_MS = 60000;

function fileError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { fileTransferError: true });
}

function formatFileError(error) {
  if (error?.fileTransferError) return error.message;
  if (error?.name === "AbortError") return "文件传输已取消";
  const code = error?.code || error?.cause?.code;
  return /^[A-Z][A-Z0-9_]{1,40}$/.test(String(code || ""))
    ? `文件传输失败（${code}）` : "文件传输失败，请检查 NapCat 连接或文件是否已过期";
}

function safeFileName(value) {
  let name = String(value || "").split(/[\\/]/).pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/[. ]+$/g, "").trim();
  if (!name || /^\.+$/.test(name)) name = "未命名文件";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  // 留出足够的文件系统字节空间，同时保留常见文件扩展名。
  const originalExtension = path.extname(name);
  const extension = [...originalExtension].slice(0, 24).join("");
  let stem = "";
  let bytes = Buffer.byteLength(extension);
  for (const character of name.slice(0, name.length - originalExtension.length)) {
    bytes += Buffer.byteLength(character);
    if (bytes > 200) break;
    stem += character;
  }
  return stem + extension;
}

function normalizeFileSource(data = {}) {
  if (!data || typeof data !== "object") data = {};
  const size = data.size ?? data.file_size;
  const file = String(data.file || "");
  const fileId = String(data.fileId || data.file_id || data.id || "");
  const url = String(data.url || (/^https?:\/\//i.test(file) ? file : ""));
  const name = safeFileName(data.name || data.file_name || (!/^\w+:/.test(file) ? file : ""));
  return {
    fileId, file, url, name,
    size: size !== undefined && size !== null && size !== "" && Number.isSafeInteger(Number(size)) && Number(size) >= 0
      ? Number(size) : undefined,
    busId: Number.isSafeInteger(Number(data.busId ?? data.busid)) ? Number(data.busId ?? data.busid) : undefined,
  };
}

function fileReference(file) {
  return String(file.fileId || file.file || file.url || "");
}

function mergeFiles(previous = [], next = []) {
  if (!Array.isArray(previous)) previous = [];
  if (!Array.isArray(next)) next = [];
  if (!next.length) return previous;
  return next.map((file, index) => {
    const old = previous.find((entry) => fileReference(file) && fileReference(entry) === fileReference(file))
      || (previous[index]?.name === file.name ? previous[index] : null);
    if (!old) return file;
    const merged = { ...old, ...file, size: file.size ?? old.size, path: file.path || old.path || "" };
    if (merged.path) {
      merged.state = "saved";
      merged.error = "";
    }
    return merged;
  });
}

function formatFileSize(size) {
  if (!Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function formatFileLabel(file) {
  const size = formatFileSize(file.size);
  return `[文件] ${file.name}${size ? `（${size}）` : ""}`;
}

function resolveSendFilePath(value) {
  let input = String(value || "").trim();
  if (!input || /[\r\n\x00]/.test(input)) throw fileError("请输入 /sendfile <本地文件路径> 或 /send file <本地文件路径>");
  const quoted = (input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"));
  if (quoted) input = input.slice(1, -1);
  else if (process.platform !== "win32") input = input.replace(/\\([ ()'"\[\]])/g, "$1");
  if (/^file:\/\//i.test(input)) {
    try { return fileURLToPath(input); } catch { throw fileError("文件路径无效"); }
  }
  if (/^~(?:[\\/]|$)/.test(input)) input = path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

class FileTransfer {
  constructor({ connection, request = (url, signal) => fetch(url, { signal }), maxBytes = DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024 }) {
    Object.assign(this, { connection, request, maxBytes });
  }

  checkSize(size) {
    if (Number.isFinite(size) && size > this.maxBytes) {
      throw Object.assign(fileError(`文件超过 ${formatFileSize(this.maxBytes)} 限制，可在配置中调整 maxFileSizeMb`), { fileTooLarge: true });
    }
  }

  async save(source, directory, { chat, signal } = {}) {
    this.checkSize(source.size);
    signal?.throwIfAborted();
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const folder = await fs.promises.mkdtemp(path.join(directory, "file-"));
    const temporaryPath = path.join(folder, ".download.part");
    let fd;
    let bytes = 0;
    let downloadedName = "";
    let closed = false;
    const attempt = async (download) => {
      fs.ftruncateSync(fd, 0);
      bytes = 0;
      // 指定位置写入，确保备用来源从文件起点重新开始。
      const writeAtStart = (chunk) => {
        signal?.throwIfAborted();
        this.checkSize(bytes + chunk.length);
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset, bytes + offset);
        bytes += chunk.length;
      };
      await download(writeAtStart);
      if (source.size !== undefined && bytes !== source.size) throw fileError("文件传输不完整，实际大小与消息不符");
    };
    const errors = [];
    const tryDownload = async (download) => {
      try { await attempt(download); return true; } catch (error) {
        signal?.throwIfAborted();
        errors.push(error);
        // 超限时不再换来源重复下载。
        if (error?.fileTooLarge) throw error;
        return false;
      }
    };
    const triedUrls = new Set();
    const tryUrl = async (url) => {
      if (!/^https?:\/\//i.test(String(url || "")) || triedUrls.has(url)) return false;
      triedUrls.add(url);
      return tryDownload((sink) => this.downloadUrl(url, sink, signal));
    };
    try {
      fd = fs.openSync(temporaryPath, "wx", 0o600);
      let saved = await tryUrl(source.url);
      const reference = fileReference(source);
      if (!saved && reference) {
        saved = await tryDownload(async (sink) => {
          downloadedName = await this.downloadStream(reference, sink, signal);
        });
      }
      if (!saved && reference && chat) {
        try {
          const response = await this.connection.send(chat.chatType === "group" ? "get_group_file_url" : "get_private_file_url", {
            file_id: reference,
            ...(chat.chatType === "group" ? { group_id: Number(chat.targetId), ...(source.busId !== undefined ? { busid: source.busId } : {}) } : {}),
          }, { timeoutMs: FILE_TIMEOUT_MS, signal });
          saved = await tryUrl(response?.data?.url);
        } catch (error) { signal?.throwIfAborted(); if (error?.fileTooLarge) throw error; errors.push(error); }
      }
      if (!saved && reference) {
        try {
          const response = await this.connection.send("get_file", { file_id: reference }, { timeoutMs: FILE_TIMEOUT_MS, signal });
          const data = response?.data || {};
          downloadedName = String(data.file_name || "");
          saved = await tryUrl(data.url);
          if (!saved && typeof data.base64 === "string") {
            saved = await tryDownload(async (sink) => {
              if (data.base64.length > Math.ceil(this.maxBytes / 3) * 4) this.checkSize(this.maxBytes + 1);
              if (data.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) throw fileError("文件 Base64 数据损坏");
              sink(Buffer.from(data.base64, "base64"));
            });
          }
          if (!saved) {
            let localPath = data.file || data.url || "";
            if (/^file:\/\//i.test(localPath)) localPath = fileURLToPath(localPath);
            if (path.isAbsolute(localPath)) {
              saved = await tryDownload(async (sink) => {
                try {
                  for await (const chunk of fs.createReadStream(localPath, { highWaterMark: FILE_CHUNK_BYTES, signal })) sink(chunk);
                } catch (error) {
                  if (["ENOENT", "EACCES"].includes(error.code)) throw fileError("NapCat 主机上的文件本机无法读取，请使用支持流式下载的 NapCat", error);
                  throw error;
                }
              });
            }
          }
        } catch (error) { signal?.throwIfAborted(); if (error?.fileTooLarge) throw error; errors.push(error); }
      }
      if (!saved) throw errors.find((error) => error?.fileTransferError) || errors[0] || fileError("文件没有可用的下载来源");
      signal?.throwIfAborted();
      const name = source.name === "未命名文件" && downloadedName ? safeFileName(downloadedName) : safeFileName(source.name);
      const filePath = path.join(folder, name);
      fs.closeSync(fd);
      closed = true;
      await fs.promises.rename(temporaryPath, filePath);
      return { ...source, name, size: bytes, path: filePath, state: "saved", error: "" };
    } catch (error) {
      if (fd !== undefined && !closed) fs.closeSync(fd);
      await fs.promises.rm(folder, { recursive: true, force: true });
      throw error;
    }
  }

  async downloadUrl(url, sink, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer;
    const refreshTimeout = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS); };
    refreshTimeout();
    let response;
    try {
      signal?.throwIfAborted();
      response = await this.request(url, controller.signal);
      if (!response.ok) throw fileError(`下载文件失败：HTTP ${Number(response.status) || "错误"}`);
      const lengthHeader = response.headers?.get("content-length");
      const expected = lengthHeader !== null && lengthHeader !== undefined ? Number(lengthHeader) : undefined;
      this.checkSize(expected);
      let total = 0;
      if (response.body?.[Symbol.asyncIterator]) {
        for await (const chunk of response.body) {
          refreshTimeout();
          sink(Buffer.from(chunk));
          total += chunk.length;
        }
      } else {
        const chunk = Buffer.from(await response.arrayBuffer());
        sink(chunk);
        total = chunk.length;
      }
      if (Number.isFinite(expected) && !response.headers?.get("content-encoding") && total !== expected) {
        throw fileError("文件下载不完整，实际大小与响应不符");
      }
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw fileError("下载文件超时", error);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (response?.body && !response.bodyUsed) await response.body.cancel?.().catch(() => {});
      controller.abort();
    }
  }

  async downloadStream(reference, sink, signal) {
    let fileSize;
    let fileName = "";
    let totalBytes = 0;
    let chunks = 0;
    const incomplete = () => fileError("NapCat 文件传输不完整");
    const response = await this.connection.send("download_file_stream", { file: reference, chunk_size: FILE_CHUNK_BYTES }, {
      timeoutMs: FILE_TIMEOUT_MS, signal,
      onStream: (data) => {
        if (data.data_type === "file_info") {
          if (fileSize !== undefined || data.file_size === null || data.file_size === ""
            || !Number.isSafeInteger(Number(data.file_size)) || Number(data.file_size) < 0) throw incomplete();
          fileSize = Number(data.file_size);
          this.checkSize(fileSize);
          fileName = String(data.file_name || "");
          return;
        }
        if (data.data_type !== "file_chunk" || fileSize === undefined || data.index !== chunks
          || typeof data.data !== "string" || data.data.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4
          || data.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)) throw incomplete();
        const chunk = Buffer.from(data.data, "base64");
        if (!chunk.length || chunk.length !== data.size || totalBytes + chunk.length > fileSize) throw incomplete();
        sink(chunk);
        totalBytes += chunk.length;
        chunks += 1;
      },
    });
    const complete = response?.data;
    if (complete?.type !== "response" || complete.data_type !== "file_complete" || fileSize === undefined
      || complete.total_chunks !== chunks || complete.total_bytes !== totalBytes || fileSize !== totalBytes) throw incomplete();
    return fileName;
  }

  async upload(filePath, { signal } = {}) {
    signal?.throwIfAborted();
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw fileError("只能发送普通文件，请先将文件夹压缩后发送");
    this.checkSize(stat.size);
    if (!stat.size) throw fileError("NapCat 流式上传不支持空文件，请选择有内容的文件");
    const hash = crypto.createHash("sha256");
    let hashedBytes = 0;
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: FILE_CHUNK_BYTES, signal })) {
      hashedBytes += chunk.length;
      if (hashedBytes > stat.size) throw fileError("文件在上传过程中发生变化，请重试");
      hash.update(chunk);
    }
    if (hashedBytes !== stat.size) throw fileError("文件在上传过程中发生变化，请重试");
    const sha256 = hash.digest("hex");
    const streamId = crypto.randomUUID();
    const totalChunks = Math.ceil(stat.size / FILE_CHUNK_BYTES);
    const name = safeFileName(path.basename(filePath));
    let index = 0;
    let totalBytes = 0;
    let started = false;
    try {
      for await (const chunk of fs.createReadStream(filePath, { highWaterMark: FILE_CHUNK_BYTES, signal })) {
        totalBytes += chunk.length;
        if (totalBytes > stat.size) throw fileError("文件在上传过程中发生变化，请重试");
        const response = await this.connection.send("upload_file_stream", {
          stream_id: streamId, chunk_data: chunk.toString("base64"), chunk_index: index,
          total_chunks: totalChunks, file_size: stat.size, expected_sha256: sha256,
          filename: `${streamId}-${name}`, file_retention: 10 * 60 * 1000,
        }, { timeoutMs: FILE_TIMEOUT_MS, signal });
        const data = response?.data;
        if (data?.stream_id !== streamId || data.received_chunks !== index + 1 || data.total_chunks !== totalChunks) {
          throw fileError("NapCat 文件上传确认不完整");
        }
        started = true;
        index += 1;
      }
      if (totalBytes !== stat.size) throw fileError("文件在上传过程中发生变化，请重试");
      const response = await this.connection.send("upload_file_stream", { stream_id: streamId, is_complete: true }, { timeoutMs: FILE_TIMEOUT_MS, signal });
      const data = response?.data;
      if (data?.status !== "file_complete" || data.stream_id !== streamId || !data.file_path
        || data.file_size !== stat.size || data.sha256 !== sha256) throw fileError("NapCat 文件上传校验失败");
      return { name, size: stat.size, remotePath: String(data.file_path) };
    } catch (error) {
      if (started && this.connection.connected && !signal?.aborted) {
        await this.connection.send("upload_file_stream", { stream_id: streamId, reset: true }, { timeoutMs: 1000 }).catch(() => {});
      }
      throw error;
    }
  }
}

module.exports = {
  FileTransfer, DEFAULT_MAX_FILE_SIZE_MB, fileError, formatFileError, safeFileName,
  normalizeFileSource, fileReference, mergeFiles, formatFileSize, formatFileLabel, resolveSendFilePath,
};
