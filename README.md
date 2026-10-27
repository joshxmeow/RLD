# RLD AutoDesk Local Estimate Server

The Windows computer runs the Flask/SQLite server. Phones use the installable website, keep estimates on-device while offline, and send changes to the server when the app is open and the server is reachable again on the same Wi-Fi. The shared unit price list is grouped by maker and can be searched and edited while connected; it includes color details and expands AT/MT to Automatic/Manual. The home-page light/dark theme preference is saved on each device. The `rld_logo.png` image is used for the login branding and installed app icon.

## First-time setup on the Windows server PC

The PC that runs this server is where the shared estimate database and accounts are stored. It can be a different PC from the one you use to browse or edit the website. It must stay powered on and connected to the same Wi-Fi as the phones when they need to sync.

1. On the PC that should hold the shared data, install Python 3.11 or newer and make sure `python` works in Command Prompt or PowerShell.
2. Copy this whole project folder to that PC. Keep the folder together; it contains the server program and website.
3. In the router, reserve a fixed LAN IP address for this server PC. Do this before installing the app on phones; the certificate and saved PWA address use that IP.
4. Double-click `start_server.bat`. On first run it creates `.venv`, installs the packages, and opens a folder picker. Choose the folder on this PC where the database, Excel estimates, and private server keys should live, for example `D:\RLD Autoworx Data`. The chosen folder is created/used when the server starts.
5. Allow Python through Windows Defender Firewall on **Private networks** when prompted. If no prompt appears, add a private-network inbound TCP rule for port **8443** in Windows Defender Firewall with Advanced Security.
6. Open `https://<reserved-lan-ip>:8443` from another device on the same Wi-Fi to confirm the server works. Stop the server with Ctrl+C, then double-click `install_autostart.bat`. This creates a Windows Task Scheduler task for the current account; the server starts in the background when that account signs in. Double-click `remove_autostart.bat` to prevent future automatic starts. Keep the server PC awake and signed in whenever phones need to sync.

The startup task runs only after the configured Windows account signs in; it does not start before the Windows sign-in screen. Server output is appended to `server.log` in the project folder. Removing the startup task does not stop a server that is already running. Do not start `start_server.bat` manually while the background task is already running.

For future code updates, run `make_update_package.bat` in the project folder. Copy `RLD-Update-Package.zip` to the server PC, extract it, and double-click the included `update_server.bat`. Select the existing project folder when prompted. The updater stops that project's server process, replaces only application files, preserves `.venv`, `storage-config.json`, and the separate data folder, updates dependencies, refreshes the logon startup task, and starts the server hidden. Keep backups before updating; never delete the existing project or data folder as part of an update.

To choose a different folder later, stop the server with Ctrl+C, double-click `configure_storage.bat` on the server PC, select the new folder, then start `start_server.bat` again. Changing the folder does **not** move existing data: the old folder is left intact, and the new folder starts with a new database unless you copy the old data files while the server is stopped. For a normal change of location, stop the server and copy `rld.sqlite3`, `session-secret.key`, the `estimates` folder, and the entire `certs` folder into the new folder before restarting. Keep a separate backup.

