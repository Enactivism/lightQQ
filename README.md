# QQlight：实现在终端里面进行qq聊天

QQlight 是一个运行在终端里的轻量 NapCat 客户端，通过 OneBot 11 WebSocket 收取并发送 QQ 私聊、群聊消息和文件。相比原版qq更加节省内存等资源。

本文中的 `NapCat` 即 NapCatQQ。

> 平台状态：Ubuntu/Linux 是当前开发和验证环境。Windows、macOS 的部署方案已补充，但目前都没有进行实际测试，不保证 NapCat、终端快捷键或剪贴板功能在这些平台上完全可用。

## 工作方式

QQlight 不负责 QQ 登录，也不启动 WebSocket 服务端，而是作为 WebSocket 客户端连接 NapCat 的 OneBot 11 正向 WebSocket 服务端：

```text
QQ ← NapCatQQ（登录 QQ、提供 OneBot 11 WS 服务端） ←→ QQlight（本项目）
```

默认连接地址是 `ws://127.0.0.1:3001`。NapCat 和 QQlight 在同一台机器上时，建议只监听 `127.0.0.1`；跨机器或跨容器部署时，才改成对应的内网地址，并务必配置 Token 和防火墙规则。

## 部署方式：NapCat + QQlight

### 1. 准备环境

- 已安装 Node.js 18 或更高版本。
- 已安装并能正常启动 NapCatQQ。
- 已在 NapCat 中登录 QQ。
- Ubuntu/Linux 下如果需要粘贴图片或文字，至少安装 `wl-paste`、`xclip` 或 `xsel` 其中一个剪贴板工具。
- Windows 和 macOS 的 Node.js 安装方式见下面对应的平台部署说明。

NapCat 官方安装文档：<https://napneko.github.io/guide/install>

### 2. 配置 NapCat 的 OneBot 11 WebSocket

1. 启动 NapCat 并登录 QQ。
2. 从 NapCat 启动日志中打开 WebUI 地址。WebUI 常见端口是 `6099`，实际端口和 Token 以启动日志为准。
3. 进入 **网络配置**，点击 **新建**。
4. 网络类型选择 **WebSocket 服务端**，不要选择 WebSocket 客户端。
5. 使用以下配置：

| 配置项 | 同机部署建议值 | 说明 |
| --- | --- | --- |
| 名称 | `qqlight` | 名称可自定义，但不能与已有配置重复 |
| 启用 | 是 | 保存后确认配置处于启用状态 |
| Host | `127.0.0.1` | NapCat 与 QQlight 同机时使用 |
| Port | `3001` | 必须与 QQlight 的 WebSocket 地址一致 |
| 消息格式 | `array` | 使用 OneBot 11 数组消息格式 |
| 上报自身消息 | 否 | QQlight 会在本地记录自己发送的消息 |
| Token | 随机长字符串 | 推荐设置，不要使用 WebUI 登录 Token |

NapCat 的 WebUI 网络配置和配置文件示例见官方文档：

- <https://napneko.github.io/config/basic>
- <https://napneko.github.io/onebot/network>

如果使用配置文件而不是 WebUI，可将下面的 `websocketServers` 合并到现有 OneBot 11 配置中；不要直接覆盖已有的其他网络配置：

```json5
{
  "network": {
    "websocketServers": [
      {
        "name": "qqlight",
        "enable": true,
        "host": "127.0.0.1",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "请替换为随机长字符串",
        "enableForcePushEvent": true,
        "debug": false,
        "heartInterval": 30000
      }
    ]
  }
}
```

如果 NapCat 和 QQlight 不在同一台机器上，NapCat 的 Host 需要监听 QQlight 可访问的内网地址，QQlight 则使用 `ws://<NapCat内网地址>:3001`。不要把没有 Token 的 OneBot WebSocket 端口暴露到公网。

### Windows 部署方案（未测试）

Windows 上可以按下面的方式部署 QQlight；NapCat 也需要在 Windows 上正常登录并提供 OneBot 11 WebSocket 服务端。以下命令请在 PowerShell 中执行：

```powershell
git clone <QQlight仓库地址>
Set-Location lightQQ
npm ci

$env:NAPCAT_WS_URL = "ws://127.0.0.1:3001"
$env:NAPCAT_ACCESS_TOKEN = "与 NapCat 完全一致的 Token"
npm start
```

