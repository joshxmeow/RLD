// script.js
const OFFLINE_USERS_KEY = "rld.offlineUsers.v1";
const ACTIVE_USER_KEY = "rld.activeUser";
const REMEMBERED_USER_KEY = "rld.rememberedUser";
const REMEMBERED_CREDENTIAL_KEY = "rld.rememberedCredential";
const ESTIMATES_KEY = "rld.estimates.v1";
const THEME_KEY = "rld.theme";
const ADMIN_USERNAME = "rld";
const UNIT_MAKERS = ["Toyota", "Honda", "Isuzu", "Mitsubishi", "Hyundai", "Ford", "Volkswagen", "Nissan"];
let editingEstimateId = null;
let editingUnitId = null;
let units = [];
let unitSwipeStart = null;
let syncQueueRunning = false;
let serverAuthenticated = false;
let serverReachable = false;
let installPromptEvent = null;

function apiUrl(path) {
    return new URL(path.replace(/^\/+/, ""), document.baseURI);
}

function applyTheme(isLight) {
    document.documentElement.dataset.theme = isLight ? "light" : "dark";
    document.getElementById("themeToggle").checked = isLight;
    document.querySelector('meta[name="theme-color"]').content = isLight ? "#f4f7fb" : "#0b0f19";
}

applyTheme(localStorage.getItem(THEME_KEY) === "light");
document.getElementById("themeToggle").addEventListener("change", event => {
    const isLight = event.currentTarget.checked;
    localStorage.setItem(THEME_KEY, isLight ? "light" : "dark");
    applyTheme(isLight);
});

const authShell = document.getElementById("authShell");
const appContainer = document.getElementById("appContainer");
const authMessage = document.getElementById("authMessage");

function setAuthMessage(message) {
    authMessage.textContent = message;
}

function getRememberCheckbox() {
    return document.getElementById("rememberMe") || document.getElementById("rememberUsername");
}

async function hashPassword(password, salt) {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error("Password protection is unavailable in this browser. Open this page in a supported browser.");
    }
    const key = await window.crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const saltBytes = Uint8Array.from(salt.match(/.{2}/g), byte => parseInt(byte, 16));
    const digest = await window.crypto.subtle.deriveBits({
        name: "PBKDF2",
        salt: saltBytes,
        iterations: 310000,
        hash: "SHA-256"
    }, key, 256);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function createOfflineCredential(password) {
    const salt = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
        byte => byte.toString(16).padStart(2, "0")).join("");
    return { salt, passwordHash: await hashPassword(password, salt) };
}

async function verifyOfflinePassword(password, user) {
    if (user.salt) return await hashPassword(password, user.salt) === user.passwordHash;
    const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    const legacyHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return legacyHash === user.passwordHash;
}

async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(apiUrl(path), {
            credentials: "same-origin",
            ...options,
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...options.headers
            },
            signal: controller.signal
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result.error || `Server returned ${response.status}.`);
            error.status = response.status;
            error.code = result.code;
            throw error;
        }
        return result;
    } finally {
        window.clearTimeout(timeout);
    }
}

function readOfflineUsers() {
    const saved = localStorage.getItem(OFFLINE_USERS_KEY);
    return saved ? JSON.parse(saved) : {};
}

function rememberOfflineUser(username, credential, role) {
    const users = readOfflineUsers();
    users[username] = { ...credential, role };
    localStorage.setItem(OFFLINE_USERS_KEY, JSON.stringify(users));
}

function getOfflineUser(username) {
    const users = readOfflineUsers();
    if (users[username]) return users[username];
    const legacyUsers = JSON.parse(localStorage.getItem("rld.users.v1") || "[]");
    const legacyUser = Array.isArray(legacyUsers)
        ? legacyUsers.find(user => user.username === username && user.status === "approved")
        : null;
    return legacyUser ? { passwordHash: legacyUser.passwordHash, role: "user" } : null;
}

function showApp(username) {
    authShell.hidden = true;
    appContainer.hidden = false;
    document.getElementById("activeUsername").textContent = username;
    const isAdmin = username === ADMIN_USERNAME;
    document.getElementById("showAdminPage").hidden = !isAdmin;
    showPage("estimate");
    updateConnectionStatus();
    checkServerSession();
}

function showPage(page) {
    const isAdmin = sessionStorage.getItem(ACTIVE_USER_KEY) === ADMIN_USERNAME;
    const showAdmin = page === "admin" && isAdmin;
    const showHistory = page === "history";
    const showUnits = page === "units";
    const activePage = showAdmin ? "admin" : showHistory ? "history" : showUnits ? "units" : "estimate";
    document.getElementById("estimatePage").hidden = showAdmin || showHistory || showUnits;
    document.getElementById("unitsPage").hidden = !showUnits;
    document.getElementById("adminPage").hidden = !showAdmin;
    document.getElementById("historyPage").hidden = !showHistory;
    const navigationPages = {
        estimate: ["showEstimatePage", "estimatePage"],
        units: ["showUnitsPage", "unitsPage"],
        history: ["showHistoryPage", "historyPage"],
        admin: ["showAdminPage", "adminPage"]
    };
    Object.entries(navigationPages).forEach(([pageName, [buttonId, panelId]]) => {
        const button = document.getElementById(buttonId);
        const panel = document.getElementById(panelId);
        const active = pageName === activePage;
        button.classList.toggle("active-page", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
        if (active) {
            panel.classList.remove("page-enter");
            void panel.offsetWidth;
            panel.classList.add("page-enter");
        }
    });
    if (showAdmin) renderAccounts();
    if (showHistory) loadHistory();
    if (showUnits) loadUnits();
}

function readEstimates() {
    const saved = localStorage.getItem(ESTIMATES_KEY);
    if (saved === null) return [];
    const estimates = JSON.parse(saved);
    if (!Array.isArray(estimates)) throw new Error("Saved estimate data is invalid.");
    let migrated = false;
    estimates.forEach((estimate, index) => {
        if (!estimate.id) {
            estimate.id = `${estimate.savedAt || Date.now()}-${index}`;
            estimate.syncStatus = "pending";
            migrated = true;
        }
        if (!estimate.updatedAt) {
            estimate.updatedAt = estimate.savedAt || new Date().toISOString();
            migrated = true;
        }
    });
    if (migrated) writeEstimates(estimates);
    return estimates;
}

function writeEstimates(estimates) {
    localStorage.setItem(ESTIMATES_KEY, JSON.stringify(estimates));
}

function refreshEstimateSuggestions() {
    const suggestions = {
        orgPrefix: "organizationSuggestions",
        makeModel: "vehicleSuggestions",
        fileSuffix: "jobKeywordSuggestions",
        insurance: "insuranceSuggestions"
    };
    const estimates = readEstimates()
        .filter(estimate => !estimate.deleted)
        .sort((a, b) => new Date(b.updatedAt || b.savedAt) - new Date(a.updatedAt || a.savedAt));
    Object.entries(suggestions).forEach(([field, listId]) => {
        const values = new Map();
        estimates.forEach(estimate => {
            const value = String(estimate.data && estimate.data[field] || "").trim();
            const key = value.toLocaleLowerCase();
            if (value && !values.has(key)) values.set(key, value);
        });
        const list = document.getElementById(listId);
        list.replaceChildren(...Array.from(values.values(), value => {
            const option = document.createElement("option");
            option.value = value;
            return option;
        }));
    });
}

function showLogin() {
    authShell.hidden = false;
    appContainer.hidden = true;
    sessionStorage.removeItem(ACTIVE_USER_KEY);
    serverAuthenticated = false;
    serverReachable = false;
    setAuthMessage("");
}

async function renderAccounts() {
    const list = document.getElementById("accountList");
    list.replaceChildren();
    if (!serverAuthenticated || !navigator.onLine) {
        list.textContent = "Connect to the Windows server and sign in again to manage shared accounts.";
        return;
    }
    try {
        const result = await apiRequest("/api/users");
        const users = result.users.filter(user => user.username !== ADMIN_USERNAME);
        if (users.length === 0) {
            list.textContent = "No user accounts yet.";
            return;
        }
        users.forEach(user => {
            const row = document.createElement("form");
            row.className = "account-row";
            const name = document.createElement("strong");
            name.textContent = user.username;
            const status = document.createElement("span");
            status.className = "account-status";
            status.textContent = "Active";
            const password = document.createElement("input");
            password.type = "password";
            password.autocomplete = "new-password";
            password.autocapitalize = "none";
            password.spellcheck = false;
            password.minLength = 8;
            password.placeholder = "New password (8+ characters)";
            password.setAttribute("aria-label", `New password for ${user.username}`);
            password.required = true;
            const update = document.createElement("button");
            update.type = "submit";
            update.className = "request-button approve-button";
            update.textContent = "Set password";
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "request-button reject-button";
            remove.textContent = "Delete";
            row.append(name, status, password, update, remove);
            row.addEventListener("submit", event => {
                event.preventDefault();
                updateUserPassword(user.username, password.value);
            });
            remove.addEventListener("click", () => deleteUser(user.username));
            list.appendChild(row);
        });
    } catch (error) {
        list.textContent = `Could not load server accounts: ${error.message}`;
    }
}

function isAdminSession() {
    return sessionStorage.getItem(ACTIVE_USER_KEY) === ADMIN_USERNAME;
}

async function updateUserPassword(username, password) {
    if (!isAdminSession()) return;
    if (password.length < 8) {
        document.getElementById("adminMessage").textContent = "Passwords must be at least 8 characters.";
        return;
    }
    try {
        await apiRequest(`/api/users/${encodeURIComponent(username)}`, {
            method: "PUT",
            body: JSON.stringify({ password })
        });
        rememberOfflineUser(username, await createOfflineCredential(password), "user");
        document.getElementById("adminMessage").textContent = `${username}'s password was updated.`;
        renderAccounts();
    } catch (error) {
        document.getElementById("adminMessage").textContent = `Could not update the password: ${error.message}`;
    }
}

function deleteUser(username) {
    if (!isAdminSession()) return;
    if (!window.confirm(`Delete the account "${username}"? This cannot be undone.`)) return;
    if (!serverAuthenticated || !navigator.onLine) {
        document.getElementById("adminMessage").textContent = "Connect to the Windows server to delete shared accounts.";
        return;
    }
    apiRequest(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" }).then(() => {
        const offlineUsers = readOfflineUsers();
        delete offlineUsers[username];
        localStorage.setItem(OFFLINE_USERS_KEY, JSON.stringify(offlineUsers));
        document.getElementById("adminMessage").textContent = `${username}'s account was deleted.`;
        renderAccounts();
    }).catch(error => {
        document.getElementById("adminMessage").textContent = `Could not delete the account: ${error.message}`;
    });
}

