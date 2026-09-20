"""Narrow chat-to-patrol bridge. No shell, credentials, or platform write tools."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

from mcp.server.fastmcp import FastMCP

BASE = Path(os.environ.get('DUOYIN_HOME', Path(__file__).resolve().parent))
PROFILE = Path(os.environ.get('HERMES_MONITOR_HOME', Path.home() / '.hermes/profiles/xhs-rental-monitor'))
HERMES = os.environ.get('HERMES_BIN', str(Path.home() / '.local/bin/hermes'))
JOB = os.environ.get('HERMES_XHS_JOB_ID', '')
BACKEND = os.environ.get('XHS_BACKEND_URL', 'http://127.0.0.1:18061').rstrip('/')
XHS_MCP_HOME = Path(os.environ.get('XHS_MCP_HOME', Path.home() / '.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0'))
server = FastMCP('xhs-patrol-control')


def load(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def alive(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # kill(pid, 0) succeeds for zombies, but a defunct launcher cannot run a job.
    # Inspect only process state; do not read command arguments or credentials.
    try:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='],
                                capture_output=True, text=True, timeout=3)
        if result.returncode == 1 and not result.stdout.strip():
            return False
        if result.returncode == 0 and result.stdout.strip():
            return not result.stdout.strip().startswith('Z')
    except (OSError, subprocess.SubprocessError):
        pass
    return True  # Unknown state remains fail-closed against concurrent launches.


def snapshot():
    run = load(BASE / 'run-status.json')
    owner = load(BASE / 'four-hour.lock/owner.json')
    request = load(BASE / 'chat-rerun-request.json')
    watch = load(BASE / 'watchlist.json')
    scan_path = run.get('scan_path')
    scan = load(Path(scan_path)) if scan_path else {}
    review = load(BASE / 'deepseek-last-review.json')
    receipt = run.get('delivery_check', {})
    failed_stage = run.get('failed_stage')
    collected_without_delivery = (
        run.get('status') == 'failed'
        and failed_stage == 'notify'
        and bool(scan)
    )
    if collected_without_delivery:
        notice = (
            '采集和模型复核已有结果，但发送阶段失败；不得表述为“没有结果”。'
            'accepted_leads仅表示企业微信已确认接收的数量。'
        )
    else:
        notice = '接口接受不等于客户端已阅读；partial不代表全量完成。'
    return {
        'task': '小红书求租线索4小时巡检',
        'target_group': load(BASE / 'monitor-config.json').get('target_group', '未配置'),
        'running': alive(owner.get('pid')),
        'dispatch_pending': alive(request.get('pid')),
        'paused': bool(watch.get('paused')),
        'status': run.get('status', 'unknown'),
        'stage': run.get('stage'),
        'failed_stage': failed_stage,
        'error': run.get('error'),
        'started_at': run.get('started_at'),
        'completed_at': run.get('completed_at'),
        'accepted_leads': receipt.get('accepted'),
        'message_parts': receipt.get('batches'),
        'delivery_status': receipt.get('status'),
        'collection_complete': scan.get('complete'),
        'search_unique': scan.get('search_unique'),
        'new_comments_found': scan.get('new_comments_found'),
        'reviewed_candidates': review.get('reviewed'),
        'cached_candidates': review.get('cached'),
        'deferred_candidates': review.get('deferred'),
        'failed_candidates': review.get('failed_candidates'),
        'collected_without_delivery': collected_without_delivery,
        'pending_candidates': run.get('pending'),
        'warning_count': len(run.get('warnings', [])),
        'schedule': '北京时间每日00、04、08、12、16、20点，未修改',
        'notice': notice,
    }


@server.tool()
def patrol_status() -> dict:
    """查询真实小红书巡检进程、最近结果、发送回执和本地服务状态。不会启动任务或发消息。"""
    result = snapshot()
    try:
        with urllib.request.urlopen(BACKEND + '/health', timeout=3) as response:
            result['mcp_reachable'] = response.status == 200
    except Exception:
        result['mcp_reachable'] = False
    result['logged_in'] = login_ready() if result['mcp_reachable'] else None
    return result


def login_ready():
    """Check only the existing controlled backend; never expose its token or cookies."""
    try:
        token = (XHS_MCP_HOME / 'private/api-token').read_text().strip()
        request = urllib.request.Request(BACKEND + '/api/v1/login/status',
                                         headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.load(response)
        return data.get('success') is True and data.get('data', {}).get('is_logged_in') is True
    except Exception:
        return None


@server.tool()
def patrol_rerun(confirm: bool) -> dict:
    """仅在用户明确要求重跑/开始巡检时调用，confirm=true。触发原Hermes任务并发到已配置企业微信群；复用全部历史去重，不改定时计划。已有任务则不重复启动。根据结果区分started、dispatch_pending、paused、already_running、failed，不能只凭调用就说已完成。"""
    if confirm is not True:
        return {'status': 'not_started', 'reason': '需要用户明确要求重跑'}
    if not JOB:
        return {'status': 'not_started', 'reason': '未设置 HERMES_XHS_JOB_ID，请先创建 Hermes cron 任务'}
    os.umask(0o077)
    with (BASE / 'chat-rerun.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        before = snapshot()
        if before['paused']:
            return {'status': 'paused', 'reason': '巡检已暂停，需要人工处理登录或访问限制；不自动解除。'}
        if before['running'] or before['dispatch_pending']:
            return {'status': 'already_running', 'result': before}
        login = login_ready()
        if login is not True:
            return {'status': 'login_required' if login is False else 'backend_unavailable',
                    'reason': '未启动巡检：请在本机重新确认小红书登录。' if login is False else '未启动巡检：后端或登录检查不可用，请检查本机服务。'}
        previous = load(BASE / 'chat-rerun-request.json')
        if time.time() - previous.get('requested_epoch', 0) < 120:
            return {'status': 'not_started', 'reason': '刚提交过重跑请求，请先查询状态，避免重复启动。'}
        env = dict(os.environ, HERMES_HOME=str(PROFILE), TZ='Asia/Shanghai')
        env.pop('HERMES_SESSION_KEY', None)
        requested = time.time()
        with (BASE / 'chat-rerun.log').open('ab') as output:
            child = subprocess.Popen([HERMES, 'cron', 'run', JOB], cwd=str(BASE), env=env,
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                     start_new_session=True)
        target = BASE / 'chat-rerun-request.json'
        temp = target.with_suffix('.tmp')
        temp.write_text(json.dumps({'pid': child.pid, 'requested_epoch': requested}))
        temp.replace(target)
        for _ in range(30):
            current = snapshot()
            started = current.get('started_at')
            if started and datetime.datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp() >= requested:
                if current['running']:
                    return {'status': 'started', 'result': current}
                return {'status': 'finished', 'result': current}
            if child.poll() is not None:
                return {'status': 'not_started', 'reason': '执行进程已退出，未验证新巡检启动，请查询状态。'}
            time.sleep(0.2)
        return {'status': 'dispatch_pending', 'reason': '已提交给原Hermes任务，但尚未验证巡检启动；请查询状态。'}


if __name__ == '__main__':
    server.run(transport='stdio')
