/**
 * Persistence, locking, cache-backed polling, station presence, and Google Sheet logging
 * for ARMMC Pharmacy Queue.
 */

var STATE_PROP_KEY = "ARMMC_PHARMACY_QUEUE_STATE_V1";
var STATE_CACHE_KEY = "ARMMC_PHARMACY_QUEUE_STATE_V1";
var STATE_CACHE_TTL_SEC = 21600; // 6 hours
var PRESENCE_TTL_SEC = 60;
var PRESENCE_STALE_MS = 45000;
var PRESENCE_KEYS = ["PRES_display", "PRES_c1", "PRES_c2", "PRES_c3", "PRES_c4"];
var CALL_LOG_HEADERS = [
  "Date",
  "Ticket #",
  "Counter ID",
  "Counter",
  "Call Type",
  "Called At (PHT)",
  "Completed At (PHT)",
  "Outcome",
  "Recalls"
];

/** Returns today's business date in Asia/Manila as YYYY-MM-DD. */
function getManilaDateString_() {
  return Utilities.formatDate(new Date(), "Asia/Manila", "yyyy-MM-dd");
}

/** Returns current UTC ISO timestamp string. */
function getNowIso_() {
  return new Date().toISOString();
}

/** Formats an ISO timestamp into Asia/Manila YYYY-MM-DD HH:mm:ss string. */
function formatPhtTimestamp_(isoStr) {
  if (!isoStr) return "";
  var dt = new Date(isoStr);
  if (isNaN(dt.getTime())) return String(isoStr);
  return Utilities.formatDate(dt, "Asia/Manila", "yyyy-MM-dd HH:mm:ss");
}

/** Ensures state JSON stays comfortably below PropertiesService's 9 KB per-property limit. */
function compactStateForProperties_(state) {
  var json = JSON.stringify(state);
  if (json.length <= 8200) return json;

  var copy = cloneData_(state);
  while (copy.recentLogEntries.length > 10 && JSON.stringify(copy).length > 8200) {
    copy.recentLogEntries.pop();
  }
  while (copy.missedTickets.length > 15 && JSON.stringify(copy).length > 8200) {
    copy.missedTickets.pop();
  }
  while (copy.recentCalls.length > 5 && JSON.stringify(copy).length > 8200) {
    copy.recentCalls.pop();
  }
  return JSON.stringify(copy);
}

/** Reads authoritative state from PropertiesService, initializing if empty or rolling business date. */
function readStateFromProperties_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(STATE_PROP_KEY);
  var nowIso = getNowIso_();
  var bizDate = getManilaDateString_();
  var state;

  if (!raw) {
    state = createInitialState(nowIso, bizDate);
    var json = compactStateForProperties_(state);
    props.setProperty(STATE_PROP_KEY, json);
    CacheService.getScriptCache().put(STATE_CACHE_KEY, json, STATE_CACHE_TTL_SEC);
    return state;
  }

  state = JSON.parse(raw);
  ensureBusinessDate_(state, bizDate);
  return state;
}

/** Fast read path for polling: reads CacheService first, falling back to PropertiesService on cache miss. */
function readStateFast_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(STATE_CACHE_KEY);
  var bizDate = getManilaDateString_();
  var state;

  if (cached) {
    try {
      state = JSON.parse(cached);
      var prevDate = state.todayStats ? state.todayStats.businessDate : "";
      ensureBusinessDate_(state, bizDate);
      if (prevDate !== bizDate) {
        cache.put(STATE_CACHE_KEY, compactStateForProperties_(state), STATE_CACHE_TTL_SEC);
      }
      return state;
    } catch (err) {
      // Fall through to PropertiesService if cache payload was malformed.
    }
  }

  state = readStateFromProperties_();
  cache.put(STATE_CACHE_KEY, compactStateForProperties_(state), STATE_CACHE_TTL_SEC);
  return state;
}

/** Serializes state mutations across concurrent counter clicks using ScriptLock. */
function withStateLock_(mutatorFn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var result;
  try {
    var state = readStateFromProperties_();
    var nowIso = getNowIso_();
    var bizDate = getManilaDateString_();
    result = mutatorFn(state, nowIso, bizDate);
    var json = compactStateForProperties_(result.state);
    PropertiesService.getScriptProperties().setProperty(STATE_PROP_KEY, json);
    CacheService.getScriptCache().put(STATE_CACHE_KEY, json, STATE_CACHE_TTL_SEC);
  } finally {
    lock.releaseLock();
  }

  // Persist Sheet logs outside the critical state lock so Sheets latency never blocks other counters.
  if (result && result.logEvents && result.logEvents.length > 0) {
    appendSheetLogsSafe_(result.logEvents);
  }
  return result;
}

/** Maps stationInfo { role, counterId, tabId } to its dedicated CacheService presence key. */
function getPresenceCacheKey_(stationInfo) {
  if (!stationInfo || !stationInfo.tabId) return null;
  if (stationInfo.role === "display") return "PRES_display";
  if (stationInfo.role === "counter") {
    var cid = parseInt(stationInfo.counterId, 10);
    if (cid >= 1 && cid <= 4) return "PRES_c" + cid;
  }
  return null;
}

