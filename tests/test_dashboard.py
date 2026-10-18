"""Regression checks for appointment views and account-scoped records, with synthetic data."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import app


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        database = str(Path(self.temp.name) / 'test.db')
        self.db_patch = patch.object(app, 'get_db', side_effect=lambda: sqlite3.connect(database))
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        app.init_db()
        self.client = app.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 'sample-a'

    def test_empty_account_renders_working_sections_without_starter_records(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-mode="provider"', html)
        for module in ['clinical-ui.js', 'labs.js', 'history.js', 'goals.js']:
            self.assertIn(module, html)
            with self.client.get('/static/' + module) as asset:
                self.assertEqual(asset.status_code, 200)
        self.assertNotIn('Replace this starter record', html)
        self.assertNotIn('data-toast=', html)

    def test_goal_order_is_saved_without_crossing_accounts(self):
        goals = {'items': ['Priority 2', 'Priority 1'], 'questions': ['Sample question']}
        self.assertEqual(self.client.post('/api/goals', json=goals).json, goals)
        self.assertEqual(self.client.get('/api/records').json['goals'], goals)
        with self.client.session_transaction() as session:
            session['user'] = 'sample-b'
        self.assertEqual(self.client.get('/api/records').json['goals'], {'items': [], 'questions': []})
        self.assertEqual(self.client.post('/api/goals', json={'items': 'invalid'}).status_code, 400)

    def test_clinical_records_and_source_documents_remain_account_scoped(self):
        app.clinical.replace_document(app.get_db(), 'sample-a', {
            'document': 'sample.pdf', 'labs': [{'test': 'Glucose', 'value': 90, 'taken_at': '2025-01-01', 'page': 2}],
            'allergies': [{'substance': 'Sample allergy', 'page': 1}],
        })
        self.assertEqual(len(self.client.get('/api/clinical').json['lab_results']), 1)
        documents = Path(self.temp.name) / 'sample-a'
        documents.mkdir()
        (documents / 'sample.pdf').write_bytes(b'%PDF-1.4\nsynthetic fixture')
        with patch.object(app, 'GCS_BUCKET', ''), patch.object(app, 'LOCAL_DOCS_DIR', self.temp.name):
            with self.client.get('/documents/sample.pdf') as document:
                self.assertEqual(document.status_code, 200)
            with self.client.session_transaction() as session:
                session['user'] = 'sample-b'
            self.assertEqual(self.client.get('/api/clinical').json['lab_results'], [])
            self.assertEqual(self.client.get('/api/clinical').json['allergies'], [])
            self.assertEqual(self.client.get('/documents/sample.pdf').status_code, 404)
        with self.client.session_transaction() as session:
            session.clear()
        for route in ['/api/clinical', '/api/vitals', '/api/records', '/api/genetics']:
            self.assertEqual(self.client.get(route).status_code, 401)
        self.assertEqual(self.client.post('/api/goals', json={'items': [], 'questions': []}).status_code, 401)


if __name__ == '__main__':
    unittest.main()
