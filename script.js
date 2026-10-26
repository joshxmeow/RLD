// script.js
const USERS_KEY = "rld.users.v1";
const ACTIVE_USER_KEY = "rld.activeUser";
const REMEMBERED_USER_KEY = "rld.rememberedUser";
const REMEMBERED_CREDENTIAL_KEY = "rld.rememberedCredential";
const ESTIMATES_KEY = "rld.estimates.v1";
const CLOUD_URL_KEY = "rld.cloudScriptUrl";
const ADMIN_USERNAME = "rld";
const ADMIN_PASSWORD_HASH = "662e0514c2fd58527dca88e2d8b5776efa997e2f81d2cc09bf402c69a4e68efc";
let editingEstimateId = null;
let syncQueueRunning = false;

const authShell = document.getElementById("authShell");
const appContainer = document.getElementById("appContainer");
const authMessage = document.getElementById("authMessage");

function setAuthMessage(message) {
    authMessage.textContent = message;
}

function readUsers() {
    const stored = localStorage.getItem(USERS_KEY);
    if (stored === null) return [];
    const users = JSON.parse(stored);
    if (!Array.isArray(users)) throw new Error("Saved account data is invalid.");
    return users;
}

async function hashPassword(password) {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error("Password protection is unavailable in this browser. Open this page in a supported browser.");
    }
    const bytes = new TextEncoder().encode(password);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function showApp(username) {
    authShell.hidden = true;
    appContainer.hidden = false;
    document.getElementById("activeUsername").textContent = username;
    const isAdmin = username === ADMIN_USERNAME;
    document.getElementById("showAdminPage").hidden = !isAdmin;
    showPage("estimate");
    updateConnectionStatus();
    syncPendingEstimates();
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
            estimate.syncStatus = "unconfigured";
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
    setAuthMessage("");
}

function renderAccounts() {
    const list = document.getElementById("accountList");
    list.replaceChildren();
    try {
        const users = readUsers().filter(user => user.username !== ADMIN_USERNAME);
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
            status.textContent = user.status === "approved" ? "Active" : "Pending";
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
        list.textContent = `Could not load accounts: ${error.message}`;
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
        const users = readUsers();
        const user = users.find(item => item.username === username);
        if (!user) {
            document.getElementById("adminMessage").textContent = "That account no longer exists.";
            renderAccounts();
            return;
        }
        user.passwordHash = await hashPassword(password);
        user.status = "approved";
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
        document.getElementById("adminMessage").textContent = `${username}'s password was updated.`;
        renderAccounts();
    } catch (error) {
        document.getElementById("adminMessage").textContent = `Could not update the password: ${error.message}`;
    }
}

function deleteUser(username) {
    if (!isAdminSession()) return;
    if (!window.confirm(`Delete the account "${username}"? This cannot be undone.`)) return;
    try {
        const users = readUsers().filter(user => user.username !== username);
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
        document.getElementById("adminMessage").textContent = `${username}'s account was deleted.`;
        renderAccounts();
    } catch (error) {
        document.getElementById("adminMessage").textContent = `Could not delete the account: ${error.message}`;
    }
}

document.getElementById("showEstimatePage").addEventListener("click", () => showPage("estimate"));
document.getElementById("showHistoryPage").addEventListener("click", () => showPage("history"));
document.getElementById("showAdminPage").addEventListener("click", () => showPage("admin"));