document.getElementById("showEstimatePage").addEventListener("click", () => showPage("estimate"));
document.getElementById("showUnitsPage").addEventListener("click", () => showPage("units"));
document.getElementById("showHistoryPage").addEventListener("click", () => showPage("history"));
document.getElementById("showAdminPage").addEventListener("click", () => showPage("admin"));

document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("loginUsername").value.trim().toLowerCase();
    const password = document.getElementById("loginPassword").value;
    const rememberCheckbox = getRememberCheckbox();
    const remember = Boolean(rememberCheckbox && rememberCheckbox.checked);
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setAuthMessage("Checking sign-in details...");
    try {
        let signedInUsername = username;
        let role;
        let offlineCredential;
        let onlineError;
        try {
            const result = await apiRequest("/api/login", {
                method: "POST",
                body: JSON.stringify({ username, password, remember })
            });
            signedInUsername = result.username;
            role = result.role;
            serverAuthenticated = true;
            serverReachable = true;
            offlineCredential = await createOfflineCredential(password);
            rememberOfflineUser(signedInUsername, offlineCredential, role);
        } catch (error) {
            if (error.status) throw error;
            onlineError = error;
            const localUser = getOfflineUser(username);
            if (!localUser) {
                throw new Error(`The local server could not be reached and this device has no offline account for "${username}". Connect to the server and sign in once first.`);
            }
            if (!await verifyOfflinePassword(password, localUser)) {
                throw new Error(`Incorrect password for ${username} (offline account).`);
            }
            role = localUser.role || "user";
            serverAuthenticated = false;
            serverReachable = false;
            offlineCredential = await createOfflineCredential(password);
            rememberOfflineUser(username, offlineCredential, role);
        }
        sessionStorage.setItem(ACTIVE_USER_KEY, signedInUsername);
        if (remember) {
            localStorage.setItem(REMEMBERED_USER_KEY, signedInUsername);
            localStorage.setItem(REMEMBERED_CREDENTIAL_KEY, JSON.stringify({
                username: signedInUsername,
                ...offlineCredential
            }));
        } else {
            localStorage.removeItem(REMEMBERED_USER_KEY);
            localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
        }
        document.getElementById("loginPassword").value = "";
        showApp(signedInUsername);
        if (onlineError) {
            document.getElementById("historyMessage").textContent =
                "Signed in offline. Changes are saved on this device and will sync when the Windows server is reachable.";
        }
    } catch (error) {
        const message = error.code === "username_not_found"
            ? "Username not found on the local server."
            : error.code === "wrong_password"
                ? "Incorrect password for this username."
                : error.message;
        setAuthMessage(message);
    } finally {
        submitButton.disabled = false;
    }
});

document.getElementById("createUserForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdminSession()) return;
    const username = document.getElementById("newUsername").value.trim().toLowerCase();
    const password = document.getElementById("newUserPassword").value;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        document.getElementById("adminMessage").textContent = "Use 3-30 characters: lowercase letters, numbers, dots, underscores, or hyphens.";
        return;
    }
    if (username === ADMIN_USERNAME) {
        document.getElementById("adminMessage").textContent = "That username is reserved.";
        return;
    }
    if (password.length < 8) {
        document.getElementById("adminMessage").textContent = "Passwords must be at least 8 characters.";
        return;
    }
    if (!serverAuthenticated || !navigator.onLine) {
        document.getElementById("adminMessage").textContent = "Connect to the Windows server to create shared accounts.";
        return;
    }
    try {
        await apiRequest("/api/users", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });
        rememberOfflineUser(username, await createOfflineCredential(password), "user");
        document.getElementById("createUserForm").reset();
        document.getElementById("adminMessage").textContent = `${username}'s account was created.`;
        renderAccounts();
    } catch (error) {
        document.getElementById("adminMessage").textContent = `Could not create the account: ${error.message}`;
    }
});

document.getElementById("adminPasswordForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdminSession()) return;
    if (!serverAuthenticated) {
        document.getElementById("adminPasswordMessage").textContent =
            "Connect to the Windows server and sign in again to change the administrator password.";
        return;
    }
    const form = event.currentTarget;
    const currentPassword = document.getElementById("currentAdminPassword").value;
    const newPassword = document.getElementById("newAdminPassword").value;
    const message = document.getElementById("adminPasswordMessage");
    try {
        await apiRequest("/api/admin/password", {
            method: "PUT",
            body: JSON.stringify({ currentPassword, newPassword })
        });
        form.reset();
        const cachedUsers = readOfflineUsers();
        delete cachedUsers[ADMIN_USERNAME];
        localStorage.setItem(OFFLINE_USERS_KEY, JSON.stringify(cachedUsers));
        localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
        localStorage.removeItem(REMEMBERED_USER_KEY);
        showLogin();
        setAuthMessage("Administrator password changed. Sign in again with the new password.");
    } catch (error) {
        message.textContent = `Could not change administrator password: ${error.message}`;
    }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
    let logoutError;
    if (navigator.onLine && serverAuthenticated) {
        try {
            await apiRequest("/api/logout", { method: "POST", body: "{}" });
        } catch (error) {
            logoutError = error;
        }
    }
    localStorage.removeItem(REMEMBERED_USER_KEY);
    localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
    showLogin();
    if (logoutError) {
        setAuthMessage(`Signed out on this device, but the server session could not be cleared: ${logoutError.message}`);
    }
});

function updateConnectionStatus() {
    const indicator = document.getElementById("connectionStatus");
    const message = !navigator.onLine
        ? "Server: Offline — saved on this device"
        : serverReachable
            ? serverAuthenticated
                ? syncQueueRunning ? "Server: Connected and syncing" : "Server: Connected"
                : "Server: Available — sign in again to sync"
            : "Server: Unavailable — saved on this device";
    indicator.textContent = message;
    indicator.classList.toggle("online", serverReachable && serverAuthenticated);
    indicator.classList.toggle("offline", !serverReachable || !serverAuthenticated);
}

function updateHistoryStatus(estimateId, status, details = {}) {
    const estimates = readEstimates();
    const estimate = estimates.find(item => item.id === estimateId);
    if (!estimate) return;
    estimate.syncStatus = status;
    Object.assign(estimate, details);
    writeEstimates(estimates);
    if (!document.getElementById("historyPage").hidden) renderHistory();
}