NapCat 与 QQlight 同机时使用 `127.0.0.1`；如果 NapCat 在其他机器上，将地址改为 NapCat 的内网地址，并在 Windows 防火墙中只允许可信内网访问对应端口。NapCat 的 WebSocket 配置仍然选择 **WebSocket 服务端**，字段与上面的配置表保持一致。

Windows 方案目前没有进行实际测试。核心 Node.js 消息收发是否正常需要在目标 Windows 版本上验证；当前项目也没有专门实现 Windows 原生剪贴板适配，因此 `Ctrl+V` 图片和 `Ctrl+Shift+V` 文字粘贴暂不保证可用。

### macOS 部署方案（未测试）

macOS 部署必须依赖额外设备或远程主机运行 NapCat，例如另一台 Windows/Linux 电脑、Linux 服务器或受支持的虚拟机。macOS 本机只运行 QQlight，通过局域网 WebSocket 连接该额外设备上的 NapCat；不要把 macOS 本机运行 NapCat 当作正式部署方案。

#### 方案：macOS 运行 QQlight，额外设备运行 NapCat

这是 macOS 下唯一推荐的拓扑。NapCat 运行在额外的 Linux 或 Windows 主机，macOS 只运行 QQlight：

```bash
# 已安装 Node.js 18+ 后执行
git clone <QQlight仓库地址>
cd lightQQ
npm ci

export NAPCAT_WS_URL="ws://<NapCat内网地址>:3001"
export NAPCAT_ACCESS_TOKEN="与 NapCat 完全一致的 Token"
npm start
```

额外设备上的 NapCat WebSocket 服务端需要监听 macOS 可访问的内网地址，并设置 Token；不要把端口直接暴露到公网。macOS 上的 `NAPCAT_WS_URL` 应填写额外设备的内网 IP 或主机名，而不是 `127.0.0.1`。

NapCat 官方当前发布页标注 macOS 暂不支持，因此 macOS 同机运行 NapCat 不能视为可用部署方式：<https://github.com/NapNeko/NapCatQQ/releases/>

macOS 文字剪贴板使用系统 `pbpaste`，图片剪贴板使用系统 `osascript` 路径；这部分代码同样尚未在 macOS 实机上测试。macOS 的图片查看使用 `open`，如果终端或脚本访问剪贴板时出现系统权限提示，需要按 macOS 提示授予相应权限。

### 3. 安装并启动 QQlight

在 QQlight 项目目录执行：

```bash
npm ci
npm start
```

也可以先复制项目，再安装依赖：

```bash
git clone <QQlight仓库地址>
cd lightQQ
npm ci
npm start
```

如果 NapCat 使用了 Token，在启动 QQlight 时设置相同的 Token：

```bash
NAPCAT_WS_URL=ws://127.0.0.1:3001 \
NAPCAT_ACCESS_TOKEN='与 NapCat 完全一致的 Token' \
npm start
```

启动后应看到类似以下状态：

```text
[状态] 正在连接 NapCat：ws://127.0.0.1:3001
[状态] NapCat WebSocket 已连接
```

QQlight 的配置文件默认保存到 `~/.config/qqlight/config.json`，也可以通过 `QQLIGHT_CONFIG` 指定路径：

```bash
QQLIGHT_CONFIG=/绝对路径/qqlight-config.json npm start
```

启动后可以在 TUI 中输入 `/config` 修改连接。

1. 输入 NapCat 的 WebSocket 地址，例如 `ws://192.168.1.10:3001`；直接回车保留原地址。
2. 输入对应的 OneBot Token，输入内容不会回显，也不会保留在命令历史中；直接回车保留原 Token，输入 `clear` 清空。
3. 核对地址和 Token 设置状态，输入 `y` 或直接回车，保存到当前配置文件并立即重连。

任一步骤都可以输入 `/cancel` 或按 `Ctrl+C` 放弃修改，确认时输入 `n` 也会取消。连接失败或尚未连接时同样可以打开配置表单；地址或 Token 格式不合法时会提示重新输入，保存失败时保留原连接配置。

`NAPCAT_WS_URL` 和 `NAPCAT_ACCESS_TOKEN` 的优先级高于配置文件。TUI 保存的值立即在当前进程生效；如果启动时设置了这些环境变量，下次启动仍会使用环境变量中的对应值。