/** Parses, prunes stale tabs, and optionally inserts current tab heartbeat for one station key. */
function prunePresenceMap_(rawJson, nowMs, activeTabId) {
  var map = {};
  if (rawJson) {
    try {
      var parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object") {
        for (var k in parsed) {
          if (Object.prototype.hasOwnProperty.call(parsed, k)) {
            var ts = Number(parsed[k]);
            if (!isNaN(ts) && nowMs - ts <= PRESENCE_STALE_MS) {
              map[k] = ts;
            }
          }
        }
      }
    } catch (err) {
      map = {};
    }
  }
  if (activeTabId) {
    map[String(activeTabId).slice(0, 64)] = nowMs;
  }
  return map;
}

/** Updates caller's station heartbeat and batch-reads all 5 station presence statuses. */
function recordAndReadPresence_(stationInfo) {
  var cache = CacheService.getScriptCache();
  var nowMs = Date.now();
  var myKey = getPresenceCacheKey_(stationInfo);

  if (myKey) {
    var existing = cache.get(myKey);
    var updated = prunePresenceMap_(existing, nowMs, stationInfo.tabId);
    cache.put(myKey, JSON.stringify(updated), PRESENCE_TTL_SEC);
  }

  var allRaw = cache.getAll(PRESENCE_KEYS);
  function toStatus(key) {
    var map = prunePresenceMap_(allRaw[key], nowMs, null);
    var count = Object.keys(map).length;
    return { online: count > 0, tabCount: count };
  }

  return {
    display: toStatus("PRES_display"),
    counters: {
      "1": toStatus("PRES_c1"),
      "2": toStatus("PRES_c2"),
      "3": toStatus("PRES_c3"),
      "4": toStatus("PRES_c4")
    }
  };
}

/** Returns bound Spreadsheet URL or empty string if running standalone. */
function getBoundSheetUrl_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    return ss ? ss.getUrl() : "";
  } catch (err) {
    return "";
  }
}

/** Ensures Call_Log and Daily_Summary sheets exist and are styled cleanly. */
function setupSheets() {
  var ss;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    return null;
  }
  if (!ss) return null;

  var logSheet = ss.getSheetByName("Call_Log");
  if (!logSheet) {
    logSheet = ss.insertSheet("Call_Log");
  }
  if (logSheet.getLastRow() === 0) {
    logSheet.getRange(1, 1, 1, CALL_LOG_HEADERS.length).setValues([CALL_LOG_HEADERS]);
    var headerRange = logSheet.getRange(1, 1, 1, CALL_LOG_HEADERS.length);
    headerRange.setBackground("#162A6E");
    headerRange.setFontColor("#FFFFFF");
    headerRange.setFontWeight("bold");
    logSheet.setFrozenRows(1);
    logSheet.getRange("A:B").setNumberFormat("@");
    logSheet.getRange("F:G").setNumberFormat("@");
    logSheet.setColumnWidth(1, 110);
    logSheet.setColumnWidth(2, 95);
    logSheet.setColumnWidth(3, 95);
    logSheet.setColumnWidth(4, 125);
    logSheet.setColumnWidth(5, 130);
    logSheet.setColumnWidth(6, 170);
    logSheet.setColumnWidth(7, 170);
    logSheet.setColumnWidth(8, 120);
    logSheet.setColumnWidth(9, 85);
  }

  var sumSheet = ss.getSheetByName("Daily_Summary");
  if (!sumSheet) {
    sumSheet = ss.insertSheet("Daily_Summary");
  }
  if (sumSheet.getLastRow() === 0) {
    var rows = [
      ["ARMMC Pharmacy — Dispensing Area Daily Summary", "", ""],
      ["Today's Business Date (PHT)", '=TEXT(TODAY(),"yyyy-mm-dd")', ""],
      ["Metric", "Count", "Notes"],
      ["Total Calls Today", "=COUNTIF(Call_Log!A:A, B2)", "All calls issued today"],
      ["Completed / Served", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!H:H, "COMPLETED")', "Physical cards returned"],
      ["Currently Serving", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!H:H, "SERVING")', "Active at counters"],
      ["No-Show", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!H:H, "NO_SHOW")', "Moved to Missed list"],
      ["", "", ""],
      ["Per-Counter Completed Today", "Served Count", "Total Calls"],
      ["Counter 1", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 1, Call_Log!H:H, "COMPLETED")', "=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 1)"],
      ["Counter 2", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 2, Call_Log!H:H, "COMPLETED")', "=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 2)"],
      ["Counter 3", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 3, Call_Log!H:H, "COMPLETED")', "=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 3)"],
      ["Counter 4", '=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 4, Call_Log!H:H, "COMPLETED")', "=COUNTIFS(Call_Log!A:A, B2, Call_Log!C:C, 4)"]
    ];
    sumSheet.getRange(1, 1, rows.length, 3).setValues(rows);
    sumSheet.getRange("A1:C1").merge().setBackground("#162A6E").setFontColor("#FFFFFF").setFontWeight("bold").setFontSize(12);
    sumSheet.getRange("A3:C3").setBackground("#E2E8F0").setFontWeight("bold");
    sumSheet.getRange("A9:C9").setBackground("#E2E8F0").setFontWeight("bold");
    sumSheet.getRange("B2").setNumberFormat("@");
    sumSheet.setColumnWidth(1, 240);
    sumSheet.setColumnWidth(2, 140);
    sumSheet.setColumnWidth(3, 220);
  }

  return logSheet;
}

