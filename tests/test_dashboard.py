"""Regression checks for appointment views and account-scoped records, with synthetic data."""
from pathlib import Path
from copy import deepcopy
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
        for module in ['clinical-ui.js', 'record-groups.js', 'preparation.js', 'labs.js', 'history.js', 'goals.js']:
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

    def test_unextracted_medical_record_can_be_annotated_deleted_and_restored(self):
        documents = Path(self.temp.name) / 'sample-a'
        documents.mkdir()
        (documents / 'new_report.pdf').write_bytes(b'%PDF-1.4\\nsynthetic fixture')
        with patch.object(app, 'GCS_BUCKET', ''), patch.object(app, 'LOCAL_DOCS_DIR', self.temp.name):
            row = self.client.get('/api/clinical').json['documents'][0]
            self.assertTrue(row['unextracted'])
            url = '/api/preparation/entries/documents/' + row['_key']
            self.assertEqual(self.client.put(url, json={'fields': {}, 'notes': 'Discuss this report'}).status_code, 200)
            self.assertEqual(self.client.get('/api/clinical').json['documents'][0]['_patient_note'], 'Discuss this report')
            delete_url = '/api/preparation/entries/documents'
            self.assertEqual(self.client.patch(delete_url, json={'keys': [row['_key']], 'deleted': True}).status_code, 200)
            self.assertEqual(self.client.get('/api/clinical').json['documents'], [])
            self.assertEqual(self.client.patch(delete_url, json={'keys': [row['_key']], 'deleted': False}).status_code, 200)
            restored = self.client.get('/api/clinical').json['documents'][0]
            self.assertEqual(restored['_patient_note'], 'Discuss this report')


    def test_section_notes_are_validated_persisted_and_account_scoped(self):
        payload = {'summary': 'Sample summary', 'notes': 'First line\nSecond line'}
        self.assertEqual(self.client.put('/api/preparation/sections/history', json=payload).json, payload)
        self.assertEqual(self.client.get('/api/preparation').json['section:history'], payload)
        self.assertEqual(self.client.put('/api/preparation/sections/history', json={'summary': []}).status_code, 400)
        self.assertEqual(self.client.put('/api/preparation/sections/unknown', json=payload).status_code, 400)
        self.assertEqual(self.client.put('/api/preparation/sections/history', data='summary=test').status_code, 400)
        with self.client.session_transaction() as session:
            session['user'] = 'sample-b'
        self.assertEqual(self.client.get('/api/preparation').json, {})
        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.put('/api/preparation/sections/history', json=payload).status_code, 401)
        self.assertEqual(self.client.get('/api/preparation').status_code, 401)

    def test_provider_source_selection_is_validated_and_account_scoped(self):
        url = '/api/preparation/sources'
        self.assertEqual(self.client.put(url, json={'document': 'visit.pdf', 'included': True}).json,
                         {'document': 'visit.pdf', 'included': True})
        self.assertEqual(self.client.get('/api/preparation').json['source:visit.pdf'], {'included': True})
        for payload in [
            {'document': '../private.pdf', 'included': True},
            {'document': 'visit.pdf', 'included': 'true'},
            {'document': '', 'included': False},
            {'document': 'visit.txt', 'included': True},
        ]:
            self.assertEqual(self.client.put(url, json=payload).status_code, 400)
        with self.client.session_transaction() as session:
            session['user'] = 'sample-b'
        self.assertNotIn('source:visit.pdf', self.client.get('/api/preparation').json)
        self.assertEqual(self.client.put(url, json={'document': 'visit.pdf', 'included': False}).status_code, 200)
        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.put(url, json={'document': 'visit.pdf', 'included': True}).status_code, 401)

    def test_patient_updates_preserve_imports_and_can_be_restored(self):
        manifest = {'document': 'sample.pdf', 'diagnoses': [{'name': 'Sample condition', 'status': 'history', 'page': 2}]}
        app.clinical.replace_document(app.get_db(), 'sample-a', manifest)
        row = self.client.get('/api/clinical').json['diagnoses'][0]
        url = '/api/preparation/entries/diagnoses/' + row['_key']
        payload = {'fields': {'status': 'active', 'note': 'Patient clarification'}, 'notes': 'Discuss at next visit'}
        self.assertEqual(self.client.put(url, json=payload).status_code, 200)
        updated = self.client.get('/api/clinical').json['diagnoses'][0]
        self.assertEqual(updated['status'], 'active')
        self.assertEqual(updated['_original']['status'], 'history')
        self.assertEqual(updated['document'], 'sample.pdf')
        self.assertEqual(updated['page'], 2)
        app.clinical.replace_document(app.get_db(), 'sample-a', manifest)
        self.assertEqual(self.client.get('/api/clinical').json['diagnoses'][0]['status'], 'active')
        self.assertEqual(app.clinical.load_clinical(app.get_db(), 'sample-a')['diagnoses'][0]['status'], 'history')
        with self.client.session_transaction() as session:
            session['user'] = 'sample-b'
        self.assertEqual(self.client.put(url, json=payload).status_code, 404)
        self.assertEqual(self.client.delete(url).status_code, 404)
        with self.client.session_transaction() as session:
            session['user'] = 'sample-a'
        self.assertEqual(self.client.delete(url).status_code, 200)
        self.assertEqual(self.client.get('/api/clinical').json['diagnoses'][0]['status'], 'history')

    def test_prepare_can_correct_cycle_dates_and_vital_reading_values(self):
        sample = {
            'series': {'resting_hr': [{'t': '2025-01-02', 'v': 60, 'source': 'manual', 'doc': None, 'page': None, 'note': None, 'seq': 0}]},
            'cycles': [{'start': '2025-01-01', 'end': '2025-01-04', 'source': 'manual', 'doc': None, 'page': None, 'note': None}],
            'metrics': {'resting_hr': {'label': 'Resting heart rate', 'unit': 'bpm', 'decimals': 0}},
        }
        with patch.object(app.vitals, 'load_vitals', side_effect=lambda *_args: deepcopy(sample)):
            data = self.client.get('/api/vitals').json
            cycle = data['cycles'][0]
            point = data['series']['resting_hr'][0]
            self.assertEqual(self.client.put('/api/preparation/entries/cycles/' + cycle['_key'],
                json={'fields': {'start': '2025-01-03', 'end': '2025-01-06'}, 'notes': ''}).status_code, 200)
            self.assertEqual(self.client.put('/api/preparation/entries/measurements/' + point['_key'],
                json={'fields': {'value': '72'}, 'notes': ''}).status_code, 200)
            updated = self.client.get('/api/vitals').json
            self.assertEqual(updated['cycles'][0]['start'], '2025-01-03')
            self.assertEqual(updated['cycles'][0]['_original']['start'], '2025-01-01')
            self.assertEqual(updated['series']['resting_hr'][0]['v'], 72)
            self.assertEqual(updated['series']['resting_hr'][0]['_original']['value'], 60)
            self.assertEqual(self.client.put('/api/preparation/entries/cycles/' + cycle['_key'],
                json={'fields': {'start': 'not-a-date'}, 'notes': ''}).status_code, 400)

    def test_manual_medication_and_lab_note_validation(self):
        response = self.client.post('/api/preparation/entries/medications', json={'fields': {'name': 'Sample medication', 'dose': 'Sample dose'}, 'notes': 'Patient note'})
        self.assertEqual(response.status_code, 201)
        key = response.json['key']
        row = self.client.get('/api/clinical').json['medications'][0]
        self.assertTrue(row['_manual'])
        self.assertEqual(row['_patient_note'], 'Patient note')
        url = '/api/preparation/entries/medications/' + key
        self.assertEqual(self.client.put(url, json={'fields': {'name': 'Updated medication'}, 'notes': ''}).status_code, 200)
        self.assertEqual(self.client.get('/api/clinical').json['medications'][0]['name'], 'Updated medication')
        self.assertEqual(self.client.delete(url).status_code, 200)
        self.assertEqual(self.client.get('/api/clinical').json['medications'], [])
        self.assertEqual(self.client.post('/api/preparation/entries/medications', json=[]).status_code, 400)
        self.assertEqual(self.client.post('/api/preparation/entries/medications', json={'fields': {'name': ''}}).status_code, 400)
        self.assertEqual(self.client.post('/api/preparation/entries/events', json={'fields': {'title': 'Test', 'date': 'not-a-date'}}).status_code, 400)
        app.clinical.replace_document(app.get_db(), 'sample-a', {'document': 'sample.pdf', 'labs': [{'test': 'Glucose', 'value': 90, 'page': 1}]})
        key = self.client.get('/api/clinical').json['lab_results'][0]['_key']
        url = '/api/preparation/entries/lab_results/' + key
        self.assertEqual(self.client.put(url, json={'fields': {'value': '95'}, 'notes': ''}).status_code, 400)
        self.assertEqual(self.client.put(url, json={'fields': {}, 'notes': 'Sample lab note'}).status_code, 200)
        self.assertEqual(self.client.get('/api/clinical').json['lab_results'][0]['value'], 90)

    def test_duplicate_source_results_have_independent_stable_notes(self):
        common = {'test': 'Glucose', 'taken_at': '2025-01-01', 'page': 2, 'value': 90, 'test_reported': 'Glucose A', 'panel': 'Panel A'}
        manifest = {'document': 'sample.pdf', 'labs': [common, {**common, 'value': 95}, {**common, 'panel': 'Panel B'}, {**common, 'test_reported': 'Glucose B'}, dict(common)]}
        app.clinical.replace_document(app.get_db(), 'sample-a', manifest)
        rows = self.client.get('/api/clinical').json['lab_results']
        keys = [row['_key'] for row in rows]
        self.assertEqual(len(set(keys)), 5)
        for index, key in enumerate(keys):
            url = '/api/preparation/entries/lab_results/' + key
            self.assertEqual(self.client.put(url, json={'fields': {}, 'notes': f'Note for result {index}'}).status_code, 200)
        annotated = self.client.get('/api/clinical').json['lab_results']
        self.assertEqual([row['_patient_note'] for row in annotated], [f'Note for result {i}' for i in range(5)])
        app.clinical.replace_document(app.get_db(), 'sample-a', manifest)
        reimported = self.client.get('/api/clinical').json['lab_results']
        self.assertEqual([row['_key'] for row in reimported], keys)
        self.assertEqual([row['_patient_note'] for row in reimported], [f'Note for result {i}' for i in range(5)])
        # The exact duplicate's second occurrence is independently removable too.
        self.assertEqual(self.client.delete('/api/preparation/entries/lab_results/' + keys[-1]).status_code, 200)
        remaining = self.client.get('/api/clinical').json['lab_results']
        self.assertEqual(remaining[0]['_patient_note'], 'Note for result 0')
        self.assertNotIn('_patient_note', remaining[-1])


    def test_delete_and_restore_source_group_preserves_updates_and_reimport(self):
        manifest = {'document': 'sample.pdf', 'diagnoses': [
            {'name': 'Sample condition', 'date': '2024-01-01', 'status': 'active', 'page': 1},
            {'name': 'Sample condition', 'date': '2025-01-01', 'status': 'active', 'page': 2},
        ]}
        app.clinical.replace_document(app.get_db(), 'sample-a', manifest)
        keys = [row['_key'] for row in self.client.get('/api/clinical').json['diagnoses']]
        self.client.put('/api/preparation/entries/diagnoses/' + keys[0], json={'fields': {'note': 'Saved detail'}, 'notes': 'Saved note'})
        url = '/api/preparation/entries/diagnoses'
        self.assertEqual(self.client.patch(url, json={'keys': keys, 'deleted': True}).status_code, 200)
        data = self.client.get('/api/clinical').json
        self.assertEqual(data['diagnoses'], [])
        self.assertEqual(len(data['deleted_entries']['diagnoses']), 2)
        self.assertEqual(len(app.clinical.load_clinical(app.get_db(), 'sample-a')['diagnoses']), 2)
        app.clinical.replace_document(app.get_db(), 'sample-a', manifest)
        self.assertEqual(self.client.get('/api/clinical').json['diagnoses'], [])
        # Editing a deleted record must not accidentally restore it.
        self.client.put('/api/preparation/entries/diagnoses/' + keys[0], json={'fields': {'note': 'Updated detail'}, 'notes': 'Updated note'})
        self.assertEqual(self.client.get('/api/clinical').json['diagnoses'], [])
        self.assertEqual(self.client.patch(url, json={'keys': keys, 'deleted': False}).status_code, 200)
        restored = self.client.get('/api/clinical').json
        self.assertEqual(len(restored['diagnoses']), 2)
        self.assertEqual(restored['deleted_entries']['diagnoses'], [])
        self.assertEqual(restored['diagnoses'][0]['_patient_note'], 'Updated note')
        self.assertEqual(restored['diagnoses'][0]['note'], 'Updated detail')
        self.assertNotIn('_original', restored['diagnoses'][1])

    def test_delete_validation_is_atomic_and_account_scoped(self):
        created = self.client.post('/api/preparation/entries/medications', json={'fields': {'name': 'Sample medication'}, 'notes': 'Sample note'}).json
        key, url = created['key'], '/api/preparation/entries/medications'
        for payload in [{'keys': [], 'deleted': True}, {'keys': [key], 'deleted': 'true'}, {'keys': [2], 'deleted': True}, []]:
            self.assertEqual(self.client.patch(url, json=payload).status_code, 400)
        self.assertEqual(self.client.patch(url, data='deleted=true').status_code, 400)
        self.assertEqual(self.client.patch(url, json={'keys': [key, 'unknown-key'], 'deleted': True}).status_code, 404)
        self.assertEqual(len(self.client.get('/api/clinical').json['medications']), 1)
        with self.client.session_transaction() as session:
            session['user'] = 'sample-b'
        self.assertEqual(self.client.patch(url, json={'keys': [key], 'deleted': True}).status_code, 404)
        self.assertEqual(self.client.get('/api/clinical').json['deleted_entries']['medications'], [])
        with self.client.session_transaction() as session:
            session['user'] = 'sample-a'
        self.assertEqual(self.client.patch(url, json={'keys': [key], 'deleted': True}).status_code, 200)
        self.assertEqual(self.client.get('/api/clinical').json['medications'], [])
        self.assertEqual(self.client.patch(url, json={'keys': [key], 'deleted': False}).status_code, 200)
        self.assertEqual(self.client.get('/api/clinical').json['medications'][0]['_patient_note'], 'Sample note')
        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.patch(url, json={'keys': [key], 'deleted': True}).status_code, 401)



if __name__ == '__main__':
    unittest.main()