async function checkServerSession() {
    if (!navigator.onLine || !sessionStorage.getItem(ACTIVE_USER_KEY)) {
        serverReachable = false;
        serverAuthenticated = false;
        updateConnectionStatus();
        return;
    }
    try {
        await apiRequest("/api/health");
        serverReachable = true;
        try {
            const session = await apiRequest("/api/session");
            serverAuthenticated = session.username === sessionStorage.getItem(ACTIVE_USER_KEY);
            if (serverAuthenticated) await syncPendingEstimates();
        } catch (error) {
            if (error.status === 401) {
                serverAuthenticated = false;
            } else {
                throw error;
            }
        }
    } catch (error) {
        serverReachable = false;
        serverAuthenticated = false;
        if (error.name !== "AbortError" && document.getElementById("historyPage") &&
            !document.getElementById("historyPage").hidden) {
            document.getElementById("historyMessage").textContent =
                `Could not contact the Windows server: ${error.message}. Local changes remain saved on this device.`;
        }
    }
    updateConnectionStatus();
    if (!document.getElementById("historyPage").hidden) renderHistory();
}

async function syncPendingEstimates() {
    if (syncQueueRunning || !navigator.onLine || !serverAuthenticated) {
        updateConnectionStatus();
        return;
    }
    syncQueueRunning = true;
    try {
        let localEstimates = readEstimates();
        const result = await apiRequest("/api/estimates");
        const remoteById = new Map(result.estimates.map(estimate => [estimate.id, estimate]));
        const localById = new Map(localEstimates.map(estimate => [estimate.id, estimate]));

        result.estimates.forEach(remote => {
            const local = localById.get(remote.id);
            if (!local) {
                localEstimates.push({ ...remote, syncStatus: "synced" });
                return;
            }
            const localTime = Date.parse(local.updatedAt || local.savedAt || 0);
            const remoteTime = Date.parse(remote.updatedAt || remote.savedAt || 0);
            if (local.syncStatus === "synced" || remoteTime > localTime) {
                Object.assign(local, remote, { syncStatus: "synced" });
            }
        });

        for (const local of localEstimates) {
            const remote = remoteById.get(local.id);
            if (local.syncStatus === "synced" && remote) continue;
            if (local.syncStatus === "error" && !local.deleted) continue;
            local.syncStatus = "syncing";
            writeEstimates(localEstimates);
            try {
                const saved = await apiRequest(`/api/estimates/${encodeURIComponent(local.id)}`, {
                    method: "PUT",
                    body: JSON.stringify(local)
                });
                const index = localEstimates.findIndex(item => item.id === local.id);
                localEstimates[index] = { ...saved.estimate, syncStatus: "synced" };
            } catch (error) {
                local.syncStatus = error.status === 401 || !error.status ? "offline" : "error";
                local.syncError = error.message;
                if (error.status === 401) {
                    serverAuthenticated = false;
                    break;
                }
                if (!error.status) {
                    serverReachable = false;
                    break;
                }
            }
        }
        writeEstimates(localEstimates);
        if (!document.getElementById("historyPage").hidden) renderHistory();
    } catch (error) {
        if (error.status === 401) serverAuthenticated = false;
        if (!error.status) serverReachable = false;
        document.getElementById("historyMessage").textContent =
            `Sync failed: ${error.message}. Local changes remain saved on this device.`;
    } finally {
        syncQueueRunning = false;
        updateConnectionStatus();
    }
}

function getHistoryTitle(estimate) {
    const data = estimate.data || {};
    const organization = estimateFilenameComponent(data.orgPrefix, "PRIVATE");
    const makeModel = estimateFilenameComponent(data.makeModel, "UNKNOWN VEHICLE");
    const plateNumber = estimateFilenameComponent(data.plateNo, "NO PLATE");
    return `${organization}_${makeModel}_${plateNumber}.xlsx`;
}

function estimateFilenameComponent(value, fallback) {
    let component = String(value || "").trim().toUpperCase()
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
        .replace(/[ .]+$/g, "")
        .slice(0, 80)
        .replace(/[ .]+$/g, "");
    const reservedNames = new Set([
        "CON", "PRN", "AUX", "NUL",
        ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
    ]);
    if (!component) component = fallback;
    if (reservedNames.has(component.split(".", 1)[0])) component = `_${component}`;
    return component;
}

function getStatusLabel(estimate) {
    switch (estimate.syncStatus) {
        case "synced": return ["Synced to server", "synced"];
        case "syncing": return ["Syncing...", "syncing"];
        case "offline":
        case "offline-delete":
            if (!navigator.onLine) return ["Not yet synced — offline", "offline"];
            if (serverReachable && !serverAuthenticated) return ["Not synced — sign in again", "offline"];
            return ["Not yet synced — server unavailable", "offline"];
        case "deleting": return ["Syncing deletion...", "syncing"];
        case "error": return [estimate.deleted ? "Delete failed" : "Sync failed", "error"];
        default:
            if (!navigator.onLine) return ["Not yet synced — offline", "offline"];
            if (serverReachable && !serverAuthenticated) return ["Not synced — sign in again", "offline"];
            if (!serverReachable) return ["Not yet synced — server unavailable", "offline"];
            return ["Not yet synced", "offline"];
    }
}

