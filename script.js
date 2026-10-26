// script.js
const USERS_KEY = "rld.users.v1";
const ACTIVE_USER_KEY = "rld.activeUser";
const REMEMBERED_USER_KEY = "rld.rememberedUser";
const ESTIMATES_KEY = "rld.estimates.v1";
const ADMIN_USERNAME = "rld";
const ADMIN_PASSWORD_HASH = "662e0514c2fd58527dca88e2d8b5776efa997e2f81d2cc09bf402c69a4e68efc";

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
    document.getElementById("adminPanel").hidden = !isAdmin;
    if (isAdmin) renderSignupRequests();
}

function showLogin() {
    authShell.hidden = false;
    appContainer.hidden = true;
    sessionStorage.removeItem(ACTIVE_USER_KEY);
    setAuthMessage("");
}

function renderSignupRequests() {
    const requests = document.getElementById("signupRequests");
    requests.replaceChildren();
    let users;
    try {
        users = readUsers();
    } catch (error) {
        requests.textContent = `Could not load sign-up requests: ${error.message}`;
        return;
    }
    const pendingUsers = users.filter(user => user.status === "pending");
    if (pendingUsers.length === 0) {
        requests.textContent = "No pending sign-up requests.";
        return;
    }

    pendingUsers.forEach(user => {
        const row = document.createElement("div");
        row.className = "request-row";
        const username = document.createElement("strong");
        username.textContent = user.username;
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "request-button approve-button";
        approve.textContent = "Approve";
        approve.addEventListener("click", () => updateSignupRequest(user.username, "approved"));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "request-button reject-button";
        reject.textContent = "Reject";
        reject.addEventListener("click", () => updateSignupRequest(user.username, "rejected"));
        row.append(username, approve, reject);
        requests.appendChild(row);
    });
}

function updateSignupRequest(username, status) {
    try {
        const users = readUsers();
        const user = users.find(item => item.username === username && item.status === "pending");
        if (!user) {
            document.getElementById("adminMessage").textContent = "That request is no longer pending.";
            renderSignupRequests();
            return;
        }
        if (status === "approved") {
            user.status = "approved";
            localStorage.setItem(USERS_KEY, JSON.stringify(users));
            document.getElementById("adminMessage").textContent = `${username} was approved.`;
        } else {
            localStorage.setItem(USERS_KEY, JSON.stringify(users.filter(item => item.username !== username)));
            document.getElementById("adminMessage").textContent = `${username}'s request was rejected.`;
        }
        renderSignupRequests();
    } catch (error) {
        document.getElementById("adminMessage").textContent = `Could not update the request: ${error.message}`;
    }
}

document.getElementById("showSignup").addEventListener("click", () => {
    document.getElementById("loginForm").hidden = true;
    document.getElementById("signupForm").hidden = false;
    setAuthMessage("");
});

document.getElementById("showLogin").addEventListener("click", () => {
    document.getElementById("signupForm").hidden = true;
    document.getElementById("loginForm").hidden = false;
    setAuthMessage("");
});

document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("loginUsername").value.trim().toLowerCase();
    const password = document.getElementById("loginPassword").value;
    const remember = document.getElementById("rememberUsername").checked;
    try {
        const passwordHash = await hashPassword(password);
        const isAdmin = username === ADMIN_USERNAME && passwordHash === ADMIN_PASSWORD_HASH;
        const user = readUsers().find(item => item.username === username);
        if (isAdmin) {
            sessionStorage.setItem(ACTIVE_USER_KEY, ADMIN_USERNAME);
        } else if (!user || user.passwordHash !== passwordHash) {
            setAuthMessage("Incorrect username or password.");
            return;
        } else if (user.status !== "approved") {
            setAuthMessage("Your sign-up request is still waiting for admin approval.");
            return;
        } else {
            sessionStorage.setItem(ACTIVE_USER_KEY, user.username);
        }

        if (remember) localStorage.setItem(REMEMBERED_USER_KEY, username);
        else localStorage.removeItem(REMEMBERED_USER_KEY);
        document.getElementById("loginPassword").value = "";
        showApp(isAdmin ? ADMIN_USERNAME : user.username);
    } catch (error) {
        setAuthMessage(`Sign-in failed: ${error.message}`);
    }
});

document.getElementById("signupForm").addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("signupUsername").value.trim().toLowerCase();
    const password = document.getElementById("signupPassword").value;
    const confirmPassword = document.getElementById("signupConfirmPassword").value;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        setAuthMessage("Use 3-30 characters: lowercase letters, numbers, dots, underscores, or hyphens.");
        return;
    }
    if (username === ADMIN_USERNAME) {
        setAuthMessage("That username is reserved.");
        return;
    }
    if (password !== confirmPassword) {
        setAuthMessage("The passwords do not match.");
        return;
    }
    try {
        const users = readUsers();
        if (users.some(user => user.username === username)) {
            setAuthMessage("That username already has an account or request.");
            return;
        }
        const passwordHash = await hashPassword(password);
        users.push({ username, passwordHash, status: "pending" });
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
        document.getElementById("signupForm").reset();
        document.getElementById("signupForm").hidden = true;
        document.getElementById("loginForm").hidden = false;
        setAuthMessage("Sign-up request sent. The admin must approve it before you can sign in.");
    } catch (error) {
        setAuthMessage(`Could not submit your request: ${error.message}`);
    }
});

document.getElementById("logoutBtn").addEventListener("click", showLogin);

try {
    const rememberedUsername = localStorage.getItem(REMEMBERED_USER_KEY);
    if (rememberedUsername) {
        document.getElementById("loginUsername").value = rememberedUsername;
        document.getElementById("rememberUsername").checked = true;
    }
    const activeUsername = sessionStorage.getItem(ACTIVE_USER_KEY);
    if (activeUsername === ADMIN_USERNAME || readUsers().some(user =>
        user.username === activeUsername && user.status === "approved")) {
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

        const bundleLabor = document.getElementById('bundleLabor').checked;
        if (!bundleLabor || isPartsSection || rowsToMerge.length < 2) return;

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

// --- SAVE DATA OFFLINE ---
document.getElementById('saveBtn').addEventListener('click', function() {
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

    try {
        const saved = localStorage.getItem(ESTIMATES_KEY);
        const estimates = saved === null ? [] : JSON.parse(saved);
        if (!Array.isArray(estimates)) throw new Error("Saved estimate data is invalid.");
        estimates.push({
            savedAt: new Date().toISOString(),
            username: sessionStorage.getItem(ACTIVE_USER_KEY),
            data
        });
        localStorage.setItem(ESTIMATES_KEY, JSON.stringify(estimates));
        alert("Estimate saved in this browser on this device.");
    } catch (error) {
        alert(`Could not save this estimate offline: ${error.message}`);
    }
});