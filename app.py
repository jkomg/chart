import copy
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
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
    if "items" not in records.get("goals", {}):
        records["goals"] = copy.deepcopy(DEFAULT_RECORDS["goals"])  # the old starter shape had only placeholder text
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


@app.context_processor
def inject_context():
    user = session.get("user", "")
    return {"logged_in": bool(user), "current_user": user}


@app.get("/login")
def login():
    if session.get("user"):
        return redirect(url_for("dashboard"))
    return render_template("login.html", error=None)


@app.post("/login")
def login_post():
    username = request.form.get("username", "").lower().strip()
    password = request.form.get("password", "")
    stored_hash = USERS.get(username, "")
    if stored_hash and check_password(password, stored_hash):
        session.clear()
        session["user"] = username
        next_path = request.args.get("next", "")
        if not next_path.startswith("/") or next_path.startswith("//"):
            next_path = url_for("dashboard")
        return redirect(next_path)
    return render_template("login.html", error="That login did not match. Check your username and password and try again."), 401


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
def dashboard():
    guard = require_login()
    if guard:
        return guard
    user = session["user"]
    return render_template("dashboard.html", records=load_records(user), docs=available_docs(user), preparation=preparation.load(get_db(), user))


@app.get("/api/records")
def records_api():
    guard = require_login()
    if guard:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(load_records(session["user"]))


@app.post("/api/goals")
def goals_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    # JSON only: a cross-site form can't send it, so this doubles as CSRF protection.
    body = request.get_json(silent=True) if request.is_json else None
    goals = {}
    for key in ("items", "questions"):
        values = (body or {}).get(key)
        if not isinstance(values, list) or len(values) > 100 or not all(isinstance(v, str) and len(v) <= 2000 for v in values):
            return jsonify({"error": f"{key} must be a list of strings"}), 400
        goals[key] = [v.strip() for v in values if v.strip()]
    records = load_records(session["user"])
    records["goals"] = goals
    save_records(session["user"], records)
    return jsonify(goals)


@app.get("/api/vitals")
def vitals_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    conn, user = get_db(), session['user']
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
    return jsonify(data)


@app.get("/api/clinical")
def clinical_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    user = session['user']
    updates = preparation.load(conn, user)
    source_data = clinical_records_for_person(conn, user)
    data = preparation.apply(source_data, updates)
    for table, rows in preparation.vital_rows(vitals.load_vitals(conn, user)).items():
        _, data['deleted_entries'][table] = preparation.apply_table(table, rows, updates)
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
    return jsonify(preparation.load(get_db(), session['user']))


@app.put('/api/preparation/sources')
def preparation_source():
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
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
    preparation.save(get_db(), session['user'], 'source:' + filename, update)
    return jsonify({'document': filename, **update})


@app.put('/api/preparation/sections/<section>')
def preparation_section(section):
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    body = request.get_json(silent=True) if request.is_json else None
    if section not in preparation.SECTIONS or not isinstance(body, dict) or set(body) != {'summary', 'notes'}:
        return jsonify({'error': 'Provide a summary and notes for a supported section'}), 400
    if any(not isinstance(v, str) or len(v) > 10000 for v in body.values()):
        return jsonify({'error': 'Summary and notes must be text up to 10,000 characters each'}), 400
    update = {k: v.strip() for k, v in body.items()}
    preparation.save(get_db(), session['user'], 'section:' + section, update)
    return jsonify(update)


@app.route('/api/preparation/entries/<table>', methods=['POST', 'PATCH'])
@app.route('/api/preparation/entries/<table>/<key>', methods=['PUT', 'DELETE'])
def preparation_entry(table, key=None):
    if not session.get('user'):
        return jsonify({'error': 'unauthorized'}), 401
    conn, user = get_db(), session['user']
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
    conn, user = get_db(), session['user']
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
    return jsonify(data)


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
        return [{"name": p.stem.replace("_", " "), "filename": p.name, "size": round(p.stat().st_size / 1024), "updated": p.stat().st_mtime} for p in paths]
    bucket = get_bucket()
    blobs = list(bucket.list_blobs(prefix=docs_prefix(user)))
    docs = []
    for blob in sorted(blobs, key=lambda b: b.updated, reverse=True):
        name = blob.name.removeprefix(docs_prefix(user))
        if not name or "/" in name or not name.lower().endswith(".pdf"):
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
    if not GCS_BUCKET and LOCAL_DOCS_DIR:
        return send_from_directory(Path(LOCAL_DOCS_DIR) / session["user"], safe_name, mimetype="application/pdf")
    bucket = get_bucket()
    blob = bucket.blob(docs_prefix(session["user"]) + safe_name)
    if not blob.exists():
        abort(404)
    return Response(blob.download_as_bytes(), mimetype="application/pdf",
                    headers={"Content-Disposition": f"inline; filename=\"{safe_name}\""})


@app.post("/documents/upload")
def upload_document():
    guard = require_login()
    if guard:
        return guard
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return redirect(url_for("dashboard"))
    filename = secure_filename(uploaded.filename)
    if not filename.lower().endswith(".pdf"):
        abort(415)
    bucket = get_bucket()
    blob = bucket.blob(docs_prefix(session["user"]) + filename)
    blob.upload_from_file(uploaded.stream, content_type="application/pdf")
    return redirect(url_for("dashboard") + "#documents")


if TURSO_URL:
    init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
