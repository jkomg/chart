"""Account-scoped patient updates, stored independently of imported source records."""
import hashlib
import json
import uuid

SECTIONS = {'goals', 'history', 'medications', 'labs', 'vitals', 'family', 'genetics', 'documents'}
FIELDS = {
    'diagnoses': ('name', 'status', 'date', 'note'),
    'allergies': ('substance', 'reaction'),
    'events': ('title', 'type', 'date', 'detail'),
    'medications': ('name', 'dose', 'schedule', 'context', 'date'),
    'family_history': ('relation', 'condition'),
    'lab_results': (),
}
REQUIRED = {'diagnoses': 'name', 'allergies': 'substance', 'events': 'title', 'medications': 'name', 'family_history': 'relation'}


def init_schema(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS preparation (person TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (person, key))')
    conn.commit()


def load(conn, person):
    return {key: json.loads(data) for key, data in conn.execute('SELECT key, data FROM preparation WHERE person = ?', (person,)).fetchall()}


def save(conn, person, key, data):
    conn.execute('INSERT INTO preparation (person, key, data) VALUES (?, ?, ?) ON CONFLICT(person, key) DO UPDATE SET data = excluded.data', (person, key, json.dumps(data)))
    conn.commit()


def key_for(table, row, occurrence=0):
    # Use stored source fields, excluding derived flags and patient overlays. Exact
    # duplicate rows get distinct occurrence numbers in their source query order.
    identity = {column: row.get(column) for column in data_columns(table)}
    if table == 'lab_results' and row.get('flag_calculated'):
        identity['flag'] = None
    payload = {'source': identity, 'occurrence': occurrence}
    return table + ':' + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def source_rows(table, rows):
    occurrences = {}
    for row in rows:
        fingerprint = key_for(table, row)
        occurrence = occurrences.get(fingerprint, 0)
        occurrences[fingerprint] = occurrence + 1
        yield key_for(table, row, occurrence), row


def apply(data, updates):
    for table in FIELDS:
        for key, row in source_rows(table, data[table]):
            row['_key'] = key
            update = updates.get(row['_key'])
            if update:
                row['_original'] = {k: row.get(k) for k in FIELDS[table]}
                row.update(update['fields'])
                row['_patient_note'] = update['notes']
                row['_patient_updated'] = bool(update['fields'])
        for key, update in updates.items():
            if key.startswith(table + ':manual:'):
                data[table].append({**{k: None for k in data_columns(table)}, **update['fields'], '_key': key, '_manual': True, '_patient_note': update['notes']})
    return data


def data_columns(table):
    import clinical
    return clinical.TABLES[table]


def validate_entry(table, body, manual=False):
    if table not in FIELDS or not isinstance(body, dict):
        raise ValueError('Unknown record type or invalid update')
    fields, notes = body.get('fields', {}), body.get('notes', '')
    if not isinstance(fields, dict) or set(fields) - set(FIELDS[table]):
        raise ValueError('Unsupported record fields')
    if not isinstance(notes, str) or len(notes) > 10000:
        raise ValueError('Notes must be text up to 10,000 characters')
    if any(not isinstance(v, str) or len(v) > 2000 for v in fields.values()):
        raise ValueError('Record fields must be text up to 2,000 characters')
    fields = {k: v.strip() for k, v in fields.items()}
    if manual and (table not in REQUIRED or not fields.get(REQUIRED[table])):
        raise ValueError('A record name is required')
    if table in REQUIRED and REQUIRED[table] in fields and not fields[REQUIRED[table]]:
        raise ValueError('A record name is required')
    if table == 'diagnoses' and fields.get('status') not in (None, '', 'active', 'suspected', 'history', 'resolved'):
        raise ValueError('Choose a supported condition status')
    if fields.get('date'):
        from datetime import date
        try:
            if date.fromisoformat(fields['date']).isoformat() != fields['date']:
                raise ValueError('Non-canonical date')
        except ValueError:
            raise ValueError('Date must use YYYY-MM-DD') from None
    return {'fields': fields, 'notes': notes.strip()}


def manual_key(table):
    return f'{table}:manual:{uuid.uuid4().hex}'
