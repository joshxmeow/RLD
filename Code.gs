const DRIVE_FOLDER_NAME = "RLD Job Estimates";
const INDEX_SHEET_NAME = "Estimate Index";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function setup() {
  getDriveFolder_();
  getIndexSheet_();
}

function doGet(event) {
  const callback = event.parameter.callback || "";
  if (!/^[A-Za-z_$][\w$.]*$/.test(callback)) {
    return ContentService.createTextOutput("A JSONP callback is required.");
  }

  try {
    const records = readIndex_().map(row => ({
      id: row.id,
      savedAt: row.savedAt,
      updatedAt: row.updatedAt,
      username: row.username,
      data: JSON.parse(row.dataJson),
      cloudFileId: row.fileId,
      cloudUrl: row.fileUrl
    }));
    return ContentService.createTextOutput(`${callback}(${JSON.stringify({ success: true, records })});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } catch (error) {
    return ContentService.createTextOutput(`${callback}(${JSON.stringify({ success: false, error: error.message })});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
}

function doPost(event) {
  try {
    const payload = JSON.parse(event.parameter.payload || "{}");
    const result = payload.action === "delete" ? deleteEstimate_(payload.id) : saveEstimate_(payload.record);
    return postMessage_(Object.assign({ success: true }, result));
  } catch (error) {
    return postMessage_({ success: false, error: error.message });
  }
}

function saveEstimate_(record) {
  if (!record || !record.id || !record.data) throw new Error("Invalid estimate data.");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getIndexSheet_();
    const rows = readIndex_();
    const existing = rows.find(row => row.id === record.id);
    const previousFileId = existing ? existing.fileId : "";
    const file = createExcelFile_(record);
    const now = new Date().toISOString();
    const indexRow = [
      record.id,
      record.savedAt || now,
      now,
      record.username || "",
      JSON.stringify(record.data),
      file.getId(),
      file.getUrl()
    ];

    if (existing) {
      sheet.getRange(existing.rowNumber, 1, 1, indexRow.length).setValues([indexRow]);
    } else {
      sheet.appendRow(indexRow);
    }
    if (previousFileId && previousFileId !== file.getId()) {
      DriveApp.getFileById(previousFileId).setTrashed(true);
    }
    return { id: record.id, fileId: file.getId(), fileUrl: file.getUrl(), updatedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function deleteEstimate_(id) {
  if (!id) throw new Error("An estimate ID is required.");
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getIndexSheet_();
    const row = readIndex_().find(item => item.id === id);
    if (!row) return { id };
    if (row.fileId) DriveApp.getFileById(row.fileId).setTrashed(true);
    sheet.deleteRow(row.rowNumber);
    return { id };
  } finally {
    lock.releaseLock();
  }
}

function createExcelFile_(record) {
  const data = record.data;
  const title = [data.date, data.clientName, data.fileSuffix].filter(Boolean).join(" - ") || "Job Estimate";
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100);
  const temporary = SpreadsheetApp.create(safeTitle);

  try {
    const summary = temporary.getSheets()[0];
    summary.setName("Estimate");
    const fields = [
      ["Field", "Value"],
      ["Date", data.date || ""],
      ["Organization / Fleet", data.orgPrefix || ""],
      ["Client", data.clientName || ""],
      ["Address", data.address || ""],
      ["Contact", data.contact || ""],
      ["Make & Model", data.makeModel || ""],
      ["Plate No.", data.plateNo || ""],
      ["Chassis No.", data.chassisNo || ""],
      ["Engine No.", data.engineNo || ""],
      ["Color", data.color || ""],
      ["Insurance", data.insurance || ""],
      ["Job Keyword", data.fileSuffix || ""],
      ["Total Labor", data.totLabor || 0],
      ["Total Parts", data.totParts || 0],
      ["Downpayment", data.downpayment || 0],
      ["Total Amount Due", data.totDue || 0]
    ];
    summary.getRange(1, 1, fields.length, 2).setValues(fields);
    summary.getRange("A1:B1").setFontWeight("bold");
    summary.autoResizeColumns(1, 2);

    const workSheet = temporary.insertSheet("Works");
    const works = [["Description", "Cost of Labor", "Cost of Parts"]];
    (data.works || []).forEach(work => works.push([work.desc || "", Number(work.labor) || 0, Number(work.parts) || 0]));
    workSheet.getRange(1, 1, works.length, 3).setValues(works);
    workSheet.getRange("A1:C1").setFontWeight("bold");
    workSheet.autoResizeColumns(1, 3);

    const blob = Drive.Files.export(temporary.getId(), XLSX_MIME_TYPE).setName(`${safeTitle}.xlsx`);
    return getDriveFolder_().createFile(blob);
  } finally {
    DriveApp.getFileById(temporary.getId()).setTrashed(true);
  }
}

function readIndex_() {
  const sheet = getIndexSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 7).getValues().map((row, index) => ({
    id: row[0],
    savedAt: row[1],
    updatedAt: row[2],
    username: row[3],
    dataJson: row[4],
    fileId: row[5],
    fileUrl: row[6],
    rowNumber: index + 2
  }));
}

function getIndexSheet_() {
  const properties = PropertiesService.getScriptProperties();
  let spreadsheetId = properties.getProperty("RLD_INDEX_SPREADSHEET_ID");
  if (!spreadsheetId) {
    const spreadsheet = SpreadsheetApp.create("RLD Estimate Sync Index");
    spreadsheetId = spreadsheet.getId();
    DriveApp.getFileById(spreadsheetId).moveTo(getDriveFolder_());
    const sheet = spreadsheet.getSheets()[0];
    sheet.setName(INDEX_SHEET_NAME);
    sheet.appendRow(["ID", "Created", "Updated", "Username", "Estimate JSON", "Excel File ID", "Excel File URL"]);
    sheet.setFrozenRows(1);
    properties.setProperty("RLD_INDEX_SPREADSHEET_ID", spreadsheetId);
  }
  return SpreadsheetApp.openById(spreadsheetId).getSheetByName(INDEX_SHEET_NAME);
}

function getDriveFolder_() {
  const properties = PropertiesService.getScriptProperties();
  let folderId = properties.getProperty("RLD_DRIVE_FOLDER_ID");
  if (!folderId) {
    const folder = DriveApp.createFolder(DRIVE_FOLDER_NAME);
    folderId = folder.getId();
    properties.setProperty("RLD_DRIVE_FOLDER_ID", folderId);
  }
  return DriveApp.getFolderById(folderId);
}

function postMessage_(result) {
  const message = JSON.stringify(Object.assign({ type: "rld-drive-result" }, result)).replace(/</g, "\\u003c");
  return HtmlService.createHtmlOutput(`<script>window.top.postMessage(${message}, "*");</script>`);
}
