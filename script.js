// script.js
const OFFLINE_USERS_KEY = "rld.offlineUsers.v1";
const ACTIVE_USER_KEY = "rld.activeUser";
const REMEMBERED_USER_KEY = "rld.rememberedUser";
const REMEMBERED_CREDENTIAL_KEY = "rld.rememberedCredential";
const ESTIMATES_KEY = "rld.estimates.v1";
const ADMIN_USERNAME = "rld";
let editingEstimateId = null;
let syncQueueRunning = false;
let serverAuthenticated = false;
let serverReachable = false;
let installPromptEvent = null;

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
        const response = await fetch(path, {
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
    const activePage = showAdmin ? "admin" : showHistory ? "history" : "estimate";
    document.getElementById("estimatePage").hidden = showAdmin || showHistory;
    document.getElementById("adminPage").hidden = !showAdmin;
    document.getElementById("historyPage").hidden = !showHistory;
    const navigationPages = {
        estimate: ["showEstimatePage", "estimatePage"],
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
    return estimate.data.clientName || estimate.data.fileSuffix || "Untitled estimate";
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

function renderHistory() {
    const list = document.getElementById("historyList");
    list.replaceChildren();
    let estimates;
    try {
        estimates = readEstimates().filter(item => !item.deleted || item.syncStatus === "error")
            .sort((a, b) => new Date(b.updatedAt || b.savedAt) - new Date(a.updatedAt || a.savedAt));
    } catch (error) {
        list.textContent = `Could not load estimate history: ${error.message}`;
        return;
    }
    if (estimates.length === 0) {
        list.textContent = "No saved estimates yet.";
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
        meta.textContent = `${estimate.data.date || "No date"} · ${estimate.username || "Unknown user"}`;
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
        if (estimate.syncStatus === "synced") {
            const open = document.createElement("a");
            open.className = "request-button history-action";
            open.href = `/api/estimates/${encodeURIComponent(estimate.id)}/pdf`;
            open.target = "_blank";
            open.rel = "noopener";
            open.textContent = "Download PDF";
            row.appendChild(open);
        }
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

function editEstimate(estimate) {
    const data = estimate.data;
    ["date", "orgPrefix", "clientName", "address", "contact", "makeModel", "plateNo", "chassisNo", "engineNo", "color", "insurance", "fileSuffix", "downpayment"].forEach(id => {
        const value = data[id];
        document.getElementById(id).value = value === undefined || value === null ? "" : value;
    });
    const tbody = document.getElementById("worksBody");
    tbody.replaceChildren();
    (data.works || []).forEach(work => {
        addRow();
        const row = tbody.lastElementChild;
        row.querySelector(".works-input").value = work.desc;
        row.querySelector(".labor-cost").value = work.labor ? formatPHP(Number(work.labor)) : "";
        row.querySelector(".parts-cost").value = work.parts ? formatPHP(Number(work.parts)) : "";
    });
    addRow();
    calc();
    editingEstimateId = estimate.id;
    document.getElementById("saveBtn").textContent = "UPDATE";
    document.getElementById("historyMessage").textContent = `Editing ${getHistoryTitle(estimate)}.`;
    showPage("estimate");
}

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
});

document.getElementById("installAppBtn").addEventListener("click", async () => {
    if (!installPromptEvent) {
        document.getElementById("historyMessage").textContent =
            "On iPhone, open the Share menu in Safari and choose Add to Home Screen. On Android, use the browser menu and choose Install app.";
        return;
    }
    try {
        installPromptEvent.prompt();
        await installPromptEvent.userChoice;
        installPromptEvent = null;
        document.getElementById("installAppBtn").hidden = true;
    } catch (error) {
        document.getElementById("historyMessage").textContent = `Could not start installation: ${error.message}`;
    }
});

if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/service-worker.js").catch(error => {
        const message = `Offline app setup failed: ${error.message}`;
        if (appContainer.hidden) setAuthMessage(message);
        else document.getElementById("historyMessage").textContent = message;
    });
}

if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) {
    document.getElementById("installAppBtn").hidden = true;
}
window.addEventListener("appinstalled", () => {
    document.getElementById("installAppBtn").hidden = true;
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
    let itemCounter = 1;
    let isLastRowFilled = false;

    rows.forEach((row, index) => {
        const input = row.querySelector('.works-input');
        const numSpan = row.querySelector('.row-num');
        const val = input.value.trim().toUpperCase();

        const td1 = row.children[0];
        const td2 = row.children[1];
        const td3 = row.children[2];
        if (index === rows.length - 1) {
            const lab = row.querySelector('.labor-cost').value;
            const part = row.querySelector('.parts-cost').value;
            if (val !== '' || lab !== '' || part !== '') {
                isLastRowFilled = true;
            }
        }
    });

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

// --- PRINT ROW PADDING ---
window.addEventListener('beforeprint', () => {
    const tbody = document.getElementById('worksBody');
    mergeSingleCostsForPrint();

    for (let i = 0; i < 2; i++) {
        const tr = document.createElement('tr');
        tr.className = 'print-pad-row'; 
        tr.innerHTML = `
            <td><div style="height: 16px;"></div></td>
            <td></td>
            <td></td>
        `;
        tbody.appendChild(tr);
    }
});

window.addEventListener('afterprint', () => {
    document.querySelectorAll('.print-pad-row').forEach(row => row.remove());
    document.querySelectorAll('.print-merged-cell').forEach(cell => cell.remove());
    document.querySelectorAll('.print-merged-source').forEach(cell => cell.classList.remove('print-merged-source'));
});

// --- SAVE ESTIMATES AND QUEUE DRIVE SYNC ---
function collectEstimateData() {
    const data = {
        date: document.getElementById('date').value,
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
        totLabor: cleanNum(document.getElementById('totLabor').value),
        totParts: cleanNum(document.getElementById('totParts').value),
        downpayment: cleanNum(document.getElementById('downpayment').value),
        totDue: cleanNum(document.getElementById('totDue').value),
        works: []
    };

    document.querySelectorAll('#worksBody tr:not(.print-pad-row)').forEach(row => {
        const input = row.querySelector('.works-input');
        const num = row.querySelector('.row-num');
        const lab = cleanNum(row.querySelector('.labor-cost').value);
        const part = cleanNum(row.querySelector('.parts-cost').value);
        
        if (input && input.value.trim() !== '') { 
            const finalDesc = (num.innerText + " " + input.value).trim().toUpperCase();
            data.works.push({
                desc: finalDesc,
                labor: lab === 0 ? "" : lab,
                parts: part === 0 ? "" : part
            });
        }
    });
    return data;
}

document.getElementById("saveBtn").addEventListener("click", function() {
    try {
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

        editingEstimateId = null;
        this.textContent = "SAVE";
        document.getElementById("historyMessage").textContent =
            "Saved on this device. It will sync automatically when the Windows server is reachable.";
        syncPendingEstimates();
        if (!document.getElementById("historyPage").hidden) renderHistory();
    } catch (error) {
        alert(`Could not save this estimate: ${error.message}`);
    }
});