function formatUnitPrice(price) {
    return `PHP ${Number(price).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderUnits() {
    const list = document.getElementById("unitList");
    const searchTerm = document.getElementById("unitSearch").value.trim().toLocaleLowerCase();
    list.replaceChildren();
    const matchingUnits = units.filter(unit => {
        const searchText = [
            unit.maker, unit.unit, unit.transmission, unit.plateNo,
            unit.yearModel, unit.fuelType, unit.sellingPrice
        ].join(" ").toLocaleLowerCase();
        return searchText.includes(searchTerm);
    });
    if (matchingUnits.length === 0) {
        list.textContent = searchTerm ? "No units match your search." : "No units have been added yet.";
        return;
    }

    UNIT_MAKERS.forEach(maker => {
        const makerUnits = matchingUnits.filter(unit => unit.maker === maker);
        if (makerUnits.length === 0) return;
        const section = document.createElement("section");
        section.className = "unit-maker-section";
        const heading = document.createElement("h2");
        heading.textContent = maker;
        section.appendChild(heading);

        makerUnits.forEach(unit => {
            const card = document.createElement("article");
            card.className = "unit-card";
            card.dataset.unitId = unit.id;
            const titleRow = document.createElement("div");
            titleRow.className = "unit-card-heading";
            const title = document.createElement("h3");
            title.textContent = unit.unit;
            titleRow.appendChild(title);
            const status = document.createElement("button");
            status.type = "button";
            status.className = `unit-availability ${unit.available ? "available" : "unavailable"}`;
            status.textContent = unit.available ? "Available" : "Unavailable";
            status.setAttribute("aria-label", `${status.textContent}. Toggle availability for ${unit.unit}`);
            status.addEventListener("click", () => toggleUnitAvailability(unit));
            titleRow.appendChild(status);

            const details = document.createElement("dl");
            details.className = "unit-details";
            [
                ["Transmission", unit.transmission],
                ["Plate no.", unit.plateNo],
                ["Year model", unit.yearModel],
                ["Fuel type", unit.fuelType]
            ].forEach(([label, value]) => {
                const item = document.createElement("div");
                const term = document.createElement("dt");
                term.textContent = label;
                const description = document.createElement("dd");
                description.textContent = value;
                item.append(term, description);
                details.appendChild(item);
            });
            const footer = document.createElement("div");
            footer.className = "unit-card-footer";
            const price = document.createElement("strong");
            price.className = "unit-price";
            price.textContent = formatUnitPrice(unit.sellingPrice);
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "request-button";
            edit.textContent = "Edit";
            edit.addEventListener("click", () => beginUnitEdit(unit));
            footer.append(price, edit);
            card.append(titleRow, details, footer);
            section.appendChild(card);
        });
        list.appendChild(section);
    });
}

async function loadUnits() {
    const message = document.getElementById("unitsMessage");
    try {
        const result = await apiRequest("/api/units");
        units = result.units;
        message.textContent = "";
        renderUnits();
    } catch (error) {
        units = [];
        message.textContent = `Could not load the unit price list: ${error.message}`;
        if (error.status === 401) serverAuthenticated = false;
        renderUnits();
    }
}

function beginUnitEdit(unit = null) {
    const form = document.getElementById("unitForm");
    editingUnitId = unit ? unit.id : null;
    document.getElementById("unitFormTitle").textContent = unit ? `Edit ${unit.unit}` : "Add unit";
    document.getElementById("unitMaker").value = unit ? unit.maker : UNIT_MAKERS[0];
    document.getElementById("unitName").value = unit ? unit.unit : "";
    document.getElementById("unitTransmission").value = unit ? unit.transmission : "";
    document.getElementById("unitPlateNo").value = unit ? unit.plateNo : "";
    document.getElementById("unitYearModel").value = unit ? unit.yearModel : "";
    document.getElementById("unitFuelType").value = unit ? unit.fuelType : "";
    document.getElementById("unitSellingPrice").value = unit ? unit.sellingPrice : "";
    document.getElementById("unitAvailability").value = String(unit ? unit.available : true);
    document.getElementById("deleteUnitBtn").hidden = !unit;
    document.getElementById("unitForm").querySelector('[type="submit"]').textContent =
        unit ? "Save changes" : "Save unit";
    form.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("unitName").focus({ preventScroll: true });
}

function closeUnitEditor() {
    document.getElementById("unitForm").hidden = true;
    editingUnitId = null;
}

function unitFormData() {
    return {
        maker: document.getElementById("unitMaker").value,
        unit: document.getElementById("unitName").value.trim(),
        transmission: document.getElementById("unitTransmission").value.trim(),
        plateNo: document.getElementById("unitPlateNo").value.trim(),
        yearModel: Number(document.getElementById("unitYearModel").value),
        fuelType: document.getElementById("unitFuelType").value.trim(),
        sellingPrice: Number(document.getElementById("unitSellingPrice").value),
        available: document.getElementById("unitAvailability").value === "true"
    };
}

async function saveUnit(event) {
    event.preventDefault();
    const message = document.getElementById("unitsMessage");
    const submit = document.getElementById("unitForm").querySelector('[type="submit"]');
    submit.disabled = true;
    try {
        const result = await apiRequest(
            editingUnitId ? `/api/units/${encodeURIComponent(editingUnitId)}` : "/api/units",
            { method: editingUnitId ? "PUT" : "POST", body: JSON.stringify(unitFormData()) }
        );
        if (editingUnitId) {
            units = units.map(unit => unit.id === editingUnitId ? result.unit : unit);
        } else {
            units.push(result.unit);
        }
        closeUnitEditor();
        renderUnits();
        message.textContent = `${result.unit.unit} was saved.`;
    } catch (error) {
        message.textContent = `Could not save the unit: ${error.message}`;
        if (error.status === 401) serverAuthenticated = false;
    } finally {
        submit.disabled = false;
    }
}

async function toggleUnitAvailability(unit) {
    const message = document.getElementById("unitsMessage");
    const updatedUnit = { ...unit, available: !unit.available };
    try {
        const result = await apiRequest(`/api/units/${encodeURIComponent(unit.id)}`, {
            method: "PUT",
            body: JSON.stringify(updatedUnit)
        });
        units = units.map(item => item.id === unit.id ? result.unit : item);
        renderUnits();
        message.textContent = `${unit.unit} marked ${result.unit.available ? "available" : "unavailable"}.`;
    } catch (error) {
        message.textContent = `Could not update availability: ${error.message}`;
        if (error.status === 401) serverAuthenticated = false;
    }
}

async function deleteUnit() {
    const unit = units.find(item => item.id === editingUnitId);
    if (!unit || !window.confirm(`Delete "${unit.unit}" from the unit price list?`)) return;
    const message = document.getElementById("unitsMessage");
    try {
        await apiRequest(`/api/units/${encodeURIComponent(unit.id)}`, { method: "DELETE" });
        units = units.filter(item => item.id !== unit.id);
        closeUnitEditor();
        renderUnits();
        message.textContent = `${unit.unit} was deleted.`;
    } catch (error) {
        message.textContent = `Could not delete the unit: ${error.message}`;
        if (error.status === 401) serverAuthenticated = false;
    }
}

document.getElementById("addUnitBtn").addEventListener("click", () => beginUnitEdit());
document.getElementById("unitForm").addEventListener("submit", saveUnit);
document.getElementById("cancelUnitEdit").addEventListener("click", closeUnitEditor);
document.getElementById("deleteUnitBtn").addEventListener("click", deleteUnit);
document.getElementById("unitSearchForm").addEventListener("submit", event => {
    event.preventDefault();
    renderUnits();
});
document.getElementById("unitSearch").addEventListener("input", renderUnits);
document.getElementById("unitList").addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" || event.target.closest("button")) return;
    const card = event.target.closest(".unit-card");
    if (card) unitSwipeStart = { id: card.dataset.unitId, x: event.clientX, y: event.clientY };
});
document.getElementById("unitList").addEventListener("pointerup", event => {
    if (!unitSwipeStart || event.pointerType !== "touch") return;
    const start = unitSwipeStart;
    unitSwipeStart = null;
    const deltaX = event.clientX - start.x;
    const deltaY = Math.abs(event.clientY - start.y);
    if (deltaX < 60 || deltaY > 50) return;
    const unit = units.find(item => item.id === start.id);
    if (unit) toggleUnitAvailability(unit);
});
document.getElementById("unitList").addEventListener("pointercancel", () => {
    unitSwipeStart = null;
});

function renderHistory() {
    const list = document.getElementById("historyList");
    list.replaceChildren();
    let estimates;
    const searchTerm = document.getElementById("historySearch").value.trim().toLocaleUpperCase();
    try {
        estimates = readEstimates().filter(item => !item.deleted || item.syncStatus === "error")
            .sort((a, b) => new Date(b.updatedAt || b.savedAt) - new Date(a.updatedAt || a.savedAt))
            .filter(estimate => {
                if (!searchTerm) return true;
                const searchableText = [
                    getHistoryTitle(estimate),
                    estimate.data.date,
                    formatEstimateDate(estimate.data.date),
                    estimate.username
                ].join(" ").toLocaleUpperCase();
                return searchableText.includes(searchTerm);
            });
    } catch (error) {
        list.textContent = `Could not load estimate history: ${error.message}`;
        return;
    }
    if (estimates.length === 0) {
        list.textContent = searchTerm ? "No estimates match your search." : "No saved estimates yet.";
        return;
    }
    estimates.forEach(estimate => {
        const row = document.createElement("div");
        row.className = "history-row";
        const details = document.createElement("div");
        const title = document.createElement("div");
        title.className = "history-title";
        title.textContent = getHistoryTitle(estimate);
        const meta = document.createElement("div");
        meta.className = "history-meta";
        meta.textContent = `${formatEstimateDate(estimate.data.date) || "No date"} · ${estimate.username || "Unknown user"}`;
        details.append(title, meta);
        const status = document.createElement("span");
        const [label, className] = getStatusLabel(estimate);
        status.className = `cloud-status ${className}`;
        status.textContent = label;
        row.append(details, status);
        if (estimate.syncStatus === "error") {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "request-button history-action";
            retry.textContent = "Retry sync";
            retry.addEventListener("click", () => {
                updateHistoryStatus(estimate.id, estimate.deleted ? "offline-delete" : "pending");
                syncPendingEstimates();
            });
            row.appendChild(retry);
        }
        if (estimate.deleted) {
            list.appendChild(row);
            return;
        }
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "request-button history-action";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => editEstimate(estimate));
        row.appendChild(edit);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "request-button reject-button history-action";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteEstimate(estimate));
        row.appendChild(remove);
        list.appendChild(row);
    });
}

function loadHistory() {
    renderHistory();
    checkServerSession();
}

document.getElementById("historySearch").addEventListener("input", renderHistory);

function editEstimate(estimate) {
    const data = estimate.data;
    ["date", "orgPrefix", "clientName", "address", "contact", "makeModel", "plateNo", "chassisNo", "engineNo", "color", "insurance", "fileSuffix", "downpayment"].forEach(id => {
        const value = data[id];
        document.getElementById(id).value = value === undefined || value === null ? "" : value;
    });
    if (data.date && document.getElementById("date").value !== data.date) {
        const parsedDate = new Date(data.date);
        document.getElementById("date").value = Number.isNaN(parsedDate.getTime())
            ? ""
            : `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, "0")}-${String(parsedDate.getDate()).padStart(2, "0")}`;
    }
    updateDateDisplay();
    document.getElementById("bundleLabor").checked = data.bundleLabor !== false;
    document.getElementById("bundleAllPrices").checked = data.bundleAllPrices === true;
    document.getElementById("noteHiddenDamage").checked = data.noteHiddenDamage === true;
    updateHiddenDamageNote();
    const tbody = document.getElementById("worksBody");
    tbody.replaceChildren();
    (data.works || []).forEach(work => {
        addRow();
        const row = tbody.lastElementChild;
        const description = String(work.desc || "").trim();
        row.querySelector(".works-input").value = description.startsWith("*")
            ? description
            : description.replace(/^\d+\.\s*/, "");
        row.querySelector(".labor-cost").value = work.labor ? formatPHP(Number(work.labor)) : "";
        row.querySelector(".parts-cost").value = work.parts ? formatPHP(Number(work.parts)) : "";
    });
    addRow();
    updateWorkNumbers();
    calc();
    editingEstimateId = estimate.id;
    document.getElementById("saveBtn").textContent = "UPDATE";
    document.getElementById("historyMessage").textContent = `Editing ${getHistoryTitle(estimate)}.`;
    showPage("estimate");
}

function getLocalDateString(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatEstimateDate(dateValue) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
    if (!match) return "";
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day))
        .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        .toLocaleUpperCase();
}

function updateDateDisplay() {
    const dateInput = document.getElementById("date");
    document.getElementById("dateDisplay").textContent = formatEstimateDate(dateInput.value);
}

function ensureEstimateDate() {
    const dateInput = document.getElementById("date");
    if (!dateInput.value) dateInput.value = getLocalDateString();
    updateDateDisplay();
}

document.getElementById("date").addEventListener("input", updateDateDisplay);
document.getElementById("date").addEventListener("change", updateDateDisplay);
document.getElementById("pickDateBtn").addEventListener("click", () => {
    const dateInput = document.getElementById("date");
    if (typeof dateInput.showPicker === "function") dateInput.showPicker();
    else {
        dateInput.focus();
        dateInput.click();
    }
});
ensureEstimateDate();

function updateHiddenDamageNote() {
    document.getElementById("estimateNoteBody").hidden =
        !document.getElementById("noteHiddenDamage").checked;
}

document.getElementById("noteHiddenDamage").addEventListener("change", updateHiddenDamageNote);

function deleteEstimate(estimate) {
    if (!window.confirm(`Delete "${getHistoryTitle(estimate)}" from history and the local server?`)) return;
    try {
        const estimates = readEstimates();
        const existing = estimates.find(item => item.id === estimate.id);
        if (!existing) return;
        existing.deleted = true;
        existing.updatedAt = new Date().toISOString();
        existing.syncStatus = "pending";
        writeEstimates(estimates);
        renderHistory();
        syncPendingEstimates();
    } catch (error) {
        document.getElementById("historyMessage").textContent = `Could not delete estimate: ${error.message}`;
    }
}

window.addEventListener("online", () => {
    checkServerSession();
});
window.addEventListener("offline", () => {
    serverReachable = false;
    serverAuthenticated = false;
    updateConnectionStatus();
});
updateConnectionStatus();

try {
    const rememberedUsername = localStorage.getItem(REMEMBERED_USER_KEY);
    const rememberCheckbox = getRememberCheckbox();
    if (rememberedUsername) {
        document.getElementById("loginUsername").value = rememberedUsername;
        if (rememberCheckbox) rememberCheckbox.checked = true;
    }
    const rememberedCredential = localStorage.getItem(REMEMBERED_CREDENTIAL_KEY);
    if (rememberedCredential) {
        const credential = JSON.parse(rememberedCredential);
        const localUser = getOfflineUser(credential.username);
        if (localUser && localUser.passwordHash === credential.passwordHash &&
            localUser.salt === credential.salt) {
            sessionStorage.setItem(ACTIVE_USER_KEY, credential.username);
            showApp(credential.username);
        } else {
            localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
            localStorage.removeItem(REMEMBERED_USER_KEY);
        }
    }
    const activeUsername = sessionStorage.getItem(ACTIVE_USER_KEY);
    if (appContainer.hidden && activeUsername && getOfflineUser(activeUsername)) {
        showApp(activeUsername);
    }
} catch (error) {
    setAuthMessage(`Local account storage is unavailable: ${error.message}`);
}

window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPromptEvent = event;
    document.getElementById("installAppBtn").hidden = false;
    document.getElementById("installMessage").hidden = true;
});

document.getElementById("installAppBtn").addEventListener("click", async () => {
    if (!installPromptEvent) {
        const message = document.getElementById("installMessage");
        message.textContent =
            "To install, use your browser menu and choose Install app or Add to Home screen. If that option is missing, first trust the RLD server certificate and reload this page. On iPhone, use Safari's Share menu.";
        message.hidden = false;
        return;
    }
    try {
        installPromptEvent.prompt();
        await installPromptEvent.userChoice;
        installPromptEvent = null;
        document.getElementById("installAppBtn").hidden = true;
        document.getElementById("installMessage").hidden = true;
    } catch (error) {
        const message = document.getElementById("installMessage");
        message.textContent = `Could not start installation: ${error.message}`;
        message.hidden = false;
    }
});

if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" }).catch(error => {
        const message = `Offline setup failed: ${error.message}. Check that this phone trusts the RLD server certificate, then reload the app.`;
        if (appContainer.hidden) setAuthMessage(message);
        else {
            const installMessage = document.getElementById("installMessage");
            installMessage.textContent = message;
            installMessage.hidden = false;
        }
    });
}

if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) {
    document.getElementById("installAppBtn").hidden = true;
}
window.addEventListener("appinstalled", () => {
    document.getElementById("installAppBtn").hidden = true;
    document.getElementById("installMessage").hidden = true;
});
window.setInterval(checkServerSession, 15000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkServerSession();
});

const learnedRepairs = [
    "PULLOUT & REPLACE FRONT SHOCK ABSORBER SET", "PULLOUT & REPLACE LOWER BALL JOINT SET",
    "PULLOUT & REPLACE STABILIZER LINK SET", "PULLOUT & REPLACE TRUNK CABLE",
    "REPLACE SHOCK ABSORBER", "GAS CABLE", "GREASE", "2PCS FRONT SHOCK ABSORBER",
    "PULLOUT & INSTALL WINDSHIELD GLASS", "REPLACE LH & RH DOOR GLASS", "RESEALANT", "LEAK CHECK",
    "WINDSHIELD", "WINDSHIELD RUBBER", "LH QUARTER GLASS",
    "REPLACE & ALIGN ALL PARTS INDICATED ABOVE", "FRONT BUMPER", "FENDER", "ROOF",
    "LH FRONT DOOR", "LH REAR DOOR", "LH CENTER POST", "LH PILLAR POST", "LH SIDE MIRROR COVER",
    "CEILING", "SEALANT", "TOCKS & CLIPS", "4PCS HINGES"
];

function handleInlineAutocomplete(e) {
    if (e.inputType === "deleteContentBackward" || e.inputType === "deleteContentForward") return;
    const input = e.target;
    const val = input.value.toUpperCase();
    if (!val || val.startsWith("*")) return;

    const match = learnedRepairs.find(repair => repair.toUpperCase().startsWith(val));
    if (match) {
        const currentLength = input.value.length;
        input.value = match;
        input.setSelectionRange(currentLength, match.length);
    }
}

// --- CURRENCY MATH & FORMATTING ---
function cleanNum(val) {
    if (!val) return 0;
    const parsed = parseFloat(val.toString().replace(/[^0-9.-]+/g, ""));
    return isNaN(parsed) ? 0 : parsed;
}

function formatPHP(num) {
    if (num === 0 || !num) return "";
    return "PHP " + num.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function calc() {
    let tLabor = 0, tParts = 0;
    document.querySelectorAll('.labor-cost').forEach(i => tLabor += cleanNum(i.value));
    document.querySelectorAll('.parts-cost').forEach(i => tParts += cleanNum(i.value));
    let down = cleanNum(document.getElementById('downpayment').value);
    
    document.getElementById('totLabor').value = formatPHP(tLabor);
    document.getElementById('totParts').value = formatPHP(tParts);
    document.getElementById('totDue').value = formatPHP((tLabor + tParts) - down);
}

// --- GLOBAL EVENT LISTENERS ---
const worksTable = document.getElementById('worksTable');

worksTable.addEventListener('focusin', function(e) {
    if (e.target.classList.contains('cost-input') && !e.target.readOnly) {
        let val = cleanNum(e.target.value);
        e.target.value = val === 0 ? "" : val;
    }
});

worksTable.addEventListener('focusout', function(e) {
    if (e.target.classList.contains('cost-input') && !e.target.readOnly) {
        let val = cleanNum(e.target.value);
        e.target.value = val === 0 ? "" : formatPHP(val);
        calc();
    }
});

// Row logic: Auto-merge and Auto-add
document.getElementById('worksBody').addEventListener('input', function(e) {
    if (e.target.classList.contains('works-input')) {
        handleInlineAutocomplete(e);
    }
    
    const rows = this.querySelectorAll('tr:not(.print-pad-row)');
    let isLastRowFilled = false;

    rows.forEach((row, index) => {
        const input = row.querySelector('.works-input');
        if (index === rows.length - 1) {
            const lab = row.querySelector('.labor-cost').value;
            const part = row.querySelector('.parts-cost').value;
            const val = input.value.trim();
            if (val !== '' || lab !== '' || part !== '') {
                isLastRowFilled = true;
            }
        }
    });

    updateWorkNumbers();
    if (isLastRowFilled) {
        addRow();
    }

    calc();
});

document.getElementById('worksBody').addEventListener('keydown', function(e) {
    if (!e.target.classList.contains('works-input') || e.key !== 'Enter') return;

    e.preventDefault();
    const inputs = Array.from(this.querySelectorAll('.works-input'));
    const currentIndex = inputs.indexOf(e.target);
    let nextInput = inputs[currentIndex + 1];

    if (!nextInput) {
        addRow();
        nextInput = this.querySelector('tr:last-child .works-input');
    }

    nextInput.focus();
});

function addRow() {
    const tbody = document.getElementById('worksBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>
            <div class="works-cell">
                <span class="row-num"></span>
                <input type="text" class="works-input" list="categorySuggestions">
            </div>
        </td>
        <td><input type="text" class="cost-input labor-cost"></td>
        <td><input type="text" class="cost-input parts-cost"></td>
    `;
    tbody.appendChild(tr);
}

