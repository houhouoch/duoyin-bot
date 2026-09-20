"""Bridge tests use temporary state and mocked execution, never the live task."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('control', Path(__file__).with_name('patrol-control-mcp.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.scope = patch.object(control, 'BASE', self.base)
        self.scope.start()
        self.job = patch.object(control, 'JOB', 'fixture-job')
        self.job.start()

    def tearDown(self):
        self.job.stop()
        self.scope.stop()
        self.temp.cleanup()

    def test_confirmation_required(self):
        with patch.object(control.subprocess, 'Popen') as spawn:
            self.assertEqual(control.patrol_rerun(False)['status'], 'not_started')
            spawn.assert_not_called()

    def test_zombie_launcher_is_not_running(self):
        with patch.object(control.os, 'kill'), patch.object(control.subprocess, 'run', return_value=Mock(returncode=0, stdout='Z+\n')):
            self.assertFalse(control.alive(12345))

    def test_live_or_unknown_process_blocks_duplicate_launch(self):
        with patch.object(control.os, 'kill'), patch.object(control.subprocess, 'run', return_value=Mock(returncode=0, stdout='S\n')):
            self.assertTrue(control.alive(12345))
        with patch.object(control.os, 'kill'), patch.object(control.subprocess, 'run', side_effect=OSError('unavailable')):
            self.assertTrue(control.alive(12345))

    def test_pause_and_running_do_not_launch(self):
        for key in ['paused', 'running', 'dispatch_pending']:
            state = {'paused': False, 'running': False, 'dispatch_pending': False, key: True}
            with patch.object(control, 'snapshot', return_value=state), patch.object(control.subprocess, 'Popen') as spawn:
                result = control.patrol_rerun(True)
                self.assertIn(result['status'], ['paused', 'already_running'])
                spawn.assert_not_called()

    def test_notify_failure_reports_collected_results_without_claiming_delivery(self):
        scan = self.base / 'scan.json'
        scan.write_text(json.dumps({
            'complete': True,
            'search_unique': 79,
            'new_comments_found': 368,
        }))
        (self.base / 'run-status.json').write_text(json.dumps({
            'status': 'failed',
            'stage': 'failed',
            'failed_stage': 'notify',
            'error': 'document delivery failed',
            'scan_path': str(scan),
        }))
        (self.base / 'deepseek-last-review.json').write_text(json.dumps({
            'reviewed': 38,
            'cached': 63,
            'deferred': 4,
            'failed_candidates': 4,
        }))

        result = control.snapshot()

        self.assertTrue(result['collected_without_delivery'])
        self.assertEqual(result['search_unique'], 79)
        self.assertEqual(result['new_comments_found'], 368)
        self.assertEqual(result['reviewed_candidates'], 38)
        self.assertIsNone(result['accepted_leads'])
        self.assertIn('不得表述为“没有结果”', result['notice'])

    def test_login_failure_does_not_launch_or_change_history(self):
        for login, status in [(False, 'login_required'), (None, 'backend_unavailable')]:
            with patch.object(control, 'login_ready', return_value=login), patch.object(control.subprocess, 'Popen') as spawn:
                self.assertEqual(control.patrol_rerun(True)['status'], status)
                spawn.assert_not_called()
                self.assertFalse((self.base / 'leads-history.json').exists())

    def test_fixed_native_cron_command_and_no_false_start_claim(self):
        child = Mock(pid=99999999)
        child.poll.return_value = None
        with patch.object(control, 'login_ready', return_value=True), patch.object(control.subprocess, 'Popen', return_value=child) as spawn, patch.object(control.time, 'sleep'):
            self.assertEqual(control.patrol_rerun(True)['status'], 'dispatch_pending')
            args, options = spawn.call_args
            self.assertEqual(args[0], [control.HERMES, 'cron', 'run', control.JOB])
            self.assertTrue(options['start_new_session'])
            self.assertEqual(options['env']['HERMES_HOME'], str(control.PROFILE))
            self.assertEqual(control.patrol_rerun(True)['status'], 'not_started')
            self.assertEqual(spawn.call_count, 1)


if __name__ == '__main__':
    unittest.main()