### 4. 设置白名单并验证

QQlight 只支持白名单模式。启动后在终端输入：

```text
/fp <QQ号...>       追加私聊白名单
/fg <群号...>       追加群聊白名单
/ls                 查看当前白名单
```

例如：

```text
/fp 123456789 234567890
/fg 987654321 876543210
/ls
```

白名单为空时，不接收对应类型的消息；不在白名单中的私聊或群聊消息会被直接忽略。使用 `/fp clear` 或 `/fg clear` 可清空对应白名单。

连接和白名单验证通过后：

```text
/sp <QQ号>          进入白名单中的私聊，并隔离其他聊天
/sg <群号>          进入白名单中的群聊，并隔离其他聊天
/sc                 取消隔离，恢复显示全部白名单消息
```

进入隔离聊天后，直接输入文字即可发送给当前聊天。未进入隔离聊天时，发送消息前需用 `/sp` 或 `/sg` 选择会话。

## 常用命令

所有聊天命令都以 `/` 开头。在会话中输入 `help` 会发送这条消息，输入 `/help` 会打开帮助。

```text
/ls
/fp <QQ号...>
/fg <群号...>
/fp clear
/fg clear
/sp <QQ号>
/sg <群号>
/sc
/history [数量]
/sync
/sync all
/gls [关键词]
/op img [index]
/sendfile <本地文件路径>
/send file <本地文件路径>
/status
/config
/help
/reconnect
/quit
```

命令全称仅用于帮助记忆，不作为可输入指令：

- `/fp`：`filter private`
- `/fg`：`filter group`
- `/sp`：`select private`
- `/sg`：`select group`
- `/sc`：`select clear`

其他交互：

- 使用 `/sp` 或 `/sg` 进入会话后，自动加载该聊天最近 20 条历史消息。输入这两个命令时可按 Tab 补全白名单号码。
- 在聊天窗口中用鼠标滚轮或 `Ctrl+↑`、`Ctrl+↓` 翻阅消息。向上翻到已加载的历史开头后，继续向上可读取更早的记录。
- `/history [数量]` 显示当前隔离聊天的历史消息。
- `/sync` 补同步当前隔离聊天。没有选择聊天时同步全部白名单。`/sync all` 始终同步全部白名单。
- `/status` 同时显示历史同步任务数、未完成聊天数和最近成功时间。
- 在群聊隔离会话中，`/gls` 列出全部群成员，`/gls 关键词` 模糊搜索名称中包含关键词的成员，并显示 QQ 号。
- 在群聊中输入 `[QQ号/昵称]消息` 可@指定成员，例如 `[123456789]你好` 或 `[叉叉.L]你好`；私聊中会按普通文本发送。原来的 `@QQ号 消息` 写法也兼容。
- `/op img` 打开当前范围内最近的一张图片，`/op img 2` 打开上一张，以此类推。进入隔离聊天后，只能打开当前聊天消息中的图片。
- `/sendfile <本地文件路径>` 向当前隔离会话发送文件，也支持 `/send file` 写法。收到的文件会在后台自动保存，并显示保存文件夹和完整路径。
- `Ctrl+V` 将剪贴板图片放入输入栏并显示 `{图片}`，按回车后发送。
- `Ctrl+Shift+V` 将剪贴板文字粘贴到输入栏，按回车后发送；文字中的换行不会自动发送消息。
- `Ctrl+C` 清除当前输入；`Ctrl+D` 退出程序。

## 收发文件

先使用 `/sp <QQ号>` 或 `/sg <群号>` 进入白名单聊天，再用 `/sendfile` 发送本机文件。

```text
/sendfile /home/user/文档/报告.pdf
/sendfile "/home/user/文档/项目 资料.zip"
/sendfile ~/Downloads/演示.pptx
```

也可使用 `/send file <本地文件路径>`。支持绝对路径、相对路径、`~/` 用户目录和 `file://` 文件地址。带空格的路径可以整体加单引号或双引号。路径属于运行 QQlight 的机器，发送前不需要手动复制到 NapCat 主机。

文件按原始二进制传输，不限制扩展名，常见格式包括：

- 文档和数据：TXT、Markdown、PDF、Word、Excel、PowerPoint、CSV、JSON 等。
- 压缩包：ZIP、7Z、RAR、TAR、GZ 等。
- 图片、音频和视频文件：JPG、PNG、GIF、MP3、WAV、MP4、MKV 等。

