import copy
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
from datetime import date
from pathlib import Path

import libsql
from flask import Flask, Response, abort, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from google.cloud import storage as gcs
from werkzeug.utils import secure_filename

import clinical
import genetics
import preparation
import vitals

mimetypes.add_type("text/javascript", ".mjs")  # PDF.js ships ES modules

SESSION_SECRET = os.environ.get("CHART_SESSION_SECRET", "change-this-before-deploying")
USERS: dict[str, str] = json.loads(os.environ.get("CHART_USERS", "{}"))
GCS_BUCKET = os.environ.get("GCS_BUCKET", "")
TURSO_URL = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")
# Local development without a bucket: serve PDFs from this directory instead.
LOCAL_DOCS_DIR = os.environ.get("CHART_LOCAL_DOCS_DIR", "")

app = Flask(__name__)
app.secret_key = SESSION_SECRET
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=os.environ.get("CHART_COOKIE_SECURE", "true").lower() == "true")

# Each account is fully separate: its own records, documents, vitals, and genetics.
DEFAULT_RECORDS = {
    "goals": {"items": [], "questions": []},
    "history": [{"date": "Add date", "title": "Medical history entry", "detail": "Replace this starter record with the relevant event, diagnosis, or procedure."}],
    "family_history": [{"relation": "Add relation", "detail": "Add family history details here."}],
    "labs": [{"date": "Add date", "name": "Lab panel", "value": "Add result", "range": "Add reference range", "status": "Pending"}],
    "medications": [{"name": "Add medication or supplement", "dose": "Dose", "schedule": "Schedule", "status": "Current"}],
    "synopsis": "This is a private workspace for organizing medical records. It is not medical advice. Add a concise, clinician-friendly synopsis once the source records are uploaded.",
}


def normalize_visit_items(items):
    normalized = []
    if isinstance(items, list):
        for index, item in enumerate(items, 1):
            if isinstance(item, str):
                normalized.append({"priority": index, "doing": "", "goal": item, "direction": "", "addressed": False})
            elif isinstance(item, dict):
                normalized.append({"priority": index, "doing": item.get("doing", ""), "goal": item.get("goal", ""),
                                   "direction": item.get("direction", ""), "addressed": bool(item.get("addressed", False))})
    return normalized


def normalize_goals(goals):
    goals = goals if isinstance(goals, dict) else {}
    if isinstance(goals.get("current_visit"), dict):
        active = goals["current_visit"]
    else:  # Convert the original flat priority list into the current visit.
        active = {"items": goals.get("items", []), "questions": goals.get("questions", [])}
    current = {
        "date": active.get("date", "") if isinstance(active.get("date", ""), str) else "",
        "items": normalize_visit_items(active.get("items", [])),
        "questions": active.get("questions", []) if isinstance(active.get("questions", []), list) else [],
    }
    visits = []
    for visit in goals.get("visits", []) if isinstance(goals.get("visits", []), list) else []:
        if not isinstance(visit, dict):
            continue
        visits.append({"date": visit.get("date", "") if isinstance(visit.get("date", ""), str) else "",
                       "closed_at": visit.get("closed_at", "") if isinstance(visit.get("closed_at", ""), str) else "",
                       "items": normalize_visit_items(visit.get("items", [])),
                       "questions": visit.get("questions", []) if isinstance(visit.get("questions", []), list) else []})
    issues = goals.get("issues", []) if isinstance(goals.get("issues", []), list) else []
    return {"current_visit": current, "visits": visits, "issues": issues}


