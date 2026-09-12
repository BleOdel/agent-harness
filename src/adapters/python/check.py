"""Harness-owned diagnostics. Project Python still controls its own test process."""
import json
import sys
import pytest

class Report:
    def __init__(self):
        self.collected = []
        self.results = []
    def pytest_collection_finish(self, session):
        self.collected = [item.nodeid for item in session.items]
    def pytest_runtest_logreport(self, report):
        self.results.append({'nodeid': report.nodeid, 'when': report.when, 'outcome': report.outcome})

report = Report()
code = pytest.main(['-c', '/harness-instrumentation/pytest.ini', '--rootdir=/work', '--strict-config', '--strict-markers', '-q', '/work/tests'], plugins=[report])
print('HARNESS_PYTEST=' + json.dumps({'version': 1, 'collected': report.collected, 'results': report.results, 'exitCode': int(code)}), flush=True)
sys.exit(code)