这些格式通过 `/send file` 作为文件附件发送。剪贴板图片使用 `Ctrl+V`。发送文件夹前请先压缩；NapCat 的流式上传不支持空文件。

白名单聊天里的文件消息、群文件上传通知和私聊离线文件通知都会触发自动保存。保存目录位于 **运行 QQlight 的机器**，默认按账号和会话放在项目的 `.qqlight/files/` 下，每个附件使用独立子目录保留原文件名，同名文件不会相互覆盖。保存完成后的显示示例：

```text
[文件] 报告.pdf（12.0 KiB） 已保存
保存文件夹：/home/user/lightQQ/.qqlight/files/登录QQ号/private-好友QQ号/file-xxxxxx
文件路径：/home/user/lightQQ/.qqlight/files/登录QQ号/private-好友QQ号/file-xxxxxx/报告.pdf
```

文件路径会一同写入聊天历史，重新进入聊天或重启后仍可查看。下载在独立后台队列执行，不会阻塞后续文字消息。失败时显示原因，重新进入聊天或执行 `/sync` 可重试。重复同步已保存的文件会复用本地副本。隔离聊天期间，其他白名单会话的文件仍保存到磁盘，其提示在对应聊天中查看。

默认单文件收发上限为 **100 MiB**，可在配置文件中设置 `maxFileSizeMb`，支持 1–2048 MiB。`/status` 会显示接收目录和大小上限。例如：

```json
{
  "maxFileSizeMb": 200
}
```