function updateWorkNumbers() {
    let number = 1;
    document.querySelectorAll('#worksBody tr:not(.print-pad-row)').forEach(row => {
        const description = row.querySelector('.works-input').value.trim();
        const numberLabel = row.querySelector('.row-num');
        const workInput = row.querySelector('.works-input');
        if (description.startsWith('*')) {
            numberLabel.textContent = '';
            row.classList.remove('numbered-work-row');
            workInput.classList.remove('numbered-work');
            number = 1;
        } else if (description) {
            numberLabel.textContent = `${number}.`;
            row.classList.add('numbered-work-row');
            workInput.classList.add('numbered-work');
            number += 1;
        } else {
            numberLabel.textContent = '';
            row.classList.remove('numbered-work-row');
            workInput.classList.remove('numbered-work');
        }
    });
}

function mergeSingleCostsForPrint() {
    const rows = Array.from(document.querySelectorAll('#worksBody tr:not(.print-pad-row)'));
    let sectionRows = [];
    let isPartsSection = false;

    function mergeSection() {
        if (sectionRows.length === 0) return;

        const rowsToMerge = sectionRows.slice();
        while (rowsToMerge.length > 0) {
            const lastRow = rowsToMerge[rowsToMerge.length - 1];
            const hasDescription = lastRow.querySelector('.works-input').value.trim() !== '';
            const hasCost = Array.from(lastRow.querySelectorAll('.labor-cost, .parts-cost'))
                .some(input => input.value.trim() !== '');
            if (hasDescription || hasCost) break;
            rowsToMerge.pop();
        }

        const bundleAllPrices = document.getElementById("bundleAllPrices").checked;
        const bundleLabor = document.getElementById('bundleLabor').checked;
        if (rowsToMerge.length < 2) return;

        if (bundleAllPrices) {
            const sourceCellsByCost = [1, 2].map(cellIndex =>
                rowsToMerge.map(row => row.children[cellIndex]));
            sourceCellsByCost.forEach((sourceCells, costIndex) => {
                const inputSelector = costIndex === 0 ? ".labor-cost" : ".parts-cost";
                const total = rowsToMerge.reduce((sum, row) =>
                    sum + cleanNum(row.querySelector(inputSelector).value), 0);
                if (total === 0) return;

                const mergedCell = sourceCells[0].cloneNode(true);
                const mergedInput = mergedCell.querySelector(inputSelector);
                mergedInput.value = formatPHP(total);
                mergedInput.readOnly = true;
                mergedCell.rowSpan = rowsToMerge.length;
                mergedCell.classList.add("print-merged-cell");
                sourceCells.forEach(cell => cell.classList.add("print-merged-source"));
                rowsToMerge[0].insertBefore(mergedCell, sourceCells[0]);
            });
            return;
        }

        if (!bundleLabor || isPartsSection) return;

        const laborRows = rowsToMerge.filter(row => {
            const input = row.querySelector('.labor-cost');
            return input && input.value.trim() !== '';
        });
        if (laborRows.length !== 1) return;

        const sourceCell = laborRows[0].children[1];
        const mergedCell = sourceCell.cloneNode(true);
        mergedCell.querySelector('.labor-cost').readOnly = true;
        mergedCell.rowSpan = rowsToMerge.length;
        mergedCell.classList.add('print-merged-cell');

        rowsToMerge.forEach(row => row.children[1].classList.add('print-merged-source'));
        rowsToMerge[0].insertBefore(mergedCell, rowsToMerge[0].children[1]);
    }

    rows.forEach(row => {
        const descriptionInput = row.querySelector('.works-input');
        const description = descriptionInput ? descriptionInput.value.trim() : '';
        if (description.startsWith('*')) {
            mergeSection();
            sectionRows = [];
            isPartsSection = description.toUpperCase().replace(/\s+/g, '') === '*PARTS';
        } else {
            sectionRows.push(row);
        }
    });

    mergeSection();
}

