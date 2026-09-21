# dsh-cockpit

DeepSeek Harness 的体检 / 修复 / 更新三合一管理中心插件（Web GUI，源码运行模式）。
A health-check, one-click-repair and safe-update cockpit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## 为什么需要它

DSH 更新偶尔会带破坏性变更（比如 0.1.6 的插件运行时解析调整导致的 Symbol 双包身份错位，所有工具调用直接 `Interrupted`）。出问题最痛苦的不是修，而是**不知道哪里坏了**。dsh-cockpit 把「找问题 → 修问题 → 安全更新」做成了一件事：

- **体检**：18 项检查——Symbol 修复在位性（src + lib 双侧）、构建新鲜度、bundle 可解析性、插件 peer 兼容声明、patch 重复条目、junction 健康、备份年龄、git 状态、更新门禁……
- **修复**：5 个幂等一键修复（patch 去重、失效 junction 清理、备份清理、Symbol.for 原位修复、缺失 bundle 链接重建）
- **更新**：版本预览（落后提交数、发布说明、需注意的破坏性变更）+ 一键启动延迟更新助手（等你关闭 DSH 后自动更新、自动重放本地修复、自动重启）

DSH 正常时：设置 → **体检中心**，或独立仪表盘 `http://127.0.0.1:3080/dsh-cockpit`。
DSH 起不来时：命令行照样能体检、能修（核心模块零 DSH 依赖）。

## 安装

在 DSH Web 的插件市场搜索安装，或手动加进 profile（`~/.dsh/profiles/web/package.json`）：

```json
{
  "dependencies": {
    "dsh-cockpit": "^0.1.0"
  },
  "dsh": { "profile": { "bundles": ["dsh-cockpit"] } }
}
```

然后在 profile 目录跑一次 `pnpm install`，重启 DSH Web。

> 重要：写进 `bundles` 的包必须已经能被解析（node_modules 里真实存在），否则 DSH 启动会在 `resolveBundleDir` 直接失败。装完先跑 `npx dsh-cockpit` 看一眼「bundle 可解析性」检查再重启。

## 命令行

```sh
node cli.mjs              # 离线体检
node cli.mjs --online     # + git fetch + 最新发布 tag
node cli.mjs --gate       # 只输出更新门禁；退出码 0 = 安全
node cli.mjs --fixes      # 列出修复项及是否需要修
node cli.mjs --fix <id>   # 执行修复（幂等）；中风险加 --yes
```

如果仓库不在默认位置，用环境变量指定：`set DSH_REPO=C:\path\to\deepseek-harness`。

## 配套脚本（可选，机器级）

`scripts/update-deferred.ps1` 由面板的「开始更新」按钮自动调用，也可独立运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-deferred.ps1 -Repo C:\path\to\deepseek-harness
```

它等待 DSH Web（端口 3080）关闭 → 运行仓库里的 `update-dsh.ps1`（备份并重放本地修复）→ 成功后自动重启 DSH Web。

## 设计原则

- **核心零 DSH 依赖**：诊断/修复模块不 import 任何 DSH 包——它们正是为了在 DSH 自身坏掉时还能工作。
- **诊断只读**：体检绝不修改任何东西；修复幂等、先评估后执行、保留备份。
- **面板崩溃有兜底**：设置面板注册失败只 warn，独立仪表盘 `/dsh-cockpit` 不依赖客户端槽位 API。
- **写操作同源校验**：POST 接口只接受本机来源。

## License

MIT