def get_db():
    return libsql.connect(database=TURSO_URL, auth_token=TURSO_TOKEN)


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY DEFAULT 1,
            data TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_records (
            username TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS provider_accounts (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            patient TEXT NOT NULL,
            display_name TEXT NOT NULL,
            must_change_password INTEGER NOT NULL DEFAULT 1
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS provider_access (
            username TEXT PRIMARY KEY,
            sections TEXT NOT NULL,
            documents TEXT NOT NULL DEFAULT '[]'
        )
    """)
    conn.commit()
    vitals.init_schema(conn)
    genetics.init_schema(conn)
    clinical.init_schema(conn)
    preparation.init_schema(conn)


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"pbkdf2_sha256$310000${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds, salt_hex, digest_hex = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def load_records(user: str) -> dict:
    row = get_db().execute("SELECT data FROM user_records WHERE username = ?", (user,)).fetchone()
    records = json.loads(row[0]) if row else copy.deepcopy(DEFAULT_RECORDS)
    records["goals"] = normalize_goals(records.get("goals"))
    return records


def save_records(user: str, records: dict):
    conn = get_db()
    conn.execute(
        "INSERT INTO user_records (username, data, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        (user, json.dumps(records)),
    )
    conn.commit()


def require_login():
    if not session.get("user"):
        return redirect(url_for("login", next=request.path))
    return None


VISIBLE_SECTIONS = ('goals', 'history', 'timeline', 'labs', 'vitals', 'family', 'genetics', 'documents', 'medications')
TIMELINE_DOCUMENT = 'Oct_2026_Integrated_Medical_Timeline_UPDATED.pdf'


def provider_account(username: str | None = None):
    username = username or session.get('user', '')
    if not username:
        return None
    return get_db().execute(
        'SELECT username, password_hash, patient, display_name, must_change_password FROM provider_accounts WHERE username = ?',
        (username,),
    ).fetchone()


def is_provider():
    return bool(session.get('role') == 'provider')


def data_user():
    return session.get('patient') if is_provider() else session.get('user')


def owner_only_json():
    if is_provider():
        return jsonify({'error': 'Provider accounts are read-only'}), 403
    return None


def get_provider_access(username: str):
    row = get_db().execute('SELECT sections, documents FROM provider_access WHERE username = ?', (username,)).fetchone()
    sections = {name: True for name in VISIBLE_SECTIONS}
    documents = []
    if row:
        try:
            sections.update({k: bool(v) for k, v in json.loads(row[0]).items() if k in VISIBLE_SECTIONS})
            documents = json.loads(row[1])
        except (TypeError, ValueError):
            pass
    return {'sections': sections, 'documents': documents if isinstance(documents, list) else []}


def provider_can_see_document(filename: str, user: str | None = None):
    if not is_provider():
        return True
    access = get_provider_access(session['user'])
    if filename == TIMELINE_DOCUMENT:
        return bool(access['sections'].get('timeline', False))
    return bool(access['sections'].get('documents', False) and filename in access['documents'])


@app.before_request
def enforce_provider_password_change():
    if not is_provider() or request.endpoint in {'login', 'login_post', 'logout', 'change_password', 'change_password_post', 'static'}:
        return None
    account = provider_account()
    if not account:
        session.clear()
        if request.path.startswith('/api/'):
            return jsonify({'error': 'unauthorized'}), 401
        return redirect(url_for('login'))
    session['patient'] = account[2]
    if account[4]:
        if request.path.startswith('/api/'):
            return jsonify({'error': 'Change your password before continuing'}), 403
        return redirect(url_for('change_password'))
    return None


@app.context_processor
def inject_context():
    user = session.get("user", "")
    account = provider_account(user) if user else None
    patient = account[2] if account else user
    return {"logged_in": bool(user), "current_user": patient, "provider_login": bool(account),
            "provider_display_name": account[3] if account else ''}


@app.get("/login")
def login():
    if session.get("user"):
        return redirect(url_for("dashboard"))
    return render_template("login.html", error=None)


@app.post("/login")
def login_post():
    username = request.form.get("username", "").lower().strip()
    password = request.form.get("password", "")
    account = provider_account(username)
    if account and check_password(password, account[1]):
        session.clear()
        session.update(user=username, role='provider', patient=account[2])
        if account[4]:
            return redirect(url_for('change_password'))
        return redirect(url_for('dashboard'))
    stored_hash = USERS.get(username, "")
    if stored_hash and check_password(password, stored_hash):
        session.clear()
        session["user"] = username
        next_path = request.args.get("next", "")
        if not next_path.startswith("/") or next_path.startswith("//"):
            next_path = url_for("dashboard")
        return redirect(next_path)
    return render_template("login.html", error="That login did not match. Check your username and password and try again."), 401


@app.get('/change-password')
def change_password():
    if not is_provider():
        return redirect(url_for('login'))
    return render_template('change_password.html', error=None)


@app.post('/change-password')
def change_password_post():
    if not is_provider():
        return redirect(url_for('login'))
    account = provider_account()
    current = request.form.get('current_password', '')
    new = request.form.get('new_password', '')
    confirm = request.form.get('confirm_password', '')
    if not account or not check_password(current, account[1]):
        return render_template('change_password.html', error='Current password is incorrect.'), 400
    if len(new) < 12:
        return render_template('change_password.html', error='Choose a password with at least 12 characters.'), 400
    if new == current:
        return render_template('change_password.html', error='Choose a password different from the temporary password.'), 400
    if new != confirm:
        return render_template('change_password.html', error='The new passwords do not match.'), 400
    conn = get_db()
    conn.execute('UPDATE provider_accounts SET password_hash = ?, must_change_password = 0 WHERE username = ?',
                 (hash_password(new), session['user']))
    conn.commit()
    return redirect(url_for('dashboard'))


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
def dashboard():
    guard = require_login()
    if guard:
        return guard
    user = data_user()
    account = provider_account() if is_provider() else None
    access = get_provider_access(session['user']) if is_provider() else {'sections': {key: True for key in VISIBLE_SECTIONS}, 'documents': []}
    docs = available_docs(user)
    records = load_records(user)
    saved_preparation = preparation.load(get_db(), user)
    if is_provider():
        docs = [doc for doc in docs if doc['filename'] in access['documents'] and provider_can_see_document(doc['filename'])]
        if not access['sections'].get('goals'):
            records['goals'] = {'current_visit': {'date': '', 'items': [], 'questions': []}, 'visits': [], 'issues': []}
        visible_prep = {}
        for key, value in saved_preparation.items():
            if key.startswith('section:') and access['sections'].get(key.split(':', 1)[1], False):
                visible_prep[key] = value
            elif key.startswith('family_member:') and access['sections'].get('family', False):
                visible_prep[key] = value
        for doc in docs:
            key = 'source:' + doc['filename']
            visible_prep[key] = {'included': True}
        if access['sections'].get('timeline', False):
            visible_prep['source:' + TIMELINE_DOCUMENT] = {'included': True}
        saved_preparation = visible_prep
    else:
        saved_preparation['source:' + TIMELINE_DOCUMENT] = {'included': True}
    return render_template("dashboard.html", records=records, docs=docs,
                           preparation=saved_preparation, visible_sections=access['sections'],
                           provider_login=bool(account), provider_display_name=account[3] if account else '',
                           timeline_document=TIMELINE_DOCUMENT)


@app.get("/api/records")
def records_api():
    guard = require_login()
    if guard:
        return jsonify({"error": "unauthorized"}), 401
    records = load_records(data_user())
    if is_provider():
        access = get_provider_access(session['user'])['sections']
        if not access.get('goals'):
            records['goals'] = {'current_visit': {'date': '', 'items': [], 'questions': []}, 'visits': [], 'issues': []}
        records = {'goals': records['goals']}
    return jsonify(records)


@app.post("/api/goals")
def goals_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    if (denied := owner_only_json()) is not None:
        return denied
    # JSON only: a cross-site form can't send it, so this doubles as CSRF protection.
    body = request.get_json(silent=True) if request.is_json else None
    if not isinstance(body, dict):
        return jsonify({"error": "Provide visit priorities and questions"}), 400
    active = body.get("current_visit")
    if not isinstance(active, dict):
        return jsonify({"error": "A current visit is required"}), 400

    def valid_date(value):
        if not isinstance(value, str) or len(value) > 10:
            return False
        if not value:
            return True
        try:
            return date.fromisoformat(value).isoformat() == value
        except ValueError:
            return False

    def clean_visit(visit, closed=False):
        if not isinstance(visit, dict) or not valid_date(visit.get("date", "")):
            raise ValueError("Visit dates must use YYYY-MM-DD")
        items = visit.get("items")
        questions = visit.get("questions")
        if not isinstance(items, list) or len(items) > 100 or not isinstance(questions, list) or len(questions) > 100:
            raise ValueError("Each visit can have up to 100 priorities and questions")
        cleaned_items = []
        for index, item in enumerate(items, 1):
            if not isinstance(item, dict) or set(item) - {"priority", "doing", "goal", "direction", "addressed"}:
                raise ValueError("Each priority must contain supported fields")
            if any(not isinstance(item.get(field, ""), str) or len(item.get(field, "")) > 5000 for field in ("doing", "goal", "direction")):
                raise ValueError("Priority details must be text up to 5,000 characters each")
            if type(item.get("addressed", False)) is not bool:
                raise ValueError("Priority addressed status must be true or false")
            cleaned_items.append({"priority": index, "doing": item.get("doing", "").strip(), "goal": item.get("goal", "").strip(),
                                  "direction": item.get("direction", "").strip(), "addressed": item.get("addressed", False)})
        if not all(isinstance(value, str) and len(value) <= 2000 for value in questions):
            raise ValueError("Visit questions must be text up to 2,000 characters each")
        result = {"date": visit.get("date", ""), "items": cleaned_items, "questions": [value.strip() for value in questions if value.strip()]}
        if closed:
            closed_at = visit.get("closed_at", "")
            if not valid_date(closed_at):
                raise ValueError("Visit close dates must use YYYY-MM-DD")
            result["closed_at"] = closed_at
        return result

    try:
        goals = {"current_visit": clean_visit(active)}
        visits = body.get("visits", [])
        if not isinstance(visits, list) or len(visits) > 1000:
            raise ValueError("Visit history must be a list of up to 1,000 visits")
        goals["visits"] = [clean_visit(visit, closed=True) for visit in visits]
        issues = body.get("issues", [])
        if not isinstance(issues, list) or len(issues) > 100:
            raise ValueError("Issues must be a list of up to 100 entries")
        goals["issues"] = []
        for issue in issues:
            if not isinstance(issue, dict) or set(issue) != {"title", "detail"} or any(not isinstance(issue[key], str) or len(issue[key]) > 5000 for key in ("title", "detail")) or not issue["title"].strip():
                raise ValueError("Each issue needs a title and text details")
            goals["issues"].append({"title": issue["title"].strip(), "detail": issue["detail"].strip()})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    records = load_records(data_user())
    records["goals"] = goals
    save_records(data_user(), records)
    return jsonify(goals)


@app.get("/api/vitals")
def vitals_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    conn, user = get_db(), data_user()
    if is_provider() and not get_provider_access(session['user'])['sections'].get('vitals', False):
        return jsonify({'metrics': {}, 'series': {}, 'cycles': [], 'deleted_entries': {}})
    updates = preparation.load(conn, user)
    data = vitals.load_vitals(conn, user)
    data['deleted_entries'] = {}
    for table, rows in preparation.vital_rows(data).items():
        visible, deleted = preparation.apply_row_updates(table, rows, updates)
        preparation_rows = []
        for key, update in updates.items():
            if key.startswith(table + ':manual:'):
                preparation_rows.append({**update.get('fields', {}), '_key': key, '_manual': True, '_patient_note': update.get('notes', '')})
        data['deleted_entries'][table] = deleted + [r for r in preparation_rows if updates[r['_key']].get('deleted')]
        data['visible_' + table] = visible + [r for r in preparation_rows if not updates[r['_key']].get('deleted')]
    data['series'] = {}
    for row in data.pop('visible_measurements'):
        if row.get('metric') in data['metrics']:
            try:
                value = float(row['value'])
            except (TypeError, ValueError):
                continue
            data['series'].setdefault(row['metric'], []).append({'t': row['taken_at'], 'v': value, 'source': row.get('source'), 'doc': row.get('doc'), 'page': row.get('page'), 'note': row.get('note'), 'seq': row.get('seq'), '_key': row['_key'], '_original': row.get('_original'), '_patient_note': row.get('_patient_note'), '_patient_updated': row.get('_patient_updated')})
    data['cycles'] = [{**r, 'start': r['start'], 'end': r['end']} for r in data.pop('visible_cycles')]
    if is_provider():
        data['deleted_entries'] = {}
    return jsonify(data)


@app.get("/api/clinical")
def clinical_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    user = data_user()
    updates = preparation.load(conn, user)
    source_data = clinical_records_for_person(conn, user)
    data = preparation.apply(source_data, updates)
    if is_provider():
        access = get_provider_access(session['user'])
        sections = access['sections']
        if not sections.get('history'):
            data['diagnoses'], data['allergies'], data['events'] = [], [], []
        if not sections.get('medications'):
            data['medications'] = []
        if not sections.get('labs'):
            data['lab_results'] = []
        if not sections.get('family'):
            data['family_history'] = []
        if not sections.get('genetics'):
            data['clinical_genetics'] = []
        selected = set(access['documents']) if sections.get('documents') else set()
        data['documents'] = [doc for doc in data['documents'] if doc['document'] in selected and provider_can_see_document(doc['document'])]
        if not sections.get('documents'):
            data['documents'] = []
    for table, rows in preparation.vital_rows(vitals.load_vitals(conn, user)).items():
        _, data['deleted_entries'][table] = preparation.apply_table(table, rows, updates)
    if is_provider():
        data['deleted_entries'] = {}
    return jsonify(data)


def clinical_records_for_person(conn, user):
    """Return extracted records plus uploaded PDFs that have not been extracted yet."""
    data = clinical.load_clinical(conn, user)
    known_documents = {row['document'] for row in data['documents']}
    data['documents'].extend(
        {'document': item['filename'], 'title': item['name'], 'date': None, 'provider': None,
         'clinician': None, 'kind': None, 'summary': None, 'unextracted': True}
        for item in available_docs(user) if item['filename'] not in known_documents
    )
    return data


@app.get('/api/preparation')
def preparation_api():
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if is_provider():
        return jsonify({})
    return jsonify(preparation.load(get_db(), data_user()))


@app.put('/api/preparation/sources')
def preparation_source():
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if (denied := owner_only_json()) is not None:
        return denied
    body = request.get_json(silent=True) if request.is_json else None
    if not isinstance(body, dict) or set(body) != {'document', 'included'}:
        return jsonify({'error': 'Provide a document filename and inclusion flag'}), 400
    filename = body['document']
    if (not isinstance(filename, str) or not filename or len(filename) > 500
            or Path(filename).name != filename or '\\' in filename or not filename.lower().endswith('.pdf')):
        return jsonify({'error': 'Choose a valid PDF filename'}), 400
    if type(body['included']) is not bool:
        return jsonify({'error': 'The inclusion flag must be true or false'}), 400
    update = {'included': body['included']}
    preparation.save(get_db(), data_user(), 'source:' + filename, update)
    return jsonify({'document': filename, **update})


@app.put('/api/preparation/family-members')
def preparation_family_member():
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if (denied := owner_only_json()) is not None:
        return denied
    body = request.get_json(silent=True) if request.is_json else None
    if not isinstance(body, dict) or set(body) != {'relation', 'fields'}:
        return jsonify({'error': 'Provide a family member and their details'}), 400
    relation, fields = body['relation'], body['fields']
    if not isinstance(relation, str) or not relation.strip() or len(relation) > 100:
        return jsonify({'error': 'Choose a valid family member'}), 400
    if not isinstance(fields, dict) or set(fields) - {'dob', 'deceased', 'date_of_death'}:
        return jsonify({'error': 'Unsupported family member details'}), 400
    dob, death_date = fields.get('dob', ''), fields.get('date_of_death', '')
    if not isinstance(dob, str) or not isinstance(death_date, str) or len(dob) > 10 or len(death_date) > 10:
        return jsonify({'error': 'Dates must use YYYY-MM-DD'}), 400
    from datetime import date
    for value in (dob, death_date):
        if value:
            try:
                if date.fromisoformat(value).isoformat() != value:
                    raise ValueError
            except ValueError:
                return jsonify({'error': 'Dates must use YYYY-MM-DD'}), 400
    if type(fields.get('deceased', False)) is not bool:
        return jsonify({'error': 'Deceased must be true or false'}), 400
    slug = ''.join(c.lower() if c.isalnum() else '_' for c in relation.strip()).strip('_')
    slug = '_'.join(part for part in slug.split('_') if part)
    details = {'dob': dob, 'deceased': fields.get('deceased', False), 'date_of_death': death_date}
    preparation.save(get_db(), data_user(), 'family_member:' + slug, details)
    return jsonify({'relation': relation.strip(), **details})


@app.put('/api/preparation/sections/<section>')
def preparation_section(section):
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if (denied := owner_only_json()) is not None:
        return denied
    body = request.get_json(silent=True) if request.is_json else None
    if section not in preparation.SECTIONS or not isinstance(body, dict) or set(body) != {'summary', 'notes'}:
        return jsonify({'error': 'Provide a summary and notes for a supported section'}), 400
    if any(not isinstance(v, str) or len(v) > 10000 for v in body.values()):
        return jsonify({'error': 'Summary and notes must be text up to 10,000 characters each'}), 400
    update = {k: v.strip() for k, v in body.items()}
    preparation.save(get_db(), data_user(), 'section:' + section, update)
    return jsonify(update)


@app.route('/api/preparation/entries/<table>', methods=['POST', 'PATCH'])
@app.route('/api/preparation/entries/<table>/<key>', methods=['PUT', 'DELETE'])
def preparation_entry(table, key=None):
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if (denied := owner_only_json()) is not None:
        return denied
    conn, user = get_db(), data_user()
    if table not in preparation.FIELDS:
        return jsonify({'error': 'Unknown record type'}), 404
    updates = preparation.load(conn, user)
    def rows_for_table():
        if table in ('measurements', 'cycles'):
            return preparation.vital_rows(vitals.load_vitals(conn, user))[table]
        if table == 'genetic_findings':
            return genetics.load_genetics(conn, user)['findings']
        if table == 'documents':
            return clinical_records_for_person(conn, user)['documents']
        return clinical.load_clinical(conn, user)[table]
    if request.method == 'PATCH':
        body = request.get_json(silent=True) if request.is_json else None
        if not isinstance(body, dict) or set(body) != {'keys', 'deleted'} or type(body['deleted']) is not bool:
            return jsonify({'error': 'Provide record keys and a deleted boolean'}), 400
        keys = body['keys']
        if not isinstance(keys, list) or not 1 <= len(keys) <= 1000 or not all(isinstance(k, str) for k in keys):
            return jsonify({'error': 'Provide between 1 and 1,000 record keys'}), 400
        valid = {source_key for source_key, _ in preparation.source_rows(table, rows_for_table())}
        valid.update(k for k in updates if k.startswith(table + ':manual:'))
        if any(k not in valid for k in keys):
            return jsonify({'error': 'Record not found'}), 404
        for record_key in set(keys):
            update = {**updates.get(record_key, {'fields': {}, 'notes': ''}), 'deleted': body['deleted']}
            preparation_data = json.dumps(update)
            conn.execute('INSERT INTO preparation (person, key, data) VALUES (?, ?, ?) ON CONFLICT(person, key) DO UPDATE SET data = excluded.data', (user, record_key, preparation_data))
        conn.commit()
        return jsonify({'ok': True})
    manual = key is None or key.startswith(table + ':manual:')
    if key is not None:
        exists = key in updates if manual else any(source_key == key for source_key, _ in preparation.source_rows(table, rows_for_table()))
        if not exists or not key.startswith(table + ':'):
            return jsonify({'error': 'Record not found'}), 404
    if request.method == 'DELETE':
        conn.execute('DELETE FROM preparation WHERE person = ? AND key = ?', (user, key))
        conn.commit()
        return jsonify({'ok': True})
    body = request.get_json(silent=True) if request.is_json else None
    try:
        update = preparation.validate_entry(table, body, manual)
    except ValueError as error:
        return jsonify({'error': str(error)}), 400
    if key and updates.get(key, {}).get('deleted'):
        update['deleted'] = True
    key = key or preparation.manual_key(table)
    preparation.save(conn, user, key, update)
    return jsonify({'key': key, **update}), 201 if request.method == 'POST' else 200


@app.get("/api/genetics")
def genetics_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    conn, user = get_db(), data_user()
    if is_provider() and not get_provider_access(session['user'])['sections'].get('genetics', False):
        return jsonify({'findings': [], 'sources': [], 'deleted_entries': []})
    data = genetics.load_genetics(conn, user)
    updates = preparation.load(conn, user)
    data['findings'], data['deleted_entries'] = preparation.apply_table('genetic_findings', data['findings'], updates)
    for row in data['findings'] + data['deleted_entries']:
        update = updates.get(row['_key'])
        if update and update.get('notes'):
            row['_patient_note'] = update['notes']
    for key, update in updates.items():
        if key.startswith('genetic_findings:manual:'):
            row = {**update['fields'], '_key': key, '_manual': True, '_patient_note': update['notes']}
            (data['deleted_entries'] if update.get('deleted') else data['findings']).append(row)
    if is_provider():
        data['deleted_entries'] = []
    return jsonify(data)


@app.get('/api/provider-access')
def provider_access_api():
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if is_provider() or data_user() != 'mia':
        return jsonify({'error': 'Only Mia can manage provider access'}), 403
    conn = get_db()
    rows = conn.execute('SELECT username, display_name FROM provider_accounts WHERE patient = ? ORDER BY display_name', ('mia',)).fetchall()
    docs = available_docs('mia')
    prep = preparation.load(conn, 'mia')
    return jsonify({'providers': [
        {'username': row[0], 'display_name': row[1], **get_provider_access(row[0])}
        for row in rows
    ], 'documents': [
        {'filename': doc['filename'], 'name': doc['name'], 'included_in_presentation': bool(prep.get('source:' + doc['filename'], {}).get('included'))}
        for doc in docs
    ], 'sections': list(VISIBLE_SECTIONS)})


@app.put('/api/provider-access/<username>')
def update_provider_access_api(username):
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    if is_provider() or data_user() != 'mia':
        return jsonify({'error': 'Only Mia can manage provider access'}), 403
    body = request.get_json(silent=True) if request.is_json else None
    if not isinstance(body, dict) or set(body) != {'sections', 'documents'}:
        return jsonify({'error': 'Provide section and medical record access'}), 400
    sections, documents = body['sections'], body['documents']
    if not isinstance(sections, dict) or set(sections) - set(VISIBLE_SECTIONS) or any(type(value) is not bool for value in sections.values()):
        return jsonify({'error': 'Section settings must be checkboxes'}), 400
    if not isinstance(documents, list) or len(documents) > 500 or not all(isinstance(value, str) and Path(value).name == value for value in documents):
        return jsonify({'error': 'Choose valid medical record files'}), 400
    conn = get_db()
    account = conn.execute('SELECT patient FROM provider_accounts WHERE username = ?', (username,)).fetchone()
    if not account or account[0] != 'mia':
        return jsonify({'error': 'Provider account not found'}), 404
    available = {doc['filename'] for doc in available_docs('mia')}
    if not set(documents) <= available:
        return jsonify({'error': 'A selected medical record is no longer available'}), 400
    current = {name: False for name in VISIBLE_SECTIONS}
    current.update(sections)
    conn.execute('''INSERT INTO provider_access (username, sections, documents) VALUES (?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET sections = excluded.sections, documents = excluded.documents''',
                 (username, json.dumps(current), json.dumps(sorted(set(documents)))))
    conn.commit()
    return jsonify({'username': username, 'sections': current, 'documents': sorted(set(documents))})


def get_bucket():
    client = gcs.Client()
    return client.bucket(GCS_BUCKET)


def docs_prefix(user: str) -> str:
    return f"docs/{user}/"


def available_docs(user: str):
    if not GCS_BUCKET:
        if not LOCAL_DOCS_DIR:
            return []
        paths = sorted((Path(LOCAL_DOCS_DIR) / user).glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
        return [{"name": p.stem.replace("_", " "), "filename": p.name, "size": round(p.stat().st_size / 1024), "updated": p.stat().st_mtime}
                for p in paths if p.name != TIMELINE_DOCUMENT]
    bucket = get_bucket()
    blobs = list(bucket.list_blobs(prefix=docs_prefix(user)))
    docs = []
    for blob in sorted(blobs, key=lambda b: b.updated, reverse=True):
        name = blob.name.removeprefix(docs_prefix(user))
        if not name or name == TIMELINE_DOCUMENT or "/" in name or not name.lower().endswith(".pdf"):
            continue
        docs.append({
            "name": name.rsplit(".", 1)[0].replace("_", " "),
            "filename": name,
            "size": round(blob.size / 1024),
            "updated": blob.updated.timestamp(),
        })
    return docs


@app.get("/documents/<path:filename>")
def document(filename):
    guard = require_login()
    if guard:
        return guard
    safe_name = secure_filename(filename)
    if not safe_name.lower().endswith(".pdf"):
        abort(404)
    user = data_user()
    if is_provider() and not provider_can_see_document(safe_name):
        abort(404)
    if not GCS_BUCKET and LOCAL_DOCS_DIR:
        return send_from_directory(Path(LOCAL_DOCS_DIR) / user, safe_name, mimetype="application/pdf")
    bucket = get_bucket()
    blob = bucket.blob(docs_prefix(user) + safe_name)
    if not blob.exists():
        abort(404)
    return Response(blob.download_as_bytes(), mimetype="application/pdf",
                    headers={"Content-Disposition": f"inline; filename=\"{safe_name}\""})


@app.post("/documents/upload")
def upload_document():
    guard = require_login()
    if guard:
        return guard
    if is_provider():
        abort(403)
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return redirect(url_for("dashboard"))
    filename = secure_filename(uploaded.filename)
    if not filename.lower().endswith(".pdf"):
        abort(415)
    bucket = get_bucket()
    blob = bucket.blob(docs_prefix(data_user()) + filename)
    blob.upload_from_file(uploaded.stream, content_type="application/pdf")
    return redirect(url_for("dashboard") + "#documents")


if TURSO_URL:
    init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
