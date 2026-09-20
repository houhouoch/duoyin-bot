# 组件清单

## 主链路

| 组件 | 固定版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| Hermes Agent | `v0.20.2` | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 唯一定时调度、后台 Gateway、聊天 MCP 挂载 |
| 企业微信 CLI | `@wecom/cli@1.2.1` | [WecomTeam/wecom-cli](https://github.com/WecomTeam/wecom-cli) | 企业微信授权、消息、智能文档 |
| 企业微信官方 Skill | 安装时取对应 CLI Skill | `npx skills add WeComTeam/wecom-cli -y -g` | CLI 命令及授权约束 |
| 小红书 MCP | `v2.5.0` | [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp/releases/tag/v2.5.0) | 本机只读搜索和详情接口 |
| DeepSeek | `deepseek-flash` | `https://api.deepseek.com` | 规则筛选后的意图复核 |

安装脚本对小红书 MCP 二进制做 SHA-256 校验。仓库不复制第三方二进制。

## 可选诊断工具

`jackwener/xiaohongshu-cli` 当前验证版本为 `0.6.4`：

```bash
uv tool install xiaohongshu-cli==0.6.4
# 或
pipx install xiaohongshu-cli==0.6.4
```

它不是周期任务入口。仅在人工诊断时使用；出现验证码、登录失效或访问限制后，不自动切换到 CLI 继续采集。

## Agent Skill / 插件说明

- 企业微信操作使用官方 `WecomTeam/wecom-cli` Skill。实际涉及 `wecomcli-shared`、`wecomcli-message`、`wecomcli-smartpage`；运行时仍由 `wecom-cli` 执行。
- 仓库内 [skills/xhs-rental-leads/SKILL.md](../skills/xhs-rental-leads/SKILL.md) 保存本项目维护规则，供另一台电脑的 Codex 或兼容 Agent 安装。
- `agent-reach` 只用于人工调研 GitHub 和可选 `xiaohongshu-cli`，不是 Hermes 周期任务依赖。
- WorkBuddy 不参与当前周期任务，不安装第二份发送计划。

本项目不依赖 Dropbox、Google Drive、Slack 等第三方 Codex 插件。

## 为什么不把 MCP 直接交给模型

周期任务使用受限包装层，只开放 `search` 和 `detail`。采集、去重、发送回执均由确定性代码执行。模型只能看到有界公开原文，不能拿到 Cookie、API Token、客户 ID、文档令牌或任意命令执行能力。