document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("loginUsername").value.trim().toLowerCase();
    const password = document.getElementById("loginPassword").value;
    const remember = document.getElementById("rememberMe").checked;
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setAuthMessage("Checking sign-in details...");
    try {
        localStorage.removeItem(REMEMBERED_USER_KEY);
        localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
        const passwordHash = await hashPassword(password);
        const isAdmin = username === ADMIN_USERNAME && passwordHash === ADMIN_PASSWORD_HASH;
        const users = readUsers();
        const user = users.find(item => item.username === username);
        if (username === ADMIN_USERNAME && !isAdmin) {
            setAuthMessage("Incorrect password for the admin username.");
            return;
        }
        if (!isAdmin && !user) {
            setAuthMessage("Username not found on this website. Ask the admin to create an account for this published site.");
            return;
        }
        if (!isAdmin && user.passwordHash !== passwordHash) {
            setAuthMessage("Incorrect password for this username.");
            return;
        }
        if (!isAdmin && user.status !== "approved") {
            setAuthMessage("This account is not active. Ask the admin to set or reset its password.");
            return;
        }

        const signedInUsername = isAdmin ? ADMIN_USERNAME : user.username;
        sessionStorage.setItem(ACTIVE_USER_KEY, signedInUsername);
        if (remember) {
            localStorage.setItem(REMEMBERED_USER_KEY, signedInUsername);
            localStorage.setItem(REMEMBERED_CREDENTIAL_KEY, JSON.stringify({
                username: signedInUsername,
                passwordHash
            }));
        } else {
            localStorage.removeItem(REMEMBERED_USER_KEY);
            localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
        }
        document.getElementById("loginPassword").value = "";
        showApp(signedInUsername);
    } catch (error) {
        setAuthMessage(`Sign-in could not be checked: ${error.message}`);
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
    try {
        const users = readUsers();
        if (users.some(user => user.username === username)) {
            document.getElementById("adminMessage").textContent = "That username already exists.";
            return;
        }
        const passwordHash = await hashPassword(password);
        users.push({ username, passwordHash, status: "approved" });
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
        document.getElementById("createUserForm").reset();
        document.getElementById("adminMessage").textContent = `${username}'s account was created.`;
        renderAccounts();
    } catch (error) {
        document.getElementById("adminMessage").textContent = `Could not create the account: ${error.message}`;
    }
});

document.getElementById("logoutBtn").addEventListener("click", showLogin);

function updateConnectionStatus() {
    const indicator = document.getElementById("connectionStatus");
    const online = navigator.onLine;
    indicator.textContent = online ? "Connection: Online" : "Connection: Offline";
    indicator.classList.toggle("online", online);
    indicator.classList.toggle("offline", !online);
}

function getCloudUrl() {
    return localStorage.getItem(CLOUD_URL_KEY) || "";
}

function updateHistoryStatus(estimateId, status, details = {}) {
    const estimates = readEstimates();
    const estimate = estimates.find(item => item.id === estimateId);
    if (!estimate) return;
    estimate.syncStatus = status;
    if (status !== "synced") {
        delete estimate.cloudFileId;
        delete estimate.cloudUrl;
    }
    Object.assign(estimate, details);
    writeEstimates(estimates);
    if (!document.getElementById("historyPage").hidden) renderHistory();
}

function submitCloudOperation(payload) {
    return new Promise((resolve, reject) => {
        const endpoint = getCloudUrl();
        if (!endpoint) {
            reject(new Error("Google Drive sync is not configured."));
            return;
        }
        const frame = document.getElementById("syncFrame");
        const form = document.createElement("form");
        const field = document.createElement("input");
        form.method = "post";
        form.action = endpoint;
        form.target = frame.name;
        form.hidden = true;
        field.type = "hidden";
        field.name = "payload";
        field.value = JSON.stringify(payload);
        form.appendChild(field);
        document.body.appendChild(form);

        const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error("Drive sync timed out. Check the Apps Script deployment and try again."));
        }, 30000);
        function cleanup() {
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            form.remove();
        }
        function onMessage(event) {
            if (event.source !== frame.contentWindow || !event.data || event.data.type !== "rld-drive-result") return;
            cleanup();
            if (event.data.success) resolve(event.data);
            else reject(new Error(event.data.error || "The Drive script could not save the estimate."));
        }
        window.addEventListener("message", onMessage);
        form.submit();
    });
}

async function syncEstimate(estimate) {
    if (!getCloudUrl()) {
        updateHistoryStatus(estimate.id, "unconfigured");
        return;
    }
    if (!navigator.onLine) {
        updateHistoryStatus(estimate.id, estimate.deleted ? "offline-delete" : "offline");
        return;
    }
    updateHistoryStatus(estimate.id, estimate.deleted ? "deleting" : "syncing");
    try {
        const result = await submitCloudOperation(estimate.deleted
            ? { action: "delete", id: estimate.id }
            : { action: "save", record: estimate });
        if (estimate.deleted) {
            writeEstimates(readEstimates().filter(item => item.id !== estimate.id));
            if (!document.getElementById("historyPage").hidden) renderHistory();
            return;
        }
        updateHistoryStatus(estimate.id, "synced", {
            cloudFileId: result.fileId,
            cloudUrl: result.fileUrl,
            cloudUpdatedAt: result.updatedAt
        });
    } catch (error) {
        updateHistoryStatus(estimate.id, navigator.onLine ? "error" : "offline", { syncError: error.message });
    }
}