// --- PRINT SUPPORT ---
window.addEventListener('beforeprint', () => {
    mergeSingleCostsForPrint();
});

function cleanupPrintLayout() {
    document.querySelectorAll('.print-pad-row').forEach(row => row.remove());
    document.querySelectorAll('.print-merged-cell').forEach(cell => cell.remove());
    document.querySelectorAll('.print-merged-source').forEach(cell => cell.classList.remove('print-merged-source'));
}

window.addEventListener('afterprint', cleanupPrintLayout);
document.getElementById("printBtn").addEventListener("click", printEstimate);
document.getElementById("saveImageBtn").addEventListener("click", saveEstimateImage);

function printEstimate() {
    ensureEstimateDate();
    window.print();
}

function getEstimateImage(selector) {
    const image = document.querySelector(selector);
    if (!image || !image.complete || !image.naturalWidth) {
        throw new Error(`Could not load ${image && image.alt || "an estimate image"}. Try again in a moment.`);
    }
    return image;
}

function wrapCanvasText(context, value, maxWidth) {
    const lines = [];
    String(value || "").split(/\s+/).forEach(word => {
        if (!word) return;
        const current = lines[lines.length - 1];
        const candidate = current ? `${current} ${word}` : word;
        if (current && context.measureText(candidate).width > maxWidth) lines.push(word);
        else if (current) lines[lines.length - 1] = candidate;
        else lines.push(word);
    });
    return lines.length ? lines : [""];
}

function getPrintableWorkRows(data) {
    const output = [];
    let section = [];
    const flushSection = () => {
        if (section.length === 0) return;
        if (data.bundleAllPrices) {
            const laborTotal = section.reduce((sum, work) => sum + work.labor, 0);
            const partsTotal = section.reduce((sum, work) => sum + work.parts, 0);
            section = section.map((work, index) => ({
                ...work,
                labor: index === 0 ? laborTotal : 0,
                parts: index === 0 ? partsTotal : 0
            }));
        } else if (data.bundleLabor && section.filter(work => work.labor !== 0).length === 1) {
            const laborTotal = section.reduce((sum, work) => sum + work.labor, 0);
            let merged = false;
            section = section.map(work => {
                if (work.labor === 0) return work;
                const next = { ...work, labor: merged ? 0 : laborTotal };
                merged = true;
                return next;
            });
        }
        output.push(...section);
        section = [];
    };

    data.works.forEach(work => {
        const description = String(work.desc || "").trim();
        const row = {
            desc: description,
            labor: Number(work.labor) || 0,
            parts: Number(work.parts) || 0
        };
        if (description.startsWith("*")) {
            flushSection();
            output.push(row);
        } else {
            section.push(row);
        }
    });
    flushSection();
    return output;
}

