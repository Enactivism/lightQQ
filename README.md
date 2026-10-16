# QQlight

QQlight 是一个运行在终端里的轻量 NapCat 客户端，通过 OneBot 11 WebSocket 收取并发送 QQ 私聊、群聊消息。

## 启动

```bash
cd /home/chacha/repo/lightQQ
npm install
npm start
```

本机 NapCat 默认使用 `ws://127.0.0.1:3001`。如地址或 Token 不同，可以通过环境变量覆盖：

```bash
NAPCAT_WS_URL=ws://127.0.0.1:3001 NAPCAT_ACCESS_TOKEN= npm start
```

配置会保存到 `~/.config/qqlight/config.json`。也可以用 `QQLIGHT_CONFIG=/path/to/config.json` 指定配置文件。

## 常用命令

```text
help
status
fp <QQ号>
fg <群号>
ls
send private <QQ号> 你好
send group <群号> 大家好
sg <群号>
sp <QQ号>
sc
history 20
reconnect
quit
```

QQlight 只接收白名单中的消息。使用 `fp <QQ号...>` 和 `fg <群号...>` 设置白名单，使用 `ls` 查看白名单；白名单为空时不接收对应类型的消息。使用 `fp clear` 或 `fg clear` 清空对应白名单。启动时如果还没有配置文件，QQlight 会自动创建默认配置。

其中 `fp` 的全称含义是 `filter private`，`fg` 的全称含义是 `filter group`；程序只接受 `fp` 和 `fg` 短指令。

`sg <群号>` 或 `sp <QQ号>` 会立即进入对应会话，只显示该会话的实时消息。私聊提示符会显示对象昵称；使用 `sc` 可恢复显示白名单消息。

其中 `sp` 的全称含义是 `select private`，`sg` 的全称含义是 `select group`，`sc` 的全称含义是 `select clear`；程序只接受短指令。

进入隔离会话后，直接输入文字即可发送给当前会话；以 `/` 开头的输入仍按命令处理。

在隔离会话中，按 `Ctrl+V` 会读取剪贴板图片并在输入栏插入 `[图片]`，按回车后发送；按 `Ctrl+Shift+V` 会读取剪贴板文字并发送。按 `Ctrl+C` 清除当前输入，按 `Ctrl+D` 退出程序；`Ctrl+Shift+C` 保持终端默认行为。系统需要安装 `wl-paste`、`xclip` 或 `xsel` 中至少一个剪贴板工具。

如需直接使用 `qqlight` 命令，可在项目目录执行 `npm link`，之后运行：

```bash
qqlight
```