function syncPendingEstimates() {
    if (!getCloudUrl()) {
        try {
            const estimates = readEstimates();
            estimates.forEach(estimate => {
                if (estimate.syncStatus !== "synced" && estimate.syncStatus !== "error") {
                    estimate.syncStatus = "unconfigured";
                }
            });
            writeEstimates(estimates);
            if (!document.getElementById("historyPage").hidden) renderHistory();
        } catch (error) {
            document.getElementById("historyMessage").textContent = `Could not update sync status: ${error.message}`;
        }
        return;
    }
    if (!navigator.onLine) {
        try {
            const estimates = readEstimates();
            estimates.forEach(estimate => {
                if (estimate.syncStatus !== "synced" && estimate.syncStatus !== "error") {
                    estimate.syncStatus = estimate.deleted ? "offline-delete" : "offline";
                }
            });
            writeEstimates(estimates);
            if (!document.getElementById("historyPage").hidden) renderHistory();
        } catch (error) {
            document.getElementById("historyMessage").textContent = `Could not update sync status: ${error.message}`;
        }
        updateConnectionStatus();
        return;
    }
    if (syncQueueRunning) {
        updateConnectionStatus();
        return;
    }
    let estimates;
    try {
        estimates = readEstimates();
    } catch (error) {
        document.getElementById("historyMessage").textContent = `Could not read local history: ${error.message}`;
        return;
    }
    syncQueueRunning = true;
    (async () => {
        try {
            for (const estimate of estimates.filter(item =>
                (item.deleted || item.syncStatus !== "synced") &&
                !["syncing", "deleting", "error"].includes(item.syncStatus))) {
                await syncEstimate(estimate);
            }
        } finally {
            syncQueueRunning = false;
            try {
                if (readEstimates().some(item =>
                    (item.syncStatus === "pending" || item.syncStatus === "offline" ||
                        item.syncStatus === "offline-delete") &&
                    !["syncing", "deleting"].includes(item.syncStatus))) {
                    syncPendingEstimates();
                }
            } catch (error) {
                document.getElementById("historyMessage").textContent = `Could not queue Drive sync: ${error.message}`;
            }
        }
    })();
}

function getHistoryTitle(estimate) {
    return estimate.data.clientName || estimate.data.fileSuffix || "Untitled estimate";
}

function getStatusLabel(estimate) {
    switch (estimate.syncStatus) {
        case "synced": return ["Synced to Drive", "synced"];
        case "syncing": return ["Syncing...", "syncing"];
        case "offline":
        case "offline-delete": return ["Not synced — offline", "offline"];
        case "deleting": return ["Removing from Drive...", "syncing"];
        case "error": return [estimate.deleted ? "Delete failed" : "Sync failed", "error"];
        default: return ["Not synced — configure Drive", "unconfigured"];
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
        if (estimate.cloudUrl) {
            const open = document.createElement("a");
            open.className = "request-button history-action";
            open.href = estimate.cloudUrl;
            open.target = "_blank";
            open.rel = "noopener";
            open.textContent = "Open in Drive";
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
    if (!navigator.onLine || !getCloudUrl()) {
        syncPendingEstimates();
        return;
    }
    const callbackName = `rldHistory_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => finish(new Error("Could not reach Google Drive.")), 15000);
    function finish(error, records) {
        window.clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
        if (error) {
            document.getElementById("historyMessage").textContent = `${error.message} Showing this device's saved history.`;
            return;
        }
        try {
            const estimates = readEstimates();
            records.forEach(record => {
                const existingIndex = estimates.findIndex(item => item.id === record.id);
                const cloudRecord = { ...record, cloudUpdatedAt: record.updatedAt, syncStatus: "synced" };
                if (existingIndex < 0) estimates.push(cloudRecord);
                else if (!estimates[existingIndex].deleted && estimates[existingIndex].syncStatus === "synced" &&
                    new Date(record.updatedAt) > new Date(estimates[existingIndex].cloudUpdatedAt ||
                        estimates[existingIndex].updatedAt || estimates[existingIndex].savedAt)) {
                    estimates[existingIndex] = cloudRecord;
                }
            });
            writeEstimates(estimates);
            renderHistory();
            syncPendingEstimates();
        } catch (loadError) {
            document.getElementById("historyMessage").textContent = `Could not merge Drive history: ${loadError.message}`;
        }
    }
    window[callbackName] = response => {
        if (!response || !response.success) finish(new Error(response && response.error || "Drive history could not be loaded."));
        else finish(null, response.records || []);
    };
    script.onerror = () => finish(new Error("Could not reach Google Drive."));
    script.src = `${getCloudUrl()}?action=list&callback=${encodeURIComponent(callbackName)}&t=${Date.now()}`;
    document.body.appendChild(script);
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
    if (!window.confirm(`Delete "${getHistoryTitle(estimate)}" from history and Drive?`)) return;
    try {
        const estimates = readEstimates();
        const existing = estimates.find(item => item.id === estimate.id);
        if (!existing) return;
        existing.deleted = true;
        existing.syncStatus = "offline-delete";
        writeEstimates(estimates);
        renderHistory();
        if (getCloudUrl() && navigator.onLine) syncPendingEstimates();
    } catch (error) {
        document.getElementById("historyMessage").textContent = `Could not delete estimate: ${error.message}`;
    }
}

