# 新电脑迁移步骤

以下步骤不会复制旧电脑的登录态。必须在新电脑分别扫码授权。

## 1. 安装基础组件

```bash
git clone https://github.com/houhouoch/duoyin-bot.git
cd duoyin-bot
bash scripts/bootstrap-macos.sh
```

脚本会安装固定版本企业微信 CLI、官方 Skill、Hermes（若缺失）、Python 依赖和带校验的小红书 MCP 二进制。安装后先重开一个终端，确认 `hermes` 在 `PATH` 中。

## 2. 配置业务参数

```bash
bash scripts/init-example-state.sh
```

编辑本机 `monitor-config.json`：

- 把 `target_group` 改为目标企业微信群名。
- 按需修改关键词、计划和文档权限。
- 不要填写群聊 ID；发送时程序每轮从当前会话列表按群名唯一匹配。

导入库存：

```bash
.venv/bin/python3 import-inventory.py /绝对路径/库存.xlsx
```

## 3. 企业微信授权

```bash
export WECOM_CLI_CONFIG_DIR="$HOME/.hermes/profiles/wecom-case-assistant/wecom-cli"
wecom-cli auth init --noninteractive --output-qrcode qr.png
wecom-cli auth status
wecom-cli message aibot sessions list
```

在目标群里 `@机器人` 发一条测试消息，再重新列出会话。目标群名必须唯一出现。不要把返回的 `chat_id` 写入仓库。

## 4. 小红书扫码登录

```bash
export XHS_MCP_HOME="$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0"
cd "$XHS_MCP_HOME/private"
../xiaohongshu-login-darwin-arm64
chmod 600 cookies.json
```

加载后台服务：

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist"
curl -fsS http://127.0.0.1:18061/health
```

如果平台要求验证码或显示访问限制，停止操作并等待人工恢复；不要换账号绕过。

## 5. DeepSeek

创建本机私密文件：

```bash
mkdir -p "$HOME/.hermes/profiles/xhs-rental-monitor/private"
chmod 700 "$HOME/.hermes/profiles/xhs-rental-monitor/private"
cp deepseek.example.json "$HOME/.hermes/profiles/xhs-rental-monitor/private/deepseek.json"
chmod 600 "$HOME/.hermes/profiles/xhs-rental-monitor/private/deepseek.json"
```

编辑 `api_key`。不要在终端命令历史、聊天或 Git 中粘贴 Key。

## 6. Hermes 巡检 Profile 和 cron

```bash
mkdir -p "$HOME/.hermes/profiles/xhs-rental-monitor"
cp hermes/xhs-rental-monitor.config.example.yaml "$HOME/.hermes/profiles/xhs-rental-monitor/config.yaml"
repo="$(pwd)"
sed -e "s|__DUOYIN_HOME__|$repo|g" -e "s|__WECOM_CLI_BIN__|$(command -v wecom-cli)|g" scripts/xhs-rental-four-hour.sh > "$HOME/.hermes/profiles/xhs-rental-monitor/scripts/xhs-rental-four-hour.sh"
chmod 700 "$HOME/.hermes/profiles/xhs-rental-monitor/scripts/xhs-rental-four-hour.sh"
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes cron create '0 */4 * * *' --name '小红书求租线索4小时巡检' --deliver local --script xhs-rental-four-hour.sh --no-agent --workdir "$repo"
```

记录返回的任务 ID，只写入本机 `wecom-case-assistant/.env` 的 `HERMES_XHS_JOB_ID`，不要提交。

## 7. Hermes 企业微信助手

复制 `hermes/wecom-case-assistant.config.example.yaml`，再在该 Profile 的 `.env` 中填写示例要求的变量。群白名单 ID 必须从新电脑的真实入站消息获取，不能复制旧电脑 ID。

```bash
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway install
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway start
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway status
```

完整验收必须包含：企业微信入站、Hermes/DeepSeek 推理、`patrol_status`、企业微信出站。仅看到 Gateway 常驻不算端到端完成。

若新电脑也用 Codex 维护本项目，可把仓库内 Skill 复制到本机：

```bash
mkdir -p "$HOME/.codex/skills/xhs-rental-leads"
cp skills/xhs-rental-leads/SKILL.md "$HOME/.codex/skills/xhs-rental-leads/SKILL.md"
```

## 8. 上线前验收

```bash
npm test
bash scripts/doctor.sh
bash scripts/secret-scan.sh
```

先使用测试群做一轮人工触发。核对帖子链接、评论位置、数量、每日总览、子页面、访问权限和发送回执。确认后才把 `target_group` 改为正式群并保留唯一 cron。
