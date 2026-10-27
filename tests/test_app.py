import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from openpyxl import load_workbook

from app import ADMIN_PASSWORD, ADMIN_USERNAME, create_app, resolve_data_dir


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

    def test_data_folder_can_be_configured_by_file_or_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "storage-config.json"
            configured_dir = root / "chosen-data"
            config_path.write_text(
                '{"data_dir": "' + str(configured_dir).replace("\\", "\\\\") + '"}',
                encoding="utf-8",
            )
            self.assertEqual(resolve_data_dir(config_path), configured_dir.resolve())

            environment_dir = root / "environment-data"
            with patch.dict("os.environ", {"RLD_DATA_DIR": str(environment_dir)}):
                self.assertEqual(resolve_data_dir(config_path), environment_dir.resolve())
                configured_app = create_app(database_path=None, secret_key="test-secret")
                self.assertEqual(
                    configured_app.config["DATABASE"],
                    str((environment_dir / "rld.sqlite3").resolve()),
                )
                self.assertTrue((environment_dir / "rld.sqlite3").exists())

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

    def test_authenticated_users_manage_shared_unit_price_list(self):
        self.assertEqual(
            self.client.get("/api/units", base_url=self.base_url).status_code,
            401,
        )
        self.assertEqual(self.login().status_code, 200)
        unit_data = {
            "maker": "Toyota",
            "unit": "Hilux 2.4 E",
            "transmission": "Automatic",
            "plateNo": "ABC-123",
            "yearModel": 2024,
            "fuelType": "Diesel",
            "sellingPrice": 1450000,
            "available": True,
        }
        created = self.client.post(
            "/api/units", base_url=self.base_url, json=unit_data
        )
        self.assertEqual(created.status_code, 201)
        saved = created.json["unit"]
        self.assertEqual(saved["maker"], "Toyota")
        self.assertEqual(saved["sellingPrice"], 1450000)
        self.assertTrue(saved["available"])
        self.assertEqual(
            self.client.get("/api/units", base_url=self.base_url).json["units"],
            [saved],
        )

        updated = self.client.put(
            f"/api/units/{saved['id']}",
            base_url=self.base_url,
            json={**unit_data, "unit": "Hilux 2.4 G", "available": False},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json["unit"]["unit"], "Hilux 2.4 G")
        self.assertFalse(updated.json["unit"]["available"])
        invalid = self.client.put(
            f"/api/units/{saved['id']}",
            base_url=self.base_url,
            json={**unit_data, "available": "false"},
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(
            self.client.post(
                "/api/units",
                base_url=self.base_url,
                json={**unit_data, "maker": "Unknown"},
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/api/units",
                base_url=self.base_url,
                json={**unit_data, "yearModel": 2024.5},
            ).status_code,
            400,
        )

        deleted = self.client.delete(
            f"/api/units/{saved['id']}", base_url=self.base_url
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get("/api/units", base_url=self.base_url).json["units"], [])
        self.assertEqual(
            self.client.delete(
                f"/api/units/{saved['id']}", base_url=self.base_url
            ).status_code,
            404,
        )

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

    def test_synced_estimate_is_saved_as_printable_excel(self):
        self.assertEqual(self.login().status_code, 200)
        response = self.client.put(
            "/api/estimates/excel-1",
            base_url=self.base_url,
            json={
                "id": "excel-1",
                "updatedAt": "2026-02-01T00:00:00.000Z",
                "data": {
                    "date": "2026-02-01",
                    "noteHiddenDamage": True,
                    "orgPrefix": "MGO Taal",
                    "makeModel": "Toyota Hilux",
                    "plateNo": "ABC-123",
                    "works": [
                        {"desc": "*parts", "labor": "", "parts": ""},
                        {"desc": "nut", "labor": 100, "parts": 0},
                        {"desc": "2. bolt", "labor": 200, "parts": 0},
                        {"desc": "*Tinsmith", "labor": "", "parts": ""},
                        {"desc": "side panel", "labor": 300, "parts": 0},
                        {"desc": "left panel", "labor": "", "parts": 0},
                    ],
                    "bundleLabor": True,
                    "bundleAllPrices": False,
                    "totLabor": 600,
                    "totParts": 0,
                    "downpayment": 100,
                    "totDue": 500,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["accepted"])
        estimate_dir = (
            Path(self.temporary_directory.name)
            / "estimates"
            / sha256(b"excel-1").hexdigest()
        )
        workbook_path = estimate_dir / "MGO TAAL_TOYOTA HILUX_ABC-123.xlsx"
        self.assertTrue(workbook_path.exists())
        workbook = load_workbook(workbook_path)
        sheet = workbook["Job Estimate"]
        values = [cell.value for row in sheet.iter_rows() for cell in row if cell.value]
        self.assertIn("1. NUT", values)
        self.assertEqual(sheet["A9"].value, "DATE: FEBRUARY 1, 2026")
        self.assertEqual(sheet["A23"].value, "NOTE: HIDDEN DAMAGE ARE NOT INCLUDED")
        self.assertTrue(sheet["A23"].font.bold)
        self.assertEqual(sheet["A23"].font.color.rgb, "00C00000")
        self.assertIn("2. BOLT", values)
        self.assertIn("1. SIDE PANEL", values)
        self.assertIn("*PARTS", values)
        self.assertIn("*TINSMITH", values)
        self.assertEqual(str(sheet.page_setup.paperSize), "14")
        self.assertEqual(sheet.column_dimensions["A"].width, 25)
        self.assertEqual(sheet.column_dimensions["B"].width, 25)
        self.assertEqual(sheet.column_dimensions["C"].width, 25)
        self.assertEqual(sheet.column_dimensions["D"].width, 25)
        self.assertEqual(sheet["A17"].alignment.horizontal, "left")
        self.assertEqual(sheet["C18"].alignment.horizontal, "right")
        self.assertEqual(sheet["A17"].border.left.style, "thin")
        self.assertEqual(sheet["D18"].border.right.style, "thin")
        self.assertIn("C21:C22", {str(merged) for merged in sheet.merged_cells.ranges})
        self.assertEqual(len(sheet._images), 3)
        self.assertEqual(round(sheet._images[1].anchor.ext.cy / 9525), 65)
        self.assertEqual(round(sheet._images[2].anchor.ext.cy / 9525), 65)
        self.assertEqual(
            sheet._images[1].anchor._from.colOff + sheet._images[1].anchor.ext.cx // 2,
            sheet._images[2].anchor._from.colOff + sheet._images[2].anchor.ext.cx // 2,
        )
        self.assertGreaterEqual(len(list(estimate_dir.glob("*.xlsx"))), 1)
        update = self.client.put(
            "/api/estimates/excel-1",
            base_url=self.base_url,
            json={
                "id": "excel-1",
                "updatedAt": "2026-02-02T00:00:00.000Z",
                "data": {
                    **response.json["estimate"]["data"],
                    "makeModel": "Toyota Prius",
                },
            },
        )
        self.assertEqual(update.status_code, 200)
        self.assertFalse(workbook_path.exists())
        self.assertTrue((estimate_dir / "MGO TAAL_TOYOTA PRIUS_ABC-123.xlsx").exists())
        self.assertEqual(
            self.client.get("/api/estimates/excel-1/pdf", base_url=self.base_url).status_code,
            404,
        )
        bundled = self.client.put(
            "/api/estimates/bundle-1",
            base_url=self.base_url,
            json={
                "id": "bundle-1",
                "updatedAt": "2026-02-03T00:00:00.000Z",
                "data": {
                    "works": [
                        {"desc": "first repair", "labor": 100, "parts": 20},
                        {"desc": "second repair", "labor": 200, "parts": 30},
                    ],
                    "bundleLabor": True,
                    "bundleAllPrices": True,
                },
            },
        )
        self.assertEqual(bundled.status_code, 200)
        bundled_dir = (
            Path(self.temporary_directory.name)
            / "estimates"
            / sha256(b"bundle-1").hexdigest()
        )
        bundled_workbook = load_workbook(bundled_dir / "PRIVATE_UNKNOWN VEHICLE_NO PLATE.xlsx")
        bundled_sheet = bundled_workbook["Job Estimate"]
        self.assertEqual(bundled_sheet["C17"].value, 300)
        self.assertEqual(bundled_sheet["D17"].value, 50)
        self.assertIn("C17:C18", {str(merged) for merged in bundled_sheet.merged_cells.ranges})
        self.assertIn("D17:D18", {str(merged) for merged in bundled_sheet.merged_cells.ranges})


if __name__ == "__main__":
    unittest.main()
