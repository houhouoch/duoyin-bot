# 运行手册

## 日常检查

```bash
bash scripts/doctor.sh
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes cron list
HERMES_HOME="$HOME/.hermes/profiles/wecom-case-assistant" hermes gateway status
```

## 人工运行

先确认没有正在运行的锁，再通过 Hermes 原任务触发。不要直接并发运行 `scan.cjs`：

```bash
HERMES_HOME="$HOME/.hermes/profiles/xhs-rental-monitor" hermes cron run <JOB_ID>
```

聊天助手的 `patrol_rerun(confirm=true)` 也只会触发这个任务，并保留相同锁、暂停状态和去重历史。它不接受任意命令、群名或强制重发参数。

## 状态含义

- `finished`：本轮采集、复核与发送回执检查已结束，不代表全平台完整覆盖。
- `partial`：存在查询不完整、评论未全部加载、模型积压或队列待处理。
- `paused`：登录失效、验证码或访问限制；需人工处理。
- `failed`：流程在指定阶段失败。先看 `failed_stage`，不要盲目连续重跑。
- `accepted_by_wecom`：企业微信接口明确接受；不等于每位群成员已阅读。

## 更新库存

```bash
.venv/bin/python3 import-inventory.py /绝对路径/库存.xlsx
```

原 Excel 只读。派生的 `camera-catalog.json` 留在本机，不提交 Git。

## 回滚

代码按 Git commit 回滚；状态文件不要随代码回滚，否则会破坏去重。升级第三方组件前保存当前版本号和 SHA-256，先在测试群 dry-run，再切生产群。

## 文档维护与故障

运行问题只写每日文档；文档不可写时原账本保留待归档，不能因为群里静默就断言巡检成功。先检查 run-status.json 的 failed_stage、error、scan_path 和 delivery_check，再看原扫描、模型统计与 operational_notes。漏跑只记录真实缺口，不猜测电脑休眠原因。

`node run-four-hour.cjs --refresh-document` 持原锁整理文档，不重新采集或发群；执行前仍需有明确维护目的。`--retry-notify-only` 仅复用四小时内刚失败的通知轮次；`--deliver-pending-only` 复用四小时内既有采集和复核，可能发群。`--deliver-approved-only --expected-count N` 只用于管理员明确确认数量的补发，不调用模型或采集，不绕过来源排除、原文证据、历史去重或未知回执隔离。不要把重跑当排错的第一步。

升级后先 `npm ci --ignore-scripts`、`.venv/bin/python3 -m pip install -r requirements.txt`、`npx playwright install chromium`，再 `npm test`。不要用新示例覆盖已有 monitor-config.json；按 STRATEGY.md 合并新增策略字段。不要为升级重建或清空 watchlist、历史去重、文档记录和回执。