The selected folder is used for `rld.sqlite3`, `session-secret.key`, and `certs\`. Keep it private. Prefer a local drive in the server PC rather than a network share, USB drive, or cloud-synced folder; SQLite can be damaged if those locations disconnect or conflict. Use a separate backup process to copy the database when the server is stopped.

Advanced users can set the `RLD_DATA_DIR` environment variable on the server PC to override the folder-picker setting. The override is only used by the process that inherits that environment variable.

The first administrator account is `rld` with the initial password `rld2026`. Sign in while connected to the server and immediately change it in **Manage accounts → Change admin password**. Create each other user's account there; public sign-up is disabled.

## Install on Android and iPhone

The generated CA certificate is printed in the server window and stored at `<chosen-data-folder>\certs\local-ca.crt`. Transfer **only the `.crt` certificate** to each phone using a trusted method. Never copy or share `local-ca-key.pem` or `server-key.pem`.

- **Android:** install the CA certificate from the phone's Security / Encryption & credentials settings (the wording varies by Android version). Open the HTTPS server address in Chrome, then choose **Install app** or **Add to Home screen**.
- **iPhone:** open the certificate on the phone, install its configuration profile in Settings, then enable full trust for the RLD local CA under **Settings → General → About → Certificate Trust Settings**. Open the HTTPS address in Safari and choose **Share → Add to Home Screen**.
- To print from a phone, tap **Print Document** in the estimate to open the phone's native print dialog directly from the app. Choose a paper size supported by the printer and enable **Fit to page** if that option is available.
- To save an estimate as a PNG, tap **Save as image**. On phones, use the share sheet to choose Photos or Gallery if available; otherwise the image downloads to Files/Downloads so it can be saved to the gallery manually.

Only trust this private CA on devices you control. The browser should show a secure connection before the PWA is installed. The same HTTPS address must be used every time; changing the server's reserved IP means reinstalling/trusting the new certificate and adding the new address to the home screen.

Updating the app files does not normally change the server certificate, so phones that already trust the RLD CA do not need to reinstall it. After updating the server, open the installed app while connected to the server's Wi-Fi and reload it once so the browser can install the new service worker and app files. The update may not appear while the app remains closed or offline. Reinstall/retrust the CA only if the CA certificate or server address changes.

## Offline use and sync behavior

- A phone must first open the app and sign in successfully while connected to the server. The app shell, account verifier, and estimates are then stored on that device. Do not clear the browser/PWA's site data if unsynced estimates need to be preserved.
- Estimates save to the device immediately. While online, changes sync automatically on reconnect, app resume, or while the app remains open. The history shows whether each item is synced, syncing, or still waiting.
- The unit price list is shared through the server and requires a connection to view or change. Add or edit unit details in **Unit prices**, search across the list, and swipe a unit card from left to right (or tap its availability badge) to toggle availability.
- The bundled Units Price List is imported once during the update. A vehicle without a listed selling price remains in the list with “Price not listed”; add its price when known.
- On the estimate form, select **Add a red note** to include “NOTE: HIDDEN DAMAGE ARE NOT INCLUDED” below the scope of works and above the totals in print, image exports, and Excel estimates.
- Saving an estimate clears the entry form. Use **Clear entry** to discard the current form, and search estimate history by organization, vehicle, plate, date, or user.
- Choose the estimate date with the phone or computer's native calendar picker. The estimate displays and prints the date as `MONTH DAY, YEAR`; if left blank, the current local date is used. Previously saved organization/government names, vehicle make/models, job keywords, and insurers on that device are automatically suggested as you fill in those fields.
- iOS may suspend a closed PWA, so it cannot reliably sync in the background while closed. Reopen the app or bring it to the foreground after reconnecting to Wi-Fi.
- Sync uses latest-edit-wins timestamps. Keep device clocks reasonably accurate; if two offline devices edit the same estimate, the edit with the later timestamp replaces the earlier one when they sync.
- Every accepted sync of a non-deleted estimate creates or updates an Excel workbook on the server, formatted to print on Folio paper (8.5 x 13 inches) with the estimate details, work items, totals, signatures, and terms. The workbook is named `ORGANIZATION_MAKE AND MODEL_PLATE NO.xlsx` (all uppercase) and stored below `<chosen-data-folder>\estimates\`. Each estimate has its own subfolder, so estimates with matching details do not overwrite one another. The app no longer has a PDF download button. Printing from the estimate form remains available offline.
- Offline account verification uses a salted, slow password hash in browser storage; it is not encryption. Estimates are not encrypted on the phone. Use a device passcode and avoid shared devices. Password changes invalidate server sessions; a device using its offline cache must reconnect and sign in to sync again.

## Data and backups

Shared accounts, server-side estimates, Excel workbooks, and certificate/session secrets are in the chosen data folder. Back up `<chosen-data-folder>\rld.sqlite3` and `<chosen-data-folder>\estimates\` regularly to protected storage. Keep the `certs` folder private as it contains the CA private key and server key; losing it requires re-trusting a newly generated CA on every phone.

The server is intended for a trusted private Wi-Fi network. Do not expose port 8443 to the public internet.
