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
    "goals": {"why": "Keep my medical information in one calm, private place.", "immediate": ["Add current care team and upcoming appointments.", "Upload recent lab reports and imaging."], "questions": ["What should we ask at the next visit?", "Which follow-ups are due?"]},
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
    return json.loads(row[0]) if row else DEFAULT_RECORDS


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
    return render_template("dashboard.html", records=load_records(user), docs=available_docs(user))


@app.get("/api/records")
def records_api():
    guard = require_login()
    if guard:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(load_records(session["user"]))


@app.get("/api/vitals")
def vitals_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(vitals.load_vitals(get_db(), session["user"]))


@app.get("/api/clinical")
def clinical_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(clinical.load_clinical(get_db(), session["user"]))


@app.get("/api/genetics")
def genetics_api():
    if not session.get("user"):
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(genetics.load_genetics(get_db(), session["user"]))


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