文件发送依赖 NapCat 的 `upload_file_stream`，随后调用 `upload_private_file` 或 `upload_group_file`；下载优先使用文件链接，失败后尝试 `download_file_stream`、刷新链接和 `get_file`。建议使用支持流式接口的 NapCat（v4.8.115+），接口说明见 [NapCat 官方文件处理文档](https://napneko.github.io/develop/file)。分块上传会验证 SHA-256，下载会检查大小和分片完整性，失败或退出时清理本机未完成文件。旧版 NapCat 仍可通过可用下载链接、`get_file` 的 Base64 数据或同机可读路径接收文件；文件已过期、群文件权限不足或 QQ 限制上传时，需要根据报错处理。

## 启动和重连时补同步历史

QQlight 连接成功后会确认 NapCat 登录账号，自动补拉全部白名单聊天的历史；新增白名单也会同步新加入的聊天。用 `/sp` 或 `/sg` 进入会话时先展示本地记录，距离该聊天上次成功同步超过 60 秒则在后台同步。实时收发与历史请求同时进行，补回记录不会逐条刷屏，当前隔离聊天会在合并后刷新。

- 已有本地记录的聊天：首次升级以启动前最近一条有效远端消息 ID 为边界，分页补回该条之后的记录。
- 没有本地记录的聊天：首次初始化最近一页，默认 50 条；之后按保存的边界增量补拉。
- 每页包含的重复边界消息按 ID 去重。消息使用 QQ 原始时间排序，同一条消息可补充准确时间和图片信息。
- `maxHistory` 只限制内存中的聊天窗口；分页补回的消息全部写入磁盘。
- 同步边界只在本轮消息写入成功后更新。断线、接口失败或退出时保留原边界，下次从最新页重新扫描并去重，继续补回缺失区间。
- 某个聊天失败不影响其他聊天。找不到旧边界、游标无法前进或写入失败时显示“同步未完成”，可用 `/sync` 重试。
- 图片独立排队保存，失败不会阻塞消息正文同步。历史保存可重试的图片引用，重新同步或读取这些记录时可以重试补存。

配置文件可加入以下选项，范围分别是 2–100 条和 1–4 个聊天：

```json
{
  "syncPageSize": 50,
  "syncConcurrency": 2
}
```

默认单次历史请求超时 15 秒，临时错误额外重试两次，间隔 1 秒、3 秒；每个聊天读取 20 页后短暂让出执行权，再自动继续，20 页不作为总量上限。

同步状态位于 `.qqlight/sync-state.json`，按登录账号和聊天区分。旧格式历史在首次成功确认账号时绑定给该账号；新记录带账号标识，切换账号不会复用其他账号的同步边界或记录。状态文件损坏时保留原文件并提示重新初始化，旧历史完整性不作保证。

补同步依赖 NapCat 的 `get_friend_msg_history`、`get_group_msg_history` 接口实际可返回的记录。QQ / NapCat 自身离线、历史被清理、消息撤回或媒体过期时，无法保证全部恢复。首次升级之前更早的历史空洞不会自动全量追溯。

## 数据与隐私

- 白名单配置默认位于用户目录下的 `~/.config/qqlight/config.json`，不保存在项目源码中。
- 聊天历史按私聊或群聊账号独立保存到项目目录下的 `.qqlight/history/`，不会混合不同聊天。
- 收发图片保存到 `.qqlight/images/`，历史中保留 `{图片}` 和本地路径。
- 接收文件保存到 `.qqlight/files/`，历史中保留文件名、大小、保存路径和可重试的文件引用；文件下载链接同样可能包含临时访问凭据。
- 同步状态、账号标识和待补存图片引用也只保存在 `.qqlight/` 下；图片引用可能包含临时下载链接，应与聊天历史一同保护。
- `.qqlight/`、本地配置、Token、密钥、日志、数据库、临时文件和常见证书文件均已加入 `.gitignore`，不会被 Git 跟踪。
- 不要将真实 QQ 号、Token、聊天记录、图片或其他本地隐私文件强制 `git add -f` 到仓库。

## 直接使用 `qqlight` 命令

在项目目录执行：

```bash
npm link
qqlight
```

## 故障排查

### 显示 WebSocket 连接失败

1. 确认 NapCat 已登录 QQ。
2. 确认 NapCat 创建的是 **WebSocket 服务端**，并已启用。
3. 确认端口没有被其他程序占用，且 `NAPCAT_WS_URL` 与 NapCat 的 Host、Port 一致。
4. 如果配置了 Token，确认 NapCat Token 与 `NAPCAT_ACCESS_TOKEN` 完全一致。
5. 跨机器或 Docker 部署时，确认地址使用的是 QQlight 能访问的内网地址，而不是 NapCat 容器内部的 `127.0.0.1`。

### 收不到消息

执行 `/ls` 检查白名单。使用 `/fp` 或 `/fg` 添加 QQ 号或群号，白名单保存后立即生效。

### 粘贴图片失败

- Ubuntu/Linux 下安装 `wl-clipboard`、`xclip` 或 `xsel`，然后重新启动终端。
- macOS 使用 `pbpaste` 和 `osascript`，但尚未进行实机测试；如果系统拒绝访问剪贴板，请检查终端权限。
- Windows 的原生剪贴板适配尚未完成，`Ctrl+V` 和 `Ctrl+Shift+V` 可能无法使用。

图片只会在按回车后发送，单独按 `Ctrl+V` 不会立即发送。

### 图片保存失败

QQlight 会优先尝试消息中的图片链接；下载超时、DNS 失败或链接失效时，自动通过已有的 NapCat WebSocket 连接分块取回图片，不需要在本机读取 NapCat 主机上的文件。NapCat 流式接口见[官方文件处理文档](https://napneko.github.io/develop/file)。旧版 NapCat 不支持流式下载时，仍会尝试 `get_image` 刷新链接和网络重试。

如果仍然出现 `[错误] 接收图片保存失败`：

- 图片需要从 `multimedia.nt.qq.com.cn` 下载。QQlight 会读取 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 环境变量（支持 `NO_PROXY` 例外），例如 `HTTPS_PROXY=http://127.0.0.1:7890 npm start`；代理未开启时会自动退回直连。
- 确认 NapCat 能打开该图片。跨机器或跨容器部署时，建议使用支持 `download_file_stream` 的 NapCat；本机 DNS、IPv6 或代理不可用时，仍可通过 NapCat 传回图片。
- 报错形如 `NapCat 主机上的图片文件本机无法读取` 时，说明拿到的是 NapCat 自己主机上的绝对路径（例如 `/app/.config/QQ/...`），且自动传输也未成功。检查 NapCat 版本和连接，或保证本机能下载 NapCat 给出的图片链接。
- 重启后同步或进入对应聊天时，会继续尝试补存历史中的待下载或失败图片，无需重新发送消息。
- 图片保存在后台执行，保存失败或很慢都不会阻塞后续消息显示。
