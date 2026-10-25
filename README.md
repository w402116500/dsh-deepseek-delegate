# DeepSeek 委派

DeepSeek Harness 插件：在原生侧边栏派发和管理任务，通过 stdio MCP 让 Codex 等客户端使用同一队列。任务由本机 Harness CLI 执行，支持第三方模型路由、原生会话续聊和取消。

模型路由在设置中配置，格式为 `provider/model`。插件复用 Harness 的供应商声明和已保存凭据。

## 安装

要求 Node.js 22 以上、DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`。当前 CLI 自动检测和进程管理主要面向 Windows。

```powershell
git clone https://github.com/w402116500/dsh-deepseek-delegate.git
cd dsh-deepseek-delegate
npm ci
npm run build
npm run plugin:install
```

等待安装命令结束后启动或重启 Harness，在侧边栏选择 **DeepSeek 委派**。安装程序通过官方 `dsh plugin --profile desktop add <项目目录>` 链接此目录，并在 desktop profile 下备份依赖清单。安装后请保留项目目录；移动后需要重新安装，并更新 MCP 路径。

CLI 默认从当前 Harness 进程、`DSH_EXECUTABLE`、常见安装位置和 PATH 检测。如果没有找到，可设置环境变量后安装：

```powershell
$env:DSH_EXECUTABLE = 'C:\path\to\DSH Desktop.exe'
npm run plugin:install
```

## 使用界面

- **任务**：派发任务，查看状态、回答、工作目录和执行日志；取消排队或运行任务。
- **继续对话**：接续已完成任务的 Harness 原生会话，要求模型路由与工作目录一致。
- **设置**：选择模型路由、CLI、工作目录、权限、并发数和超时；控制是否复用登录和第三方供应商。
- **MCP 连接**：复制当前机器适用的 Codex TOML 或通用 MCP JSON。
- **连通性测试**：发送要求不调用工具、不访问文件的测试提示，预期回答 `DEEPSEEK_PLUGIN_OK`。

默认只读、单任务并发、600 秒超时。后台任务无法处理交互审批，因此审批策略为 `never`，文件访问仍由所选 Harness 沙箱模式控制。允许写入后，任务可能使用工具修改工作目录。

第三方供应商默认从 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai` 配置读取。只引入供应商声明，凭据由 Harness 自己加载。请先确认相同路由能在 Harness 中使用。

## 连接 Codex

保持 Harness 运行，并启用插件。执行以下命令获取配置，或在管理页面复制：

```powershell
npm run config
```

将输出加入 Codex 的 `config.toml`。以下仅展示结构，请替换占位路径：

```toml
[mcp_servers.deepseek_delegate]
command = "node"
args = ["/absolute/path/to/dsh-deepseek-delegate/src/cli.mjs", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.deepseek_delegate.env]
DEEPSEEK_MCP_DATA = "/absolute/path/to/delegate-data"
```

路径以本机生成的配置为准。重新加载客户端的 MCP 连接，或在新对话中验证工具。插件不自动修改 Codex 配置。

| 工具 | 用途 |
| --- | --- |
| `delegate_to_deepseek` | 立即返回任务 ID；传入 `continueTaskId` 可续聊 |
| `get_task` | 获取状态、回答、会话 ID 和日志 |
| `wait_task` | 等待最多 30 秒；仍在排队/运行时可再次调用 |
| `cancel_task` | 取消任务，并终止该任务拥有的进程树 |
| `list_tasks` | 列出任务摘要 |
| `get_deepseek_settings` | 读取委派设置 |

示例参数：

```json
{"prompt":"分析此项目的入口和主要模块，不修改文件。","cwd":"/absolute/path/to/workspace"}
```

MCP 初始化不要求 Harness 在线；调用业务工具时才发现插件。关闭或重启 Harness 后，下次调用会重新读取服务地址。失败或中断任务不会自动重试；重新派发前应先检查日志和工作目录。

## 数据与连接

默认数据目录是 `~/.dsh/deepseek-delegate`，可用 `DEEPSEEK_MCP_DATA` 修改。插件和 MCP 需要使用同一目录。

- `config.json`：委派设置。
- `tasks.json`：任务及结果，包含提示、回答和执行日志。
- `runtime.json`：运行时本地地址和随机连接令牌，关闭插件时清理。
- `server.lock/`：防止同一数据目录被重复使用。

任务记录对常见密钥格式进行脱敏，但不应依赖它保存任意敏感数据。临时运行 patch 在任务结束后删除。外部 MCP 通过仅监听 `127.0.0.1`、要求随机令牌的 HTTP 通道连接插件。管理界面使用 Harness 自带的认证连接通道；重新启用插件或重启 Host 后会自动恢复连接。

## 开发与验证

```powershell
npm run build
npm test
```

测试覆盖真实子进程事件处理、续聊参数、失败与退出时日志、取消、插件卸载与启动中停用、保留页面连接后的反复启停、桌面来源检查、令牌验证以及 stdio MCP 的离线初始化/在线发现。

```powershell
npm run test:lifecycle
```

启停验证使用已安装的 Harness 桌面运行时，创建独立的临时 Host 和内存认证，不读取用户凭据、不调用模型。它通过官方客户端 RPC 验证三轮插件启停与重载、Host 更换后的连接恢复、设置持久化和路由认证。可用 `DSH_EXECUTABLE` 指定 `DSH Desktop.exe`、`DeepSeek Harness.exe` 或官方 `dsh.cmd`。

```powershell
npm run test:smoke
```

真实冒烟测试要求 Harness 正在运行并已启用本插件，会使用当前模型供应商额度。它验证 MCP 派发、会话记忆续聊、取消和共享任务列表；测试提示要求不调用工具和不访问文件。

修改后重新构建，并重启 Harness 载入 Host/Client 新代码。项目包含构建后的 `lib/client.js`，但开发依赖仍需安装。

```text
src/plugin.mjs       Harness 插件生命周期
src/server.mjs       本地传输、界面接口和 MCP 配置
src/harness.mjs      官方 CLI 启动与供应商 overlay
src/tasks.mjs        持久化队列、会话、进程和事件处理
src/mcp.mjs          stdio JSON-RPC 入口
src/ui/             原生侧边栏 React 页面
scripts/            构建、安装/卸载、真实冒烟测试
test/               集成测试和 CLI fixture
```

## 故障排查与卸载

- **cannot resolve profile bundle**：确认安装命令已经成功结束、项目目录仍存在。运行 `npm run plugin:install` 修复链接，然后重启 Harness。
- **页面无法连接**：确认插件已启用；页面会自动重连。更新插件代码后，运行 `npm run build` 并重启 Harness，以载入新版本。
- **找不到 CLI**：在设置中填入官方 `dsh.cmd`、`DeepSeek Harness.exe` 或 `DSH Desktop.exe` 的绝对路径。
- **供应商未注册或鉴权失败**：检查设置中的供应商文件和模型路由，以及 Harness 已保存的对应凭据。错误会保留在任务日志里。
- **服务已在运行**：同一数据目录只能启用一个实例。正常退出旧实例后重试；不要在进程仍运行时手动删除锁目录。

```powershell
npm run plugin:uninstall
```

卸载保留任务数据。许可证为 [AGPL-3.0-only](LICENSE)，参考项目见 [NOTICE.md](NOTICE.md)。本项目是第三方插件，与 DeepSeek、OpenAI 无隶属关系。
