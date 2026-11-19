const { Transform } = require("node:stream");

const MOUSE_REPORT = /\x1b\[<(\d{1,3});\d{1,10};\d{1,10}([Mm])/g;
const PARTIAL_MOUSE_REPORT = /\x1b(?:\[(?:<[\d;]{0,25})?)?(?![\s\S])/;
const MOUSE_REPORT_TIMEOUT_MS = 50;

class TerminalMouseInput extends Transform {
  constructor(stdin, stdout, onWheel) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.onWheel = onWheel;
    this.trackingRequested = false;
    this.trackingEnabled = false;
    this.pending = "";
    this.pendingTimer = null;
  }

  get isRaw() {
    return this.stdin.isRaw;
  }

  setRawMode(enabled) {
    // readline also changes raw mode when the terminal application is suspended.
    this.stdin.setRawMode(enabled);
    this.updateTracking();
  }

  setTracking(enabled) {
    this.trackingRequested = enabled;
    this.updateTracking();
  }

  updateTracking() {
    const enabled = this.trackingRequested && this.isRaw;
    if (enabled === this.trackingEnabled) return;
    this.trackingEnabled = enabled;
    this.stdout.write(enabled ? "\x1b[?1006h\x1b[?1000h" : "\x1b[?1000l\x1b[?1006l");
  }

  pushInput(text) {
    if (text) this.push(Buffer.from(text, "latin1"));
  }

  takePending() {
    clearTimeout(this.pendingTimer);
    const pending = this.pending;
    this.pending = "";
    this.pendingTimer = null;
    return pending;
  }

  _transform(chunk, _encoding, callback) {
    // Byte-preserving decoding keeps split UTF-8 characters intact for readline.
    const text = this.takePending() + chunk.toString("latin1");

    let start = 0;
    for (const report of text.matchAll(MOUSE_REPORT)) {
      this.pushInput(text.slice(start, report.index));
      start = report.index + report[0].length;
      const button = Number(report[1]) & ~0b11100; // Ignore modifier bits.
      if (this.trackingEnabled && report[2] === "M" && (button === 64 || button === 65)) {
        this.onWheel(button === 64 ? 1 : -1);
      }
    }

    const remaining = text.slice(start);
    const partial = remaining.match(PARTIAL_MOUSE_REPORT);
    this.pushInput(remaining.slice(0, partial?.index ?? remaining.length));
    if (partial) {
      this.pending = partial[0];
      // Escape and CSI can begin a key sequence. CSI < identifies a mouse report.
      if (this.pending.length < 3) {
        this.pendingTimer = setTimeout(() => this.pushInput(this.takePending()), MOUSE_REPORT_TIMEOUT_MS);
      }
    }
    callback();
  }

  _flush(callback) {
    const pending = this.takePending();
    if (pending.length < 3) this.pushInput(pending);
    callback();
  }

  _destroy(error, callback) {
    clearTimeout(this.pendingTimer);
    callback(error);
  }
}

module.exports = { TerminalMouseInput };