/** Finds a matching open row near the bottom of Call_Log for updates (RECALL / FINALIZE). */
function findMatchingLogRow_(logSheet, ticketFormatted, ticketRaw, counterId, calledAtPht) {
  var lastRow = logSheet.getLastRow();
  if (lastRow <= 1) return -1;
  var scanCount = Math.min(50, lastRow - 1);
  var startRow = lastRow - scanCount + 1;
  var values = logSheet.getRange(startRow, 1, scanCount, CALL_LOG_HEADERS.length).getValues();

  for (var i = values.length - 1; i >= 0; i--) {
    var r = values[i];
    var rowTicket = String(r[1]);
    var rowCounterId = parseInt(r[2], 10);
    var rowCalledAt = String(r[5]);
    if (
      (rowTicket === String(ticketFormatted) || rowTicket === String(ticketRaw)) &&
      rowCounterId === parseInt(counterId, 10) &&
      rowCalledAt === calledAtPht
    ) {
      return startRow + i;
    }
  }
  return -1;
}

/** Safely writes Call_Log mutations to Google Sheets without ever breaking the live queue on Sheet errors. */
function appendSheetLogsSafe_(logEvents) {
  try {
    var logSheet = setupSheets();
    if (!logSheet) return;

    for (var i = 0; i < logEvents.length; i++) {
      var ev = logEvents[i];
      var calledPht = formatPhtTimestamp_(ev.calledAt);
      var completedPht = formatPhtTimestamp_(ev.completedAt);

      if (ev.action === "INSERT") {
        logSheet.appendRow([
          ev.businessDate,
          ev.formattedNumber || String(ev.ticketNumber),
          ev.counterId,
          ev.counterLabel,
          ev.callType,
          calledPht,
          "",
          "SERVING",
          0
        ]);
      } else if (ev.action === "RECALL") {
        var recallRow = findMatchingLogRow_(logSheet, ev.formattedNumber, ev.ticketNumber, ev.counterId, calledPht);
        if (recallRow > 1) {
          logSheet.getRange(recallRow, 9).setValue(ev.recallCount);
        }
      } else if (ev.action === "FINALIZE") {
        var finRow = findMatchingLogRow_(logSheet, ev.formattedNumber, ev.ticketNumber, ev.counterId, calledPht);
        if (finRow > 1) {
          logSheet.getRange(finRow, 7, 1, 3).setValues([[completedPht, ev.outcome, ev.recallCount || 0]]);
        } else {
          logSheet.appendRow([
            ev.businessDate,
            ev.formattedNumber || String(ev.ticketNumber),
            ev.counterId,
            ev.counterLabel,
            ev.callType,
            calledPht,
            completedPht,
            ev.outcome,
            ev.recallCount || 0
          ]);
        }
      }
    }
  } catch (err) {
    Logger.log("appendSheetLogsSafe_ warning: " + err);
  }
}

/** Reads daily logs from Call_Log (or fallback recentLogEntries) and builds a CSV export string. */
function getDailyLogsForCsv_(businessDate, state) {
  var targetDate = businessDate || getManilaDateString_();
  var rows = [];

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss ? ss.getSheetByName("Call_Log") : null;
    if (logSheet && logSheet.getLastRow() > 1) {
      var data = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, CALL_LOG_HEADERS.length).getValues();
      for (var i = 0; i < data.length; i++) {
        var r = data[i];
        var dStr = String(r[0]);
        if (dStr === targetDate) {
          rows.push({
            businessDate: dStr,
            formattedNumber: String(r[1]),
            counterId: r[2],
            counterLabel: String(r[3]),
            callType: String(r[4]),
            calledAt: String(r[5]),
            completedAt: String(r[6]),
            outcome: String(r[7]),
            recallCount: r[8]
          });
        }
      }
      return buildDailyCsv(rows);
    }
  } catch (err) {
    Logger.log("getDailyLogsForCsv_ Sheet read fallback: " + err);
  }

  var entries = (state && Array.isArray(state.recentLogEntries)) ? state.recentLogEntries : [];
  for (var j = 0; j < entries.length; j++) {
    if (entries[j].businessDate === targetDate) {
      rows.push({
        businessDate: entries[j].businessDate,
        formattedNumber: entries[j].formattedNumber,
        counterId: entries[j].counterId,
        counterLabel: entries[j].counterLabel,
        callType: entries[j].callType,
        calledAt: formatPhtTimestamp_(entries[j].calledAt),
        completedAt: formatPhtTimestamp_(entries[j].completedAt),
        outcome: entries[j].outcome,
        recallCount: entries[j].recallCount
      });
    }
  }
  return buildDailyCsv(rows);
}
