# dsh-mcp-servers

给 DeepSeek Harness 挂外部 [Model Context Protocol](https://modelcontextprotocol.io) 服务：一份清单管多台服务，装完在 **设置 → MCP** 里增删改，工具以 `mcp__<服务名>__<工具名>` 出现在模型工具表里，和原生工具平级。

## 它有什么用

- **一份清单管所有 MCP 服务**：不用为每台服务写一行 `cordis.yml`，也不用改文件重启。
- **设置面板里即时增删改**：保存即挂载/卸载，只有改动的那台服务会重连。
- **已经配好的服务也能看到**：页面会把当前 profile 里已经在跑的 MCP 全部列出来——本插件保存的、`cordis.yml` / profile 补丁里直接插入的 bridge 行、`mcp.json` 文件、0.1.x 遗留的 `servers` 段。来源带标签；不是本插件保存的条目只读展示，不会重复挂载。
- **兼容现成的 `mcp.json`**：与其他 MCP 客户端同一格式，已有文件直接复用。
- **官方 Web 与 Desktop profile 都支持**：同一份插件，`dsh.client.platform` 与两个官方 profile 共用。
- **DSH 版本范围明确**：`engines.dsh: ">=0.2.1-rc.3 <0.3.0"`，不满足时安装会被 harness 拒绝。

## 通过 GitHub 安装

仓库：`github:MosaicAccount/dsh-mcp-servers`

```sh
dsh plugin --profile web add github:MosaicAccount/dsh-mcp-servers
dsh plugin --profile desktop add github:MosaicAccount/dsh-mcp-servers
```

`dsh` 不在 PATH 里时用应用自带的 CLI：
`"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"`。
不想退出 Desktop 时，也可以用它自己的 **设置 → 插件 → 安装**，地址栏填同一个 `github:MosaicAccount/dsh-mcp-servers`。

两个注意点：

1. **GitHub 安装需要跑仓库的 `prepare` 脚本构建 `lib/`**（构建产物不在 git 里）。pnpm 默认拦下依赖的构建脚本，第一次安装会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败，并打印出需要写入的那一行。把它原样加进 profile 的 `pnpm-workspace.yaml`，再重跑安装：

   ```yaml
   # <harness home>/profiles/<web|desktop>/pnpm-workspace.yaml
   allowBuilds:
     "dsh-mcp-servers@https://codeload.github.com/MosaicAccount/dsh-mcp-servers/tar.gz/<commit>": true
   ```

   键里带具体提交（pnpm 把批准固定到那次提交），所以**直接复制 pnpm 打印的那一行**最省事；更新到新提交时，若要跑新提交的构建脚本，需要按同样方式再加一行。也可以安装失败后，在 **设置 → 插件** 里点“允许这些脚本并重试”。

2. **官方 Desktop 的 profile 归 Electron 应用所有**：用 CLI 安装前先打开一次 Desktop 初始化 profile、再完全退出；用应用内插件管理器则不用退出。

装完重启 harness（Web 实例或 Desktop），打开 **设置 → MCP**。默认读 `<harness home>/mcp.json`，也可以直接在页面里添加服务。

## 更新

```sh
dsh plugin --profile web update dsh-mcp-servers
dsh plugin --profile desktop update dsh-mcp-servers
```

或者重新执行一次安装命令再重启。要把版本钉在某个分支或提交上，把地址写成
`github:MosaicAccount/dsh-mcp-servers#<branch|commit>`（例如默认分支还没合并这次改动时，
用 `github:MosaicAccount/dsh-mcp-servers#fix/malformed-config-bricks-boot`）。

更新后重启对应实例（Web 实例或 Desktop）生效。

## 卸载

```sh
dsh plugin --profile web remove dsh-mcp-servers
dsh plugin --profile desktop remove dsh-mcp-servers
```

Desktop 用 CLI 前同样要先完全退出应用（或直接用应用内插件管理器卸载）。卸载会移除插件行和它创建的服务实例；已经写进 profile 补丁的 `mcpServers` 配置会保留，需要彻底清理就手动删掉那一段。

## 许可证

MIT
