import hashlib
import hmac
import json
import os
import secrets

import libsql
from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for
from google.cloud import storage as gcs
from werkzeug.utils import secure_filename

SESSION_SECRET = os.environ.get("CHART_SESSION_SECRET", "change-this-before-deploying")
USERS: dict[str, str] = json.loads(os.environ.get("CHART_USERS", "{}"))
GCS_BUCKET = os.environ.get("GCS_BUCKET", "")
TURSO_URL = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")

app = Flask(__name__)
app.secret_key = SESSION_SECRET
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=os.environ.get("CHART_COOKIE_SECURE", "true").lower() == "true")

DEFAULT_RECORDS = {
    "people": ["Jason", "Mia"],
    "goals": {"why": "Keep our medical information in one calm, shared place.", "immediate": ["Add current care team and upcoming appointments.", "Upload recent lab reports and imaging."], "questions": ["What should we ask at the next visit?", "Which follow-ups are due?"]},
    "history": [{"date": "Add date", "title": "Medical history entry", "detail": "Replace this starter record with the relevant event, diagnosis, or procedure."}],
    "family_history": [{"relation": "Add relation", "detail": "Add family history details here."}],
    "labs": [{"date": "Add date", "name": "Lab panel", "value": "Add result", "range": "Add reference range", "status": "Pending"}],
    "medications": [{"name": "Add medication or supplement", "dose": "Dose", "schedule": "Schedule", "person": "Jason", "status": "Current"}],
    "synopsis": "This is a shared, private workspace for organizing medical records. It is not medical advice. Add a concise, clinician-friendly synopsis once the source records are uploaded.",
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
    conn.commit()


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


def load_records() -> dict:
    conn = get_db()
    row = conn.execute("SELECT data FROM records WHERE id = 1").fetchone()
    if row:
        return json.loads(row[0])
    return DEFAULT_RECORDS


def save_records(records: dict):
    conn = get_db()
    conn.execute(
        "INSERT INTO records (id, data, updated_at) VALUES (1, ?, datetime('now')) "
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        (json.dumps(records),),
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
        return redirect(request.args.get("next") or url_for("dashboard"))
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
    return render_template("dashboard.html", records=load_records(), docs=available_docs())


@app.get("/api/records")
def records_api():
    guard = require_login()
    if guard:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(load_records())


def get_bucket():
    client = gcs.Client()
    return client.bucket(GCS_BUCKET)


def available_docs():
    if not GCS_BUCKET:
        return []
    bucket = get_bucket()
    blobs = list(bucket.list_blobs(prefix="docs/"))
    docs = []
    for blob in sorted(blobs, key=lambda b: b.updated, reverse=True):
        name = blob.name.removeprefix("docs/")
        if not name or not name.lower().endswith(".pdf"):
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
    bucket = get_bucket()
    blob = bucket.blob(f"docs/{safe_name}")
    if not blob.exists():
        abort(404)
    from flask import Response
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
    blob = bucket.blob(f"docs/{filename}")
    blob.upload_from_file(uploaded.stream, content_type="application/pdf")
    return redirect(url_for("dashboard") + "#documents")


if TURSO_URL:
    init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
