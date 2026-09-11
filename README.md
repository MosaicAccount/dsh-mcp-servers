# dsh-mcp-servers

在 DeepSeek Harness 里挂载外部 [Model Context Protocol](https://modelcontextprotocol.io) 服务：用一份 `mcp.json` 或一行 `cordis.yml` 配置，并在 Web 设置面板的 **MCP** 页面里增删改。

这是一个**独立插件包**——不属于 harness 仓库，不包含在任何内置 bundle 里，你不装就不会生效。它没有任何运行期依赖：`lib/index.js` 把所有依赖都内联了，浏览器半边只向外壳已有的模块表请求条目。

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [配置服务](#配置服务)
- [设置页面](#设置页面)
- [服务字段](#服务字段)
- [实例：接入 drawio / codegraph / gitnexus](#实例接入-drawio--codegraph--gitnexus)
- [排查](#排查)
- [从源码构建](#从源码构建)
- [作为其他插件的模板](#作为其他插件的模板)
- [已知限制](#已知限制)
- [测试覆盖了什么](#测试覆盖了什么)

## 它解决什么问题

harness 自带 `@deepseek-ai/dsh-mcp-client`，它一条 `cordis.yml` 行只连**一台** MCP 服务，而且改配置要动文件、重启才生效。

本插件负责维护"有哪些服务"这份清单：

```
mcp.json / 组合配置 / 设置页面写入
              │
              ▼
      dsh-mcp-servers          ← 本插件：清单的所有者
              │  reconcile
              ▼
   dsh-mcp-client 行 × N       ← 每台启用的服务挂一条
              │  MCP stdio / HTTP
              ▼
       工具注册进 ToolRuntime
              │
              ▼
   模型每轮请求都看到这些工具
```

几个直接结果：

- 工具以 `mcp__<服务名>__<工具名>` 出现，和 harness 原生工具**平级**。
- 在设置页面保存会立即挂载或卸载服务，不用改文件、不用重启。
- 挂载的行是运行时创建的，而 `Loader.write()` 是空操作，所以本插件挂载的东西**永远**不会被写回你的组合文件。
- 卸载插件会移除它创建过的每一行。

## 安装

一条命令。指向本目录，**开头的 `./` 不能省**——`dsh plugin` 会把参数原样转给 pnpm，而 pnpm 会把裸的 `work-space/...` 当成 registry 上的包名而不是路径。绝对路径也可以。

```sh
dsh plugin --profile web add ./path/to/dsh-mcp-servers
```

这条命令做了三件事：

1. pnpm 把包装进 `<harness home>/profiles/web/node_modules`。
2. 因为装好的 manifest 声明了 `dsh.bundle.patch`，`dsh plugin` 会把 `dsh-mcp-servers` 追加进 profile manifest 的 `dsh.profile.bundles`。
3. 下次启动时 profile 为每个 bundle 组合一层补丁，于是本包自带的 `cordis.patch.yml` 生效，插入 `mcp-servers` 那一行。

**重启 harness**，然后打开 **设置 → MCP**。不需要编辑任何组合文件，也不需要第二个条目：这一行的 Node 半边就是插件，而 Web 外壳的客户端模块系统会发现同一个包上的 `dsh.client` 声明，把它的 `lib/client.js` 提供给页面。

卸载：

```sh
dsh plugin --profile web remove dsh-mcp-servers
```

### 其他安装方式

**从 registry、git 或任何 pnpm 认识的 spec 安装：**

```sh
dsh plugin --profile web add dsh-mcp-servers
dsh plugin --profile web add github:you/dsh-mcp-servers
```

**手工登记**（不想让 CLI 改 profile manifest）：先只安装，再自己把包名写进 `dsh.profile.bundles`。

```sh
dsh plugin --profile web add --save-exact=false ./path/to/dsh-mcp-servers
```

```jsonc
// <harness home>/profiles/web/package.json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mcp-servers"] } }
```

**一次性 overlay**，不往 profile 装任何东西、也不改 manifest：

```sh
dsh web --patch "$PWD/examples/mcp-servers.patch.yml"
```

**从源码 checkout 运行**：用 file URL 直接把配置行指到构建产物。纯 Cordis 应用在没有任何其他包的情况下也能激活它（本仓库测试就是这么验证的）：

```yaml
- insert:
    - id: mcp-servers
      name: 'file:///absolute/path/to/dsh-mcp-servers/lib/index.js'
```

> 注意：这种情况下裸包名是从 Loader 自身所在位置解析的，而不是从你的配置文件目录。所以只有当包确实位于正在运行的安装的依赖闭包内，裸名字才找得到。

### 为什么包里没有 `cordis.yml`

因为插件不是组合。`cordis.yml` 属于"挂载插件的那个部署"，插件包提供的是代码加上用于挂载自己的补丁层。本包提供两份组合片段：

| 文件 | 用途 |
|---|---|
| `cordis.patch.yml` | 由 `dsh.bundle.patch` 指名的 bundle patch，凡是把本包列入 `dsh.profile.bundles` 的 profile 都会自动应用 |
| `examples/mcp-servers.patch.yml` | 供 `dsh web --patch` 使用的独立 overlay，里面填了示例服务 |

运行期也不依赖 Cordis：插件是通过参数收到 `ctx` 的，`import type { Context }` 会被擦除，所以构建出的 `lib/index.js` **不包含任何 import 语句**。

## 配置服务

三层，后者覆盖前者：

| 层 | 位置 | 由谁编辑 |
|---|---|---|
| `mcp.json` | `path`，默认 `<harness home>/mcp.json` | 你用任意编辑器 |
| 内联 `mcpServers` | 那一行的 `config` | 你在组合文件里 |
| 用户覆盖 | `<harness home>/settings.yaml` 的 `mcp-servers` 段 | 设置页面 |

`mcp.json` 用的是其他 MCP 客户端同样的 `mcpServers` 映射，已有文件可以直接复用：

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "remote": { "url": "http://localhost:3000/mcp" }
  }
}
```

**该文件只在插件激活时读取一次**；运行期改它需要下次重载才生效。要即时生效就用设置页面。

组合行的配置项：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `<harness home>/mcp.json` | 填充基础层的文件；文件不存在时不贡献任何服务 |
| `mcpServers` | `{}` | 内联组合的服务，合并在文件之上并按名称覆盖 |

## 设置页面

打开 **设置 → MCP**。

- **添加服务**：暂存一个空条目，写入前先校验名称、传输方式以及该传输方式必需的字段。
- **编辑**：重新打开某个条目。改名会在**同一次原子修改**里删掉旧键、写入新键。
- **删除**：先确认，再移除该键，服务随即卸载。

保存以 Host 最终存下来的内容为准。如果读回的值和写入的不同，编辑器会保持打开并保留你输入的内容，页面给出提示——而不是在一个其实没存进去的值上直接关闭。

## 服务字段

每个条目以服务名为键，也就是它工具的名称空间。名称必须匹配 `[A-Za-z0-9_-]{1,32}`。

| 字段 | 含义 |
|---|---|
| `enabled` | 是否挂载（默认 `true`）。停用后保留配置但不挂载 |
| `transport` | `stdio` 或 `streamable-http`；缺省时由 `command`/`url` 推断 |
| `command`、`args`、`env`、`cwd` | stdio：可执行文件、参数、额外环境变量、工作目录 |
| `url`、`headers` | streamable-http：端点地址与额外请求头 |
| `toolCallTimeoutMs` | 单次工具调用超时，缺省用 bridge 的 60000 |

> **凭据**：`env` 与 `headers` 会明文存进设置文档并回传到浏览器，部署授权的任何客户端都能读到。需要只写密钥的场景，请把值留在启动环境里，从组合行引用。

## 实例：接入 drawio / codegraph / gitnexus

写入 `~/.dsh/mcp.json` 即可（重启后生效）：

```json
{
  "mcpServers": {
    "drawio": {
      "command": "/absolute/path/to/drawio-mcp",
      "args": []
    },
    "codegraph": {
      "command": "/absolute/path/to/codegraph",
      "args": ["serve", "--mcp"]
    },
    "gitnexus": {
      "command": "/absolute/path/to/gitnexus",
      "args": ["mcp"]
    }
  }
}
```

三个命令的来源：

| 服务 | 安装 | 启动命令从哪来 |
|---|---|---|
| drawio | `npm i -g @drawio/mcp`（官方包） | 包提供的 bin 就是 `drawio-mcp` |
| codegraph | 已随 CLI 安装 | `codegraph install --print-config claude` 会打印它给各 agent 写的 MCP 配置片段 |
| gitnexus | 已随 CLI 安装 | `gitnexus mcp` 子命令 |

之后这三台服务的全部工具会以 `mcp__drawio__*`、`mcp__codegraph__*`、`mcp__gitnexus__*` 出现在模型工具表里。

**两个服务需要先建索引才有用**：

```sh
codegraph init      # 在要分析的项目里执行，生成 .codegraph/
gitnexus analyze    # 生成并注册知识图谱索引
```

没索引时 codegraph 会明确拒绝查询，并提示模型改用内置工具——这是它设计得好的地方。

## 排查

**设置面板里没有 MCP 页面。** Host 行没挂上。按顺序看：

1. profile manifest（`<harness home>/profiles/web/package.json`）里 `dsh.profile.bundles` 是否包含 `dsh-mcp-servers`；
2. `<harness home>/profiles/web/node_modules/dsh-mcp-servers` 是否存在，且 `lib/index.js`、`lib/client.js` 都已构建（`pnpm build`）；
3. 进程是否在安装之后重启过。

**页面显示"当前部署无法提供 MCP 服务列表"。** Host 行挂了但设置命名空间没提供出来，通常是插件激活失败——看 harness 日志里 `mcp-servers:` 开头的报错。

**服务配了但模型看不到工具。** 按顺序查：

1. 该条目的 `enabled` 不是 `false`；
2. `command` 指向的可执行文件在 MCP 子进程里能跑起来（子进程只继承清洗过的环境，名字像凭据的变量和所有 `DSH_*` 会被移除）；
3. 服务名没和某条 `cordis.yml` 里 `@deepseek-ai/dsh-mcp-client` 行重名——重名时后来者挂载失败，日志里会有 bridge 自己的重复名称空间报错；
4. `~/.dsh/mcp.json` 是合法 JSON——JSON 坏了插件会在激活时直接失败。

**改了 `mcp.json` 不生效。** 这是预期行为，该文件只在激活时读一次。用设置页面，或重启。

## 从源码构建

```sh
pnpm install       # 或者 npm install
pnpm run build     # lib/index.js、lib/client.js、lib/types/**
pnpm test
pnpm run typecheck
```

`pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 固定了构建；workspace 文件里带着 pnpm 接受这些刚发布的预发布依赖前所需的 `minimumReleaseAgeExclude` 条目。

构建产物：

| 文件 | 内容 |
|---|---|
| `lib/index.js` | 纯 ESM，零运行期 import |
| `lib/client.js` | 浏览器半边，交给 `window.__ModuleLoader__.load({ id, factory })` 的惰性 CommonJS 工厂 |
| `lib/types/**` | 类型声明 |

## 作为其他插件的模板

如果你要照着写一个自己的 DSH 插件，下面这些是可直接复用的部分：

- `tsdown.config.ts` —— 自包含复刻了 DSH 的客户端产物契约：`window.__ModuleLoader__.load` 包装、模块表外部化、CSS Modules 编译、跨插件值导入拦截。**想 fork 就从读这个文件开始。**
- `src/client/index.ts` —— 通过 `slots.inject('settings.section', ...)` 注册设置页面的写法。
- `tests/bundle-composition.spec.ts` —— 用真实 profile loader 验证 bundle 声明的写法。
- `cordis.patch.yml` + `package.json` 里的 `dsh.bundle` / `dsh.client` 声明。

## 已知限制

- **设置页面看不到组合行。** 由自己的 `cordis.yml` `@deepseek-ai/dsh-mcp-client` 行挂载的服务是本插件不拥有的独立条目，不会列出来。用户条目与它重名时会挂载失败。
- **没有实时连接状态。** 页面展示的是配置而非健康度：是否连上、发现了多少工具、为什么失败都没有投射到任何线上接口。需要时可以用 `pluginInventory/list` 看该行的 fiber 状态。
- **挂载失败只写日志，页面不上报**，也没有重试。
- **`mcp.json` 只在激活时读取一次。**
- **MCP resources 与 prompts 不支持。** bridge 只桥接 Tools——所以主要靠 resources 提供价值的服务，在 DSH 里基本用不上。
- **没有按会话的服务。** 清单是部署级的，挂载不带 scope，因此工具落在全局层。

## 测试覆盖了什么

`pnpm test`：**56 个用例 / 6 个文件，全部通过**。

- 真实 Cordis Loader 组合：每个启用的服务挂出一条配置逐字段正确的 bridge 行；停用服务不挂载；被挂载的行永不写进引导文件；卸载后全部移除。
- 真实 profile loader 把本包当 bundle 组合——这正是 `dsh plugin --profile web add <path>` 能一次装好的原因。
- 独立安装：file URL 配置行在纯 Cordis 应用里激活；产物不含任何裸 import；`dsh.client` 声明与 `lib/client.js` 齐全。
- 存储词汇：传输推断、挂载校验、bridge 投影、`mcp.json` 读取（含损坏 JSON、错误结构）。
- 页面：各状态渲染，以及添加、编辑、改名、删除、校验、写入被拒的完整路径。

**未覆盖**：真实的 `dsh web` profile 完整启动。bundle 组合这一层有真实 loader 覆盖，但端到端的应用启动没有——这是唯一需要人工确认的环节。

## 许可证

MIT
