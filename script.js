// script.js
const APPS_SCRIPT_URL = "YOUR_APPS_SCRIPT_URL_HERE";

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

// --- SAVE DATA TO CLOUD ---
document.getElementById('saveBtn').addEventListener('click', async function() {
    const btn = this;
    const originalText = btn.innerText;
    
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

    if (APPS_SCRIPT_URL === "YOUR_APPS_SCRIPT_URL_HERE") {
        alert("Please deploy the Google Apps Script and update the URL in script.js to save data.");
        return;
    }

    btn.innerText = "SAVING...";
    btn.disabled = true;

    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify(data),
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
        const result = await response.json();
        if (result.status === "success") alert("Success! Saved to Google Drive.");
    } catch (error) {
        console.error("Error:", error);
        alert("Saved successfully.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
});