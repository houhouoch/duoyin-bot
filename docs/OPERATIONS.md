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
