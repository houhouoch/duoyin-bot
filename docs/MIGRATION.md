# 新电脑部署

支持 Apple Silicon macOS。需要 Git、Node.js >=20、Python >=3.10，以及各自的小红书账号、企业微信机器人和 DeepSeek Key。默认模板复刻 2026-10-17 策略；账号可见内容与实际结果可能不同。

## 1. 安装并初始化

```bash
git clone https://github.com/houhouoch/duoyin-bot.git
cd duoyin-bot
bash scripts/bootstrap-macos.sh
```

安装脚本创建项目 `.venv`，安装固定版本 Python 直接依赖、`package-lock.json` 中的 Node 依赖和 Chromium，安装企业微信 CLI、带 SHA-256 校验的 MCP 二进制。缺少 Hermes 时，使用已确认的上游提交安装。已有 Hermes 不自动覆盖，参考组件清单核对兼容性。

脚本渲染当前电脑的路径、独立 Profile 和 LaunchAgent；不会启动服务、创建定时任务、登录或发群。已有业务配置与状态不覆盖。若 Hermes 刚安装，重开终端确保 `hermes` 在 PATH 中。

```bash
bash scripts/init-example-state.sh
```

该命令只补缺失文件。编辑被 Git 忽略的 `monitor-config.json`，把 `target_group` 设为测试群名；其他默认策略见 STRATEGY.md。不要填写群聊 ID。`document_delivery.join=public` 表示持链接只读，可按实际权限要求调整并验收。

## 2. 导入自己的库存

```bash
.venv/bin/python3 import-inventory.py /绝对路径/库存.xlsx
```

Excel 每行第一列为类别，第二列为型号或组合；空类别沿用上一行。库存文件需长期留在该绝对路径，所有工作表及源指纹仅保存在本机派生目录，原表不修改。示例目录只用于离线测试，不能代替实际库存导入。

## 3. 企业微信授权

```bash
export WECOM_CLI_CONFIG_DIR="$HOME/.hermes/profiles/wecom-case-assistant/wecom-cli"
wecom-cli auth init --noninteractive --output-qrcode qr.png
wecom-cli auth show --status
wecom-cli message aibot sessions list
```

只在新部署时初始化授权。已有机器人授权失效时按 CLI 提示续期，避免无意创建新机器人。把机器人加入测试群并在群内 @机器人；会话列表中的目标群名必须唯一。将消息发送、智能文档创建/读写/搜索等权限一并授权；authorized 不等于目标文档可读写。内部 ID 和扫码文件只保存在本机。

## 4. 小红书扫码与后端

```bash
export XHS_MCP_HOME="$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0"
(cd "$XHS_MCP_HOME/private" && ../xiaohongshu-login-darwin-arm64)
chmod 600 "$XHS_MCP_HOME/private/cookies.json"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist"
curl -fsS http://127.0.0.1:18061/health
```

启动器生成本机令牌，Cookie 和令牌位于 private，不复制旧电脑登录态。已有同端口后端时先确认只保留一个所有者，不并行启动。验证码或访问限制由人工恢复，不换账号绕过。

## 5. DeepSeek 本机私密配置

```bash
mkdir -p "$HOME/.hermes/profiles/xhs-rental-monitor/private"
chmod 700 "$HOME/.hermes/profiles/xhs-rental-monitor/private"
cp deepseek.example.json "$HOME/.hermes/profiles/xhs-rental-monitor/private/deepseek.json"
chmod 600 "$HOME/.hermes/profiles/xhs-rental-monitor/private/deepseek.json"
```

仅新部署时复制；已有配置不要覆盖。在编辑器填自己的 api_key，不在命令历史或 Git 中粘贴。周期复核直接读该文件；不依赖聊天 Profile 的 Key。

## 6. 离线检查与测试群人工验收

回到仓库根目录执行：

```bash
npm test
bash scripts/secret-scan.sh
bash scripts/doctor.sh
bash "$HOME/.hermes/profiles/xhs-rental-monitor/scripts/xhs-rental-four-hour.sh"
```

前三项分别验证隔离测试、发布文件和本机依赖/授权状态；最后一项会实际采集、调用付费模型、创建文档并向配置的测试群发送，使用原持锁统一入口。只在完成测试群配置后人工执行一次。核对原文、来源链接、时间、完整汇总、访问权限和明确发送回执；上传或文档保存不代表发群成功。不要直接调用 scan 或通知器来绕过统一入口。

## 7. 启用唯一 Hermes 周期任务

验收通过后，把 target_group 改为正式群并核实唯一会话；先检查没有旧巡检任务。仓库目录中执行：

```bash
repo="$(pwd)"
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes cron list
TZ=Asia/Shanghai HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes cron create '0 */4 * * *' --name '小红书求租线索4小时巡检' --deliver local --script xhs-rental-four-hour.sh --no-agent --workdir "$repo"
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes gateway install
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes gateway start
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes gateway status
```

巡检 Profile 的 `.env` 由初始化写入 `TZ=Asia/Shanghai`，保障北京时间六轮。记录新任务 ID，仅写入自己电脑聊天 Profile `.env` 的 HERMES_XHS_JOB_ID。更换路径后重新渲染 `python3 scripts/configure-local.py`，核对已有配置中的路径，不复制旧电脑 ID 或状态文件。本机需要开机在线且保持唤醒；不是云端服务。

## 8. 可选：企业微信聊天助手

只要定时推送，步骤七即可。若需要群聊查询状态和明确指令触发巡检，使用已生成的 `wecom-case-assistant/config.yaml` 和 `.env`：填写自己的 DEEPSEEK_API_KEY、HERMES_XHS_JOB_ID，并按 Hermes 平台配置补齐机器人凭证及群白名单。模板里的空 allowlist 不授予任何群访问；只添加自己真实入站消息中的授权群。

```bash
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway install
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway start
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway status
```

聊天 Profile 仅挂载 patrol_status 和 patrol_rerun 两个工具，后者只触发步骤七的原任务，不增加第二个计划。必须验证实际入站、模型推理、工具结果和出站；常驻不等于端到端通过。

Codex 维护 Skill 可从 skills/xhs-rental-leads/SKILL.md 安装。升级/回滚只处理代码和模板，绝不覆盖原队列、历史去重及发送回执。
