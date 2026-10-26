import tempfile
import unittest
from pathlib import Path

from app import ADMIN_PASSWORD, ADMIN_USERNAME, create_app


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "test.sqlite3"
        self.app = create_app(database_path=database_path, secret_key="test-secret")
        self.app.config.update(TESTING=True)
        self.client = self.app.test_client()
        self.base_url = "https://localhost"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def login(self, client=None, username=ADMIN_USERNAME, password=ADMIN_PASSWORD):
        return (client or self.client).post(
            "/api/login",
            base_url=self.base_url,
            json={"username": username, "password": password},
        )

    def test_public_files_are_allowlisted(self):
        public_response = self.client.get("/", base_url=self.base_url)
        self.assertEqual(public_response.status_code, 200)
        public_response.close()
        self.assertEqual(self.client.get("/app.py", base_url=self.base_url).status_code, 404)
        self.assertEqual(self.client.get("/instance/rld.sqlite3", base_url=self.base_url).status_code, 404)

    def test_login_errors_and_admin_password_change(self):
        missing_user = self.client.post(
            "/api/login", base_url=self.base_url, json={"username": "missing", "password": "anything"}
        )
        self.assertEqual(missing_user.status_code, 404)
        self.assertEqual(missing_user.json["code"], "username_not_found")

        wrong_password = self.client.post(
            "/api/login",
            base_url=self.base_url,
            json={"username": ADMIN_USERNAME, "password": "wrong"},
        )
        self.assertEqual(wrong_password.status_code, 401)
        self.assertEqual(wrong_password.json["code"], "wrong_password")

        self.assertEqual(self.login().status_code, 200)
        other_admin_session = self.app.test_client()
        self.assertEqual(self.login(other_admin_session).status_code, 200)
        changed = self.client.put(
            "/api/admin/password",
            base_url=self.base_url,
            json={"currentPassword": ADMIN_PASSWORD, "newPassword": "new-safe-password"},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(self.client.get("/api/session", base_url=self.base_url).status_code, 401)
        self.assertEqual(
            other_admin_session.get("/api/session", base_url=self.base_url).status_code,
            401,
        )
        self.assertEqual(
            self.login(password="new-safe-password").status_code,
            200,
        )

    def test_admin_manages_accounts_and_regular_users_cannot(self):
        self.assertEqual(self.login().status_code, 200)
        created = self.client.post(
            "/api/users",
            base_url=self.base_url,
            json={"username": "mechanic", "password": "mechanic-password"},
        )
        self.assertEqual(created.status_code, 201)

        user_client = self.app.test_client()
        self.assertEqual(
            self.login(user_client, "mechanic", "mechanic-password").status_code,
            200,
        )
        self.assertEqual(user_client.get("/api/users", base_url=self.base_url).status_code, 403)
        reset = self.client.put(
            "/api/users/mechanic",
            base_url=self.base_url,
            json={"password": "reset-password"},
        )
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(user_client.get("/api/session", base_url=self.base_url).status_code, 401)

    def test_estimate_sync_uses_latest_client_timestamp_and_tombstones(self):
        self.assertEqual(self.login().status_code, 200)
        estimate_id = "estimate-1"
        newest = {
            "id": estimate_id,
            "savedAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-02T00:00:00.000Z",
            "data": {"clientName": "Latest version", "works": []},
            "deleted": False,
        }
        saved = self.client.put(
            f"/api/estimates/{estimate_id}", base_url=self.base_url, json=newest
        )
        self.assertEqual(saved.status_code, 200)
        self.assertTrue(saved.json["accepted"])

        stale = {**newest, "updatedAt": "2026-01-01T12:00:00.000Z", "data": {"clientName": "Old"}}
        stale_result = self.client.put(
            f"/api/estimates/{estimate_id}", base_url=self.base_url, json=stale
        )
        self.assertFalse(stale_result.json["accepted"])
        self.assertEqual(stale_result.json["estimate"]["data"]["clientName"], "Latest version")

        deleted = {**newest, "updatedAt": "2026-01-03T00:00:00.000Z", "deleted": True}
        tombstone = self.client.put(
            f"/api/estimates/{estimate_id}", base_url=self.base_url, json=deleted
        )
        self.assertTrue(tombstone.json["estimate"]["deleted"])
        history = self.client.get("/api/estimates", base_url=self.base_url)
        self.assertTrue(history.json["estimates"][0]["deleted"])

    def test_pdf_download_requires_login_and_returns_pdf(self):
        record = {
            "id": "pdf-1",
            "data": {
                "date": "Jan 2",
                "clientName": "Client <script>",
                "works": [{"desc": "Repair", "labor": 100, "parts": 20}],
                "totLabor": 100,
                "totParts": 20,
                "downpayment": 0,
                "totDue": 120,
            },
        }
        self.assertEqual(
            self.client.get("/api/estimates/pdf-1/pdf", base_url=self.base_url).status_code,
            401,
        )
        self.assertEqual(self.login().status_code, 200)
        self.client.put(
            "/api/estimates/pdf-1",
            base_url=self.base_url,
            json={
                "id": "pdf-1",
                "updatedAt": "2026-02-01T00:00:00.000Z",
                "data": record["data"],
            },
        )
        response = self.client.get("/api/estimates/pdf-1/pdf", base_url=self.base_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertTrue(response.data.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