function buildEstimateImage() {
    ensureEstimateDate();
    const data = collectEstimateData();
    const banner = getEstimateImage(".print-banner");
    const preparedSignature = getEstimateImage(".sig-block:first-child .sig-image");
    const approvedSignature = getEstimateImage(".sig-block:last-child .sig-image");
    const pixelRatio = 2;
    const pageWidth = 850;
    const margin = 30;
    const contentWidth = pageWidth - margin * 2;
    const canvas = document.createElement("canvas");
    canvas.width = pageWidth * pixelRatio;
    canvas.height = 2200 * pixelRatio;
    let context = canvas.getContext("2d");
    if (!context) throw new Error("Image export is not supported by this browser.");
    context.scale(pixelRatio, pixelRatio);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, pageWidth, 2200);
    context.fillStyle = "#111";
    context.strokeStyle = "#111";
    context.textBaseline = "top";
    let y = margin;

    const drawCenteredImage = (image, maxWidth, maxHeight) => {
        const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, (pageWidth - width) / 2, y, width, height);
        y += height;
    };
    const drawCenteredText = (text, font, lineHeight) => {
        context.font = font;
        context.textAlign = "center";
        const lines = wrapCanvasText(context, text, contentWidth);
        lines.forEach(line => {
            context.fillText(line, pageWidth / 2, y);
            y += lineHeight;
        });
    };
    const drawCellText = (text, x, top, width, font, lineHeight, padding = 6) => {
        context.font = font;
        context.textAlign = "left";
        const lines = wrapCanvasText(context, text, width - padding * 2);
        lines.forEach((line, index) => {
            context.fillText(line, x + padding, top + padding + index * lineHeight);
        });
        return Math.max(28, lines.length * lineHeight + padding * 2);
    };
    const drawRule = (x1, y1, x2, y2, color = "#222") => {
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x1, y1);
        context.lineTo(x2, y2);
        context.stroke();
    };

    drawCenteredImage(banner, contentWidth, 95);
    y += 3;
    drawRule(margin, y, pageWidth - margin, y, "#e1b400");
    y += 8;
    drawCenteredText("RLD AUTOWORX AND TOWING SERVICES", "bold 13px Arial", 17);
    [
        "Brgy. Buli, Taal, Batangas",
        "Contact No: 09296462336/09267433265/(043)321-8477",
        "Email: rldcarpaintingservices@yahoo.com",
        "TIN NO: 287-920-998-000"
    ].forEach(line => drawCenteredText(line, "bold 9px Arial", 12));
    y += 8;

    context.font = "bold 14px Arial";
    context.textAlign = "left";
    context.fillText("JOB ESTIMATE", margin, y);
    context.textAlign = "right";
    context.font = "bold 11px Arial";
    context.fillText(`DATE: ${formatEstimateDate(data.date)}`, pageWidth - margin, y + 1);
    y += 23;

    const columnWidths = [contentWidth * 0.45, contentWidth * 0.27, contentWidth * 0.28];
    const tableX = margin;
    const infoHeaderHeight = 24;
    context.fillStyle = "#f0f0f0";
    context.fillRect(tableX, y, contentWidth, infoHeaderHeight);
    context.fillStyle = "#111";
    drawCellText("CLIENT", tableX, y, columnWidths[0], "bold 9px Arial", 12);
    drawCellText("VEHICLE", tableX + columnWidths[0], y, columnWidths[1] + columnWidths[2], "bold 9px Arial", 12);
    drawRule(tableX, y, tableX + contentWidth, y);
    drawRule(tableX, y + infoHeaderHeight, tableX + contentWidth, y + infoHeaderHeight);
    drawRule(tableX, y, tableX, y + infoHeaderHeight);
    drawRule(tableX + columnWidths[0], y, tableX + columnWidths[0], y + infoHeaderHeight);
    drawRule(tableX + contentWidth, y, tableX + contentWidth, y + infoHeaderHeight);
    y += infoHeaderHeight;

    const infoRows = [
        [`NAME: ${data.clientName}`, `MAKE & MODEL: ${data.makeModel}`, `PLATE NO.: ${data.plateNo}`],
        [`ADDRESS: ${data.address}`, `CHASSIS NO: ${data.chassisNo}`, `ENGINE NO.: ${data.engineNo}`],
        [`CONTACT NUMBER: ${data.contact}`, `COLOR: ${data.color}`, `INSURANCE.: ${data.insurance}`]
    ];
    infoRows.forEach(row => {
        const rowHeight = Math.max(...row.map((text, index) => {
            context.font = "8px Arial";
            return wrapCanvasText(context, text, columnWidths[index] - 12).length * 10 + 12;
        }));
        let x = tableX;
        row.forEach((text, index) => {
            drawRule(x, y, x, y + rowHeight);
            drawCellText(text, x, y, columnWidths[index], "8px Arial", 10);
            x += columnWidths[index];
        });
        drawRule(tableX + contentWidth, y, tableX + contentWidth, y + rowHeight);
        drawRule(tableX, y + rowHeight, tableX + contentWidth, y + rowHeight);
        y += rowHeight;
    });
    y += 10;

    const workWidths = [contentWidth * 0.5, contentWidth * 0.25, contentWidth * 0.25];
    const workHeaders = ["SCOPE OF WORKS", "COST OF LABOR", "COST OF PARTS"];
    const drawWorkRow = (values, bold = false, textColor = "#111") => {
        const font = bold ? "bold 8px Arial" : "8px Arial";
        const rowHeight = Math.max(...values.map((value, index) =>
            wrapCanvasText(context, value, workWidths[index] - 12).length * 11 + 10
        ));
        let x = tableX;
        values.forEach((value, index) => {
            drawRule(x, y, x, y + rowHeight);
            context.font = font;
            context.fillStyle = textColor;
            context.textAlign = index ? "right" : "left";
            const lines = wrapCanvasText(context, value, workWidths[index] - 12);
            lines.forEach((line, lineIndex) => {
                context.fillText(line, index ? x + workWidths[index] - 6 : x + 6, y + 5 + lineIndex * 11);
            });
            x += workWidths[index];
        });
        context.fillStyle = "#111";
        drawRule(tableX + contentWidth, y, tableX + contentWidth, y + rowHeight);
        drawRule(tableX, y + rowHeight, tableX + contentWidth, y + rowHeight);
        y += rowHeight;
    };
    context.fillStyle = "#f0f0f0";
    context.fillRect(tableX, y, contentWidth, 24);
    context.fillStyle = "#111";
    drawRule(tableX, y, tableX + contentWidth, y);
    drawWorkRow(workHeaders, true);
    let workNumber = 1;
    getPrintableWorkRows(data).forEach(work => {
        let description = String(work.desc || "").trim();
        if (!description) return;
        if (description.startsWith("*")) {
            workNumber = 1;
        } else {
            description = `${workNumber}. ${description}`;
            workNumber += 1;
        }
        drawWorkRow([
            description,
            work.labor ? formatPHP(work.labor) : "",
            work.parts ? formatPHP(work.parts) : ""
        ]);
    });
    if (data.noteHiddenDamage) {
        drawWorkRow(["NOTE: HIDDEN DAMAGE ARE NOT INCLUDED", "", ""], true, "#c00000");
    }
    drawWorkRow([
        "TOTAL LABOR/MATERIALS/PARTS:",
        document.getElementById("totLabor").value,
        document.getElementById("totParts").value
    ], true);
    drawWorkRow(["DOWNPAYMENT:", document.getElementById("downpayment").value, ""], true);
    drawWorkRow(["TOTAL AMOUNT DUE:", document.getElementById("totDue").value, ""], true);
    y += 14;

    const signatureTop = y;
    const signatureWidth = contentWidth / 2 - 20;
    [preparedSignature, approvedSignature].forEach((image, index) => {
        const x = margin + index * (contentWidth / 2) + 10;
        const imageScale = Math.min(110 / image.naturalWidth, 42 / image.naturalHeight);
        const imageWidth = image.naturalWidth * imageScale;
        const imageHeight = image.naturalHeight * imageScale;
        context.drawImage(image, x + (signatureWidth - imageWidth) / 2, signatureTop, imageWidth, imageHeight);
        drawRule(x + 10, signatureTop + 46, x + signatureWidth, signatureTop + 46);
        context.font = "bold 8px Arial";
        context.textAlign = "center";
        context.fillText(
            index ? "APPROVED BY: ROLDAN DUEÑAS" : "PREPARED BY: BEVERLY BALATBAT",
            x + signatureWidth / 2,
            signatureTop + 50
        );
    });
    y += 72;

    const terms = [
        "I HEREBY AUTHORIZE AND AGREE TO PAY FOR THE ABOVE REPAIRS AND WORK TO BE DONE ON MY VEHICLE INCLUDING ALL PARTS AND MATERIALS NECESSARY TO PERFORM THE SAME. I ALSO AGREE TO THE TERMS AND CONDITION STATED BELOW:",
        "1. RLD AUTOWORX & TOWING SERVICES will not be held responsible for any losses or damages to the vehicle and its accessories or any articles of value left in the vehicle in case of theft, fire, accident or any other cause beyond the auto center's control.",
        "2. Customer acknowledges an expenses mechanic lien to secure the amount of repairs thereto.",
        "3. Company employees may operate vehicle for purposes of testing inspection and /or deliver at customer's risk.",
        "4. No claims for damages to vehicle under this repair order will be considered unless received by the company within three (3) days after the vehicle has been delivered.",
        "5. Customers agrees to pay interest at the rate of 3% per month on all accounts not paid when due.",
        "6. RLD AUTOWORX & TOWING SERVICES will charge a daily storage fee of P300.00 on the vehicle from the day enter on the repair shop if not yet started of repair of vehicle.",
        "7. RLD AUTOWORX & TOWING SERVICES to charge a daily storage fee of P300.00 on the vehicle not claimed on the date of upon completion of repair.",
        "8. Hidden defects are not included in this evaluation.",
        "9. Prices are subject to change without prior notice."
    ];
    terms.forEach(term => {
        context.font = "7px Arial";
        context.textAlign = "left";
        const lines = wrapCanvasText(context, term, contentWidth);
        lines.forEach(line => {
            context.fillText(line, margin, y);
            y += 9;
        });
        y += 2;
    });

    const logicalHeight = Math.max(1300, y + margin);
    if (logicalHeight > 2200) {
        throw new Error("This estimate is too long to fit in one image. Remove some work items and try again.");
    }
    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = pageWidth * pixelRatio;
    finalCanvas.height = logicalHeight * pixelRatio;
    const finalContext = finalCanvas.getContext("2d");
    if (!finalContext) throw new Error("Image export is not supported by this browser.");
    finalContext.fillStyle = "#fff";
    finalContext.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    finalContext.drawImage(
        canvas, 0, 0, canvas.width, finalCanvas.height, 0, 0, finalCanvas.width, finalCanvas.height
    );
    const dataUrl = finalCanvas.toDataURL("image/png");
    const imageBytes = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(imageBytes.length);
    for (let index = 0; index < imageBytes.length; index += 1) {
        bytes[index] = imageBytes.charCodeAt(index);
    }
    return { blob: new Blob([bytes], { type: "image/png" }), data };
}