document.getElementById("cloudScriptUrl").value = getCloudUrl();
document.getElementById("cloudSettingsForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!isAdminSession()) return;
    const url = document.getElementById("cloudScriptUrl").value.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
        document.getElementById("cloudSettingsMessage").textContent = "Enter a deployed Google Apps Script web-app URL ending in /exec.";
        return;
    }
    localStorage.setItem(CLOUD_URL_KEY, url);
    document.getElementById("cloudSettingsMessage").textContent = url
        ? "Drive sync URL saved. Pending estimates will sync when online."
        : "Drive sync URL removed. Estimates will remain saved on this device.";
    syncPendingEstimates();
});

window.addEventListener("online", () => {
    updateConnectionStatus();
    syncPendingEstimates();
});
window.addEventListener("offline", () => {
    updateConnectionStatus();
    syncPendingEstimates();
});
updateConnectionStatus();

try {
    const rememberedUsername = localStorage.getItem(REMEMBERED_USER_KEY);
    if (rememberedUsername) {
        document.getElementById("loginUsername").value = rememberedUsername;
        document.getElementById("rememberMe").checked = true;
    }
    const rememberedCredential = localStorage.getItem(REMEMBERED_CREDENTIAL_KEY);
    if (rememberedCredential) {
        const credential = JSON.parse(rememberedCredential);
        const users = readUsers();
        const rememberedUser = users.find(user => user.username === credential.username);
        const isRememberedAdmin = credential.username === ADMIN_USERNAME &&
            credential.passwordHash === ADMIN_PASSWORD_HASH;
        const isRememberedUser = rememberedUser &&
            rememberedUser.status === "approved" &&
            rememberedUser.passwordHash === credential.passwordHash;
        if (isRememberedAdmin || isRememberedUser) {
            sessionStorage.setItem(ACTIVE_USER_KEY, credential.username);
            showApp(credential.username);
        } else {
            localStorage.removeItem(REMEMBERED_CREDENTIAL_KEY);
            localStorage.removeItem(REMEMBERED_USER_KEY);
        }
    }
    const activeUsername = sessionStorage.getItem(ACTIVE_USER_KEY);
    if (appContainer.hidden && (activeUsername === ADMIN_USERNAME || readUsers().some(user =>
        user.username === activeUsername && user.status === "approved"))) {
        showApp(activeUsername);
    }
} catch (error) {
    setAuthMessage(`Local account storage is unavailable: ${error.message}`);
}

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
            syncStatus: getCloudUrl() ? (navigator.onLine ? "pending" : "offline") : "unconfigured",
            deleted: false
        };
        const index = estimates.findIndex(item => item.id === estimate.id);
        if (index < 0) estimates.push(estimate);
        else estimates[index] = estimate;
        writeEstimates(estimates);

        editingEstimateId = null;
        this.textContent = "SAVE";
        document.getElementById("historyMessage").textContent = getCloudUrl()
            ? "Saved locally. Drive sync is starting."
            : "Saved locally. Configure the Apps Script URL in Manage accounts to sync with Drive.";
        syncPendingEstimates();
        if (!document.getElementById("historyPage").hidden) renderHistory();
    } catch (error) {
        alert(`Could not save this estimate: ${error.message}`);
    }
});