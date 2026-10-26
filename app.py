import json
import math
import os
import re
import secrets
import socket
import sqlite3
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from functools import wraps
from io import BytesIO
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory, session
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent
STORAGE_CONFIG_PATH = ROOT / "storage-config.json"
ADMIN_USERNAME = "rld"
ADMIN_PASSWORD = "rld2026"
SERVER_PORT = 8443
USERNAME_PATTERN = re.compile(r"^[a-z0-9._-]{3,30}$")
PUBLIC_FILES = {
    "index.html", "style.css", "script.js", "manifest.webmanifest",
    "service-worker.js", "icon.svg", "header.png", "signature1.png", "signature2.png",
}


def resolve_data_dir(config_path=STORAGE_CONFIG_PATH):
    configured_path = os.environ.get("RLD_DATA_DIR")
    if not configured_path:
        config_path = Path(config_path)
        if config_path.exists():
            try:
                configuration = json.loads(config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError(f"Could not read storage configuration at {config_path}: {error}") from error
            configured_path = configuration.get("data_dir") if isinstance(configuration, dict) else None
            if not isinstance(configured_path, str) or not configured_path.strip():
                raise RuntimeError(f"Storage configuration at {config_path} has no valid data_dir.")
    data_dir = Path(configured_path).expanduser() if configured_path else ROOT / "instance"
    return data_dir.resolve()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect_db(database_path):
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def database_connection(database_path):
    connection = connect_db(database_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db(database_path):
    Path(database_path).parent.mkdir(parents=True, exist_ok=True)
    with database_connection(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
                created_at TEXT NOT NULL,
                password_version INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        user_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(users)").fetchall()
        }
        if "password_version" not in user_columns:
            connection.execute(
                "ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 1"
            )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS estimates (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                server_updated_at TEXT NOT NULL,
                client_updated_at TEXT NOT NULL,
                username TEXT NOT NULL,
                data_json TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        admin = connection.execute(
            "SELECT username FROM users WHERE username = ?", (ADMIN_USERNAME,)
        ).fetchone()
        if admin is None:
            connection.execute(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
                (ADMIN_USERNAME, generate_password_hash(ADMIN_PASSWORD), "admin", utc_now()),
            )


def create_app(database_path=None, secret_key=None):
    data_dir = Path(database_path).parent if database_path is not None else resolve_data_dir()
    database_path = Path(database_path) if database_path is not None else data_dir / "rld.sqlite3"
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=secret_key or load_secret_key(data_dir),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
        DATABASE=str(database_path),
    )
    init_db(app.config["DATABASE"])

    def current_user():
        username = session.get("username")
        if not username:
            return None
        with database_connection(app.config["DATABASE"]) as connection:
            user = connection.execute(
                "SELECT username, role, password_version FROM users WHERE username = ?", (username,)
            ).fetchone()
        if user is None or session.get("auth_version") != user["password_version"]:
            return None
        return user

    def login_required(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            if current_user() is None:
                return jsonify(error="Please sign in to the local server again.", code="session_expired"), 401
            return handler(*args, **kwargs)
        return wrapped

    def admin_required(handler):
        @wraps(handler)
        @login_required
        def wrapped(*args, **kwargs):
            user = current_user()
            if user["role"] != "admin":
                return jsonify(error="Administrator access is required."), 403
            return handler(*args, **kwargs)
        return wrapped

    def require_same_origin():
        origin = request.headers.get("Origin")
        if not origin:
            return
        expected = request.host_url.rstrip("/")
        if origin.rstrip("/") != expected:
            abort(403, description="Requests from another website are not allowed.")

    def estimate_record(row):
        return {
            "id": row["id"],
            "savedAt": row["created_at"],
            "updatedAt": row["client_updated_at"],
            "serverUpdatedAt": row["server_updated_at"],
            "username": row["username"],
            "data": json.loads(row["data_json"]),
            "deleted": bool(row["deleted"]),
        }

    @app.get("/")
    def home():
        return send_from_directory(ROOT, "index.html")

    @app.get("/<path:filename>")
    def app_files(filename):
        if filename not in PUBLIC_FILES:
            abort(404)
        return send_from_directory(ROOT, filename)

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", serverTime=utc_now())

    @app.post("/api/login")
    def login():
        require_same_origin()
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip().lower()
        password = payload.get("password", "")
        if not isinstance(password, str) or not username:
            return jsonify(error="Enter a username and password.", code="missing_credentials"), 400
        with database_connection(app.config["DATABASE"]) as connection:
            user = connection.execute(
                "SELECT username, password_hash, role, password_version FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if user is None:
            return jsonify(error="Username not found on this local server.", code="username_not_found"), 404
        if not check_password_hash(user["password_hash"], password):
            return jsonify(error="Incorrect password for this username.", code="wrong_password"), 401
        session.clear()
        session.permanent = bool(payload.get("remember"))
        session["username"] = user["username"]
        session["auth_version"] = user["password_version"]
        return jsonify(username=user["username"], role=user["role"])

    @app.post("/api/logout")
    def logout():
        require_same_origin()
        session.clear()
        return jsonify(status="ok")

    @app.get("/api/session")
    @login_required
    def session_info():
        user = current_user()
        return jsonify(username=user["username"], role=user["role"])

    @app.put("/api/admin/password")
    @admin_required
    def change_admin_password():
        require_same_origin()
        payload = request.get_json(silent=True) or {}
        current_password = payload.get("currentPassword", "")
        new_password = payload.get("newPassword", "")
        if not isinstance(current_password, str) or not isinstance(new_password, str):
            return jsonify(error="Enter the current and new passwords."), 400
        if len(new_password) < 8:
            return jsonify(error="Passwords must be at least 8 characters."), 400
        with database_connection(app.config["DATABASE"]) as connection:
            user = connection.execute(
                "SELECT password_hash FROM users WHERE username = ?", (ADMIN_USERNAME,)
            ).fetchone()
            if (
                user is None
                or not check_password_hash(user["password_hash"], current_password)
            ):
                return jsonify(error="The current administrator password is incorrect."), 401
            connection.execute(
                "UPDATE users SET password_hash = ?, password_version = password_version + 1 WHERE username = ?",
                (generate_password_hash(new_password), ADMIN_USERNAME),
            )
        session.clear()
        return jsonify(status="updated")

    @app.get("/api/users")
    @admin_required
    def list_users():
        with database_connection(app.config["DATABASE"]) as connection:
            users = connection.execute(
                "SELECT username, role, created_at FROM users ORDER BY username COLLATE NOCASE"
            ).fetchall()
        return jsonify(users=[dict(user) for user in users])

    @app.post("/api/users")
    @admin_required
    def create_user():
        require_same_origin()
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip().lower()
        password = payload.get("password", "")
        if not USERNAME_PATTERN.fullmatch(username) or username == ADMIN_USERNAME:
            return jsonify(error="Use a unique 3-30 character username (letters, numbers, dot, underscore, hyphen)."), 400
        if not isinstance(password, str) or len(password) < 8:
            return jsonify(error="Passwords must be at least 8 characters."), 400
        try:
            with database_connection(app.config["DATABASE"]) as connection:
                connection.execute(
                    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'user', ?)",
                    (username, generate_password_hash(password), utc_now()),
                )
        except sqlite3.IntegrityError:
            return jsonify(error="That username already exists."), 409
        return jsonify(username=username, role="user"), 201

    @app.put("/api/users/<username>")
    @admin_required
    def change_user_password(username):
        require_same_origin()
        if username.lower() == ADMIN_USERNAME:
            return jsonify(error="Change the administrator password directly on the Windows server."), 400
        payload = request.get_json(silent=True) or {}
        password = payload.get("password", "")
        if not isinstance(password, str) or len(password) < 8:
            return jsonify(error="Passwords must be at least 8 characters."), 400
        with database_connection(app.config["DATABASE"]) as connection:
            result = connection.execute(
                "UPDATE users SET password_hash = ?, password_version = password_version + 1 WHERE username = ?",
                (generate_password_hash(password), username),
            )
        if result.rowcount == 0:
            return jsonify(error="That account no longer exists."), 404
        return jsonify(username=username, status="updated")

    @app.delete("/api/users/<username>")
    @admin_required
    def delete_user(username):
        require_same_origin()
        if username.lower() == ADMIN_USERNAME:
            return jsonify(error="The administrator account cannot be deleted."), 400
        with database_connection(app.config["DATABASE"]) as connection:
            result = connection.execute("DELETE FROM users WHERE username = ?", (username,))
        if result.rowcount == 0:
            return jsonify(error="That account no longer exists."), 404
        return jsonify(username=username, status="deleted")

    @app.get("/api/estimates")
    @login_required
    def list_estimates():
        with database_connection(app.config["DATABASE"]) as connection:
            rows = connection.execute(
                "SELECT * FROM estimates ORDER BY server_updated_at DESC"
            ).fetchall()
        return jsonify(estimates=[estimate_record(row) for row in rows])

    @app.put("/api/estimates/<estimate_id>")
    @login_required
    def save_estimate(estimate_id):
        require_same_origin()
        payload = request.get_json(silent=True) or {}
        data = payload.get("data")
        if not isinstance(data, dict) or payload.get("id") != estimate_id:
            return jsonify(error="Invalid estimate data."), 400
        client_updated_at = payload.get("updatedAt")
        if not isinstance(client_updated_at, str) or len(client_updated_at) > 40:
            return jsonify(error="The estimate timestamp is invalid."), 400
        try:
            parsed_updated_at = datetime.fromisoformat(client_updated_at.replace("Z", "+00:00"))
            if parsed_updated_at.tzinfo is None:
                raise ValueError("Timezone is required.")
            client_updated_at = parsed_updated_at.astimezone(timezone.utc).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z")
        except ValueError:
            return jsonify(error="The estimate timestamp is invalid."), 400
        deleted = payload.get("deleted", False)
        if not isinstance(deleted, bool):
            return jsonify(error="The estimate deletion flag is invalid."), 400
        now = utc_now()
        user = current_user()
        with database_connection(app.config["DATABASE"]) as connection:
            existing = connection.execute(
                "SELECT * FROM estimates WHERE id = ?", (estimate_id,)
            ).fetchone()
            if existing and existing["client_updated_at"] > client_updated_at:
                return jsonify(accepted=False, estimate=estimate_record(existing))
            created_at = existing["created_at"] if existing else now
            connection.execute(
                """
                INSERT INTO estimates
                    (id, created_at, server_updated_at, client_updated_at, username, data_json, deleted)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    server_updated_at = excluded.server_updated_at,
                    client_updated_at = excluded.client_updated_at,
                    username = excluded.username,
                    data_json = excluded.data_json,
                    deleted = excluded.deleted
                """,
                (
                    estimate_id, created_at, now, client_updated_at, user["username"],
                    json.dumps(data, ensure_ascii=False), int(deleted),
                ),
            )
            saved = connection.execute(
                "SELECT * FROM estimates WHERE id = ?", (estimate_id,)
            ).fetchone()
        return jsonify(accepted=True, estimate=estimate_record(saved))

    @app.get("/api/estimates/<estimate_id>/pdf")
    @login_required
    def estimate_pdf(estimate_id):
        with database_connection(app.config["DATABASE"]) as connection:
            row = connection.execute(
                "SELECT * FROM estimates WHERE id = ? AND deleted = 0", (estimate_id,)
            ).fetchone()
        if row is None:
            abort(404, description="Estimate not found.")
        record = estimate_record(row)
        pdf = make_estimate_pdf(record)
        client = secure_filename(str(record["data"].get("clientName", "Estimate"))) or estimate_id
        date = secure_filename(str(record["data"].get("date", "Estimate"))) or "Estimate"
        filename = f"{date}-{client}.pdf"
        return send_file(pdf, mimetype="application/pdf", as_attachment=True, download_name=filename)

    return app


def make_estimate_pdf(record):
    data = record["data"]
    output = BytesIO()
    document = SimpleDocTemplate(
        output, pagesize=letter, rightMargin=0.55 * inch, leftMargin=0.55 * inch,
        topMargin=0.55 * inch, bottomMargin=0.55 * inch,
    )
    styles = getSampleStyleSheet()
    story = [
        Paragraph("RLD AUTOWORX AND TOWING SERVICES", styles["Title"]),
        Paragraph("JOB ESTIMATE", styles["Heading2"]),
        Spacer(1, 10),
    ]
    fields = [
        ["Date", data.get("date", "")],
        ["Client", data.get("clientName", "")],
        ["Address", data.get("address", "")],
        ["Contact", data.get("contact", "")],
        ["Vehicle", data.get("makeModel", "")],
        ["Plate No.", data.get("plateNo", "")],
        ["Chassis No.", data.get("chassisNo", "")],
        ["Engine No.", data.get("engineNo", "")],
        ["Color", data.get("color", "")],
        ["Insurance", data.get("insurance", "")],
    ]
    details = Table(fields, colWidths=[1.4 * inch, 5.5 * inch])
    details.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([details, Spacer(1, 14)])
    works = [["Scope of Works", "Labor", "Parts"]]
    for item in data.get("works", []) if isinstance(data.get("works", []), list) else []:
        if not isinstance(item, dict):
            continue
        works.append([item.get("desc", ""), item.get("labor", ""), item.get("parts", "")])
    work_table = Table(works, colWidths=[4.2 * inch, 1.35 * inch, 1.35 * inch], repeatRows=1)
    work_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d9edf7")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    def amount(value):
        try:
            number = float(value or 0)
        except (TypeError, ValueError):
            return 0
        return number if math.isfinite(number) else 0

    story.extend([
        work_table, Spacer(1, 14),
        Paragraph(f"Total Labor: PHP {amount(data.get('totLabor')):,.2f}", styles["Normal"]),
        Paragraph(f"Total Parts: PHP {amount(data.get('totParts')):,.2f}", styles["Normal"]),
        Paragraph(f"Downpayment: PHP {amount(data.get('downpayment')):,.2f}", styles["Normal"]),
        Paragraph(f"Total Amount Due: PHP {amount(data.get('totDue')):,.2f}", styles["Heading3"]),
    ])
    document.build(story)
    output.seek(0)
    return output


def load_secret_key(data_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    key_path = data_dir / "session-secret.key"
    if key_path.exists():
        return key_path.read_text(encoding="ascii").strip()
    secret = secrets.token_hex(32)
    key_path.write_text(secret, encoding="ascii")
    return secret


def local_ipv4():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 1))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


if __name__ == "__main__":
    from cert_setup import ensure_certificates

    data_dir = resolve_data_dir()
    lan_ip = local_ipv4()
    cert_path, key_path, ca_path = ensure_certificates(data_dir / "certs", lan_ip)
    app = create_app()
    print(f"RLD local server: https://{lan_ip}:{SERVER_PORT}")
    print(f"Install this CA certificate on phones: {ca_path}")
    print(f"Estimate database and server keys are stored in: {data_dir}")
    print("Keep this data folder private. Press Ctrl+C to stop.")
    app.run(host="0.0.0.0", port=SERVER_PORT, ssl_context=(str(cert_path), str(key_path)), threaded=True)
