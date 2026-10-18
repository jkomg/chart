import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CHART_DATA_DIR", BASE_DIR / "data"))
DOCS_DIR = DATA_DIR / "docs"
DATA_FILE = DATA_DIR / "medical.json"
SESSION_SECRET = os.environ.get("CHART_SESSION_SECRET", "change-this-before-deploying")
USERS: dict[str, str] = json.loads(os.environ.get("CHART_USERS", "{}"))  # {"username": "password_hash", ...}

app = Flask(__name__)
app.secret_key = SESSION_SECRET
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=os.environ.get("CHART_COOKIE_SECURE", "true").lower() == "true")


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
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text())
        except json.JSONDecodeError:
            pass
    return {
        "people": ["Jason", "Mia"],
        "goals": {"why": "Keep our medical information in one calm, shared place.", "immediate": ["Add current care team and upcoming appointments.", "Upload recent lab reports and imaging."], "questions": ["What should we ask at the next visit?", "Which follow-ups are due?"]},
        "history": [{"date": "Add date", "title": "Medical history entry", "detail": "Replace this starter record with the relevant event, diagnosis, or procedure."}],
        "family_history": [{"relation": "Add relation", "detail": "Add family history details here."}],
        "labs": [{"date": "Add date", "name": "Lab panel", "value": "Add result", "range": "Add reference range", "status": "Pending"}],
        "medications": [{"name": "Add medication or supplement", "dose": "Dose", "schedule": "Schedule", "person": "Jason", "status": "Current"}],
        "synopsis": "This is a shared, private workspace for organizing medical records. It is not medical advice. Add a concise, clinician-friendly synopsis once the source records are uploaded.",
    }


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


def available_docs():
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    docs = []
    for path in sorted(DOCS_DIR.glob("*.pdf"), key=lambda item: item.stat().st_mtime, reverse=True):
        docs.append({"name": path.stem.replace("_", " "), "filename": path.name, "size": round(path.stat().st_size / 1024), "updated": path.stat().st_mtime})
    return docs


@app.get("/documents/<path:filename>")
def document(filename):
    guard = require_login()
    if guard:
        return guard
    safe_path = (DOCS_DIR / filename).resolve()
    if safe_path.parent != DOCS_DIR.resolve() or safe_path.suffix.lower() != ".pdf":
        abort(404)
    return send_from_directory(DOCS_DIR, safe_path.name, as_attachment=False)


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
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    uploaded.save(DOCS_DIR / filename)
    return redirect(url_for("dashboard") + "#documents")


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
