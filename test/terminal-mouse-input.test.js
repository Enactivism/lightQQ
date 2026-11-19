const test = require("node:test");
const assert = require("node:assert/strict");
const readline = require("node:readline");
const { PassThrough } = require("node:stream");
const { setTimeout } = require("node:timers/promises");
const { TerminalMouseInput } = require("../src/terminal-mouse-input");

test("滚轮报告在进入 readline 前被处理，键盘和编辑中的输入照常工作", async (t) => {
  const stdin = new PassThrough();
  stdin.setRawMode = (enabled) => { stdin.isRaw = enabled; };
  const stdout = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(chunk.toString()));
  const directions = [];
  const input = new TerminalMouseInput(stdin, stdout, (direction) => directions.push(direction));
  const rl = readline.createInterface({ input, output: stdout, terminal: true });
  stdin.pipe(input);
  t.after(() => {
    rl.close();
    stdin.destroy();
    input.destroy();
    stdout.destroy();
  });

  input.setTracking(true);
  assert.ok(output.includes("\x1b[?1006h\x1b[?1000h"));
  const firstCharacter = Buffer.from("你");
  stdin.write(firstCharacter.subarray(0, 1));
  stdin.write(firstCharacter.subarray(1));
  stdin.write("\x1b");
  stdin.write("[<64;20;");
  await setTimeout(60);
  assert.equal(rl.line, "你");
  stdin.write("8M\x1b[<65;20;8M\x1b[<0;20;8M\x1b[<0;20;8m\x1b[<66;20;8M好\x1b[D");

  assert.deepEqual(directions, [1, -1]);
  assert.equal(rl.line, "你好");
  assert.equal(rl.cursor, 1);

  input.setTracking(false);
  stdin.write("\x1b[<64;20;8M");
  assert.deepEqual(directions, [1, -1]);
  assert.equal(rl.line, "你好");
  assert.ok(output.includes("\x1b[?1000l\x1b[?1006l"));

  input.setTracking(true);
  rl.close();
  assert.equal(stdin.isRaw, false);
  assert.equal(output.at(-1), "\x1b[?1000l\x1b[?1006l");
});