async function saveEstimateImage() {
    const button = document.getElementById("saveImageBtn");
    const message = document.getElementById("estimateMessage");
    let generatedImage;
    button.disabled = true;
    message.textContent = "Creating estimate image...";
    try {
        const { blob, data } = buildEstimateImage();
        const fileName = `${estimateFilenameComponent(data.makeModel, "UNKNOWN VEHICLE")}_${estimateFilenameComponent(data.plateNo, "NO PLATE")}.png`;
        const file = new File([blob], fileName, { type: "image/png" });
        generatedImage = { blob, fileName };
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: "RLD Job Estimate" });
            message.textContent = "Choose Photos or Gallery in the share menu to save the image.";
            return;
        }
        downloadEstimateImage(blob, fileName, message);
    } catch (error) {
        if (error.name === "AbortError") {
            message.textContent = "Image sharing was cancelled.";
        } else if (error.name === "NotAllowedError") {
            downloadEstimateImage(generatedImage && generatedImage.blob, generatedImage && generatedImage.fileName, message);
        } else {
            message.textContent = `Could not create or share the estimate image: ${error.message}`;
        }
    } finally {
        button.disabled = false;
    }
}

function downloadEstimateImage(blob, fileName, message) {
    if (!blob || !fileName) {
        message.textContent = "Could not share the image. Try Save as image again.";
        return;
    }
    const downloadUrl = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = downloadUrl;
    download.download = fileName;
    download.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    message.textContent = "Image downloaded. Open it from Downloads or Files to save it to Photos or Gallery.";
}

// --- SAVE ESTIMATES AND QUEUE DRIVE SYNC ---
function collectEstimateData() {
    const data = {
        date: document.getElementById('date').value,
        noteHiddenDamage: document.getElementById("noteHiddenDamage").checked,
        orgPrefix: document.getElementById('orgPrefix').value,
        clientName: document.getElementById('clientName').value,
        address: document.getElementById('address').value,
        contact: document.getElementById('contact').value,
        makeModel: document.getElementById('makeModel').value,
        plateNo: document.getElementById('plateNo').value,
        chassisNo: document.getElementById('chassisNo').value,
        engineNo: document.getElementById('engineNo').value,
        color: document.getElementById('color').value,
        insurance: document.getElementById('insurance').value,
        fileSuffix: document.getElementById('fileSuffix').value,
        bundleLabor: document.getElementById("bundleLabor").checked,
        bundleAllPrices: document.getElementById("bundleAllPrices").checked,
        totLabor: cleanNum(document.getElementById('totLabor').value),
        totParts: cleanNum(document.getElementById('totParts').value),
        downpayment: cleanNum(document.getElementById('downpayment').value),
        totDue: cleanNum(document.getElementById('totDue').value),
        works: []
    };

    document.querySelectorAll('#worksBody tr:not(.print-pad-row)').forEach(row => {
        const input = row.querySelector('.works-input');
        const lab = cleanNum(row.querySelector('.labor-cost').value);
        const part = cleanNum(row.querySelector('.parts-cost').value);
        
        if (input && input.value.trim() !== '') { 
            data.works.push({
                desc: input.value.trim().toUpperCase(),
                labor: lab === 0 ? "" : lab,
                parts: part === 0 ? "" : part
            });
        }
    });
    return data;
}

function clearEstimateForm() {
    document.getElementById("estimateForm").reset();
    updateHiddenDamageNote();
    ensureEstimateDate();
    const worksBody = document.getElementById("worksBody");
    worksBody.replaceChildren();
    addRow();
    editingEstimateId = null;
    document.getElementById("saveBtn").textContent = "SAVE";
    updateWorkNumbers();
    document.getElementById("estimateMessage").textContent = "";
    calc();
}

document.getElementById("clearEntryBtn").addEventListener("click", () => {
    const hasEntry = Array.from(document.querySelectorAll(
        "#estimateForm input:not([type=checkbox])"
    )).some(input => input.value.trim() !== "");
    if (hasEntry && !window.confirm("Clear all fields in this estimate? Unsaved changes will be lost.")) {
        return;
    }
    clearEstimateForm();
    document.getElementById("estimateMessage").textContent = "The estimate entry has been cleared.";
});

document.getElementById("saveBtn").addEventListener("click", function() {
    try {
        ensureEstimateDate();
        const estimates = readEstimates();
        const existing = editingEstimateId ? estimates.find(item => item.id === editingEstimateId) : null;
        const savedAt = new Date().toISOString();
        const estimate = {
            ...(existing || {}),
            id: editingEstimateId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
            savedAt: existing ? existing.savedAt : savedAt,
            updatedAt: savedAt,
            username: existing ? existing.username : sessionStorage.getItem(ACTIVE_USER_KEY),
            data: collectEstimateData(),
            syncStatus: "pending",
            deleted: false
        };
        const index = estimates.findIndex(item => item.id === estimate.id);
        if (index < 0) estimates.push(estimate);
        else estimates[index] = estimate;
        writeEstimates(estimates);
        refreshEstimateSuggestions();

        clearEstimateForm();
        document.getElementById("estimateMessage").textContent =
            "Saved on this device and cleared from the form. It will sync when the Windows server is reachable.";
        syncPendingEstimates();
        renderHistory();
    } catch (error) {
        document.getElementById("estimateMessage").textContent =
            `Could not save this estimate: ${error.message}`;
    }
});

["orgPrefix", "makeModel", "fileSuffix", "insurance"].forEach(id => {
    document.getElementById(id).addEventListener("focus", refreshEstimateSuggestions);
});