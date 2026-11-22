/**
 * Google Apps Script Web App entrypoint, view router, PIN verification, and RPC endpoints
 * for Amang Rodriguez Memorial Medical Center — Pharmacy Dispensing Area.
 */

/** Adds a convenience menu when attached to a Google Sheet. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("ARMMC Pharmacy Queue")
      .addItem("Initialize / Repair Log Sheets", "setupSheets")
      .addToUi();
  } catch (err) {
    // No UI context available (e.g. standalone trigger).
  }
}

/** Includes partial HTML/CSS/JS templates into HtmlTemplate pages. */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Serves Hub, Display Monitor, Counter Workbench (1..4), or Admin Console. */
function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var view = String(params.view || "hub").toLowerCase();
  var rawId = parseInt(params.id || "1", 10);
  var counterId = (!isNaN(rawId) && rawId >= 1 && rawId <= 4) ? rawId : 1;

  var templateName = "ViewHub";
  var title = "ARMMC Pharmacy — Queue Launchpad";

  if (view === "display") {
    templateName = "ViewDisplay";
    title = "ARMMC Pharmacy — Display Monitor";
  } else if (view === "counter") {
    templateName = "ViewCounter";
    title = "Counter " + counterId + " — ARMMC Pharmacy";
  } else if (view === "admin") {
    templateName = "ViewAdmin";
    title = "Admin Console — ARMMC Pharmacy";
  }

  var appUrl = "";
  try {
    appUrl = ScriptApp.getService().getUrl() || "";
  } catch (err) {
    appUrl = "";
  }

  var tpl = HtmlService.createTemplateFromFile(templateName);
  tpl.APP_URL = appUrl;
  tpl.COUNTER_ID = counterId;
  tpl.SHEET_URL = getBoundSheetUrl_();
  tpl.IS_PREVIEW = false;

  return tpl
    .evaluate()
    .setTitle(title)
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Validates Staff PIN (accepts either staffPin or adminPin). */
function requireStaffPin_(state, pin) {
  var given = String(pin === undefined || pin === null ? "" : pin).trim();
  if (!given || (given !== state.settings.staffPin && given !== state.settings.adminPin)) {
    throw new Error("UNAUTHORIZED: Invalid Staff PIN.");
  }
}

/** Validates Admin PIN strictly. */
function requireAdminPin_(state, pin) {
  var given = String(pin === undefined || pin === null ? "" : pin).trim();
  if (!given || given !== state.settings.adminPin) {
    throw new Error("UNAUTHORIZED: Invalid Admin PIN.");
  }
}

/** Formats thrown errors into clean structured RPC error objects. */
function buildErrorResponse_(err) {
  var msg = (err && err.message) ? String(err.message) : String(err || "Unknown server error.");
  var code = "INTERNAL";
  if (msg.indexOf("UNAUTHORIZED:") === 0) {
    code = "UNAUTHORIZED";
    msg = msg.replace(/^UNAUTHORIZED:\s*/, "");
  } else if (msg.indexOf("CONFLICT:") === 0) {
    code = "CONFLICT";
    msg = msg.replace(/^CONFLICT:\s*/, "");
  } else if (msg.indexOf("INVALID:") === 0) {
    code = "INVALID";
    msg = msg.replace(/^INVALID:\s*/, "");
  }
  return { ok: false, code: code, error: msg };
}

/** Executes a locked state mutation, updates presence, and returns sanitized state. */
function runLockedMutation_(stationInfo, fn) {
  try {
    var result = withStateLock_(fn);
    var presence = recordAndReadPresence_(stationInfo);
    return {
      ok: true,
      state: sanitizeClientState(result.state),
      announcement: result.announcement || null,
      presence: presence,
      serverTime: getNowIso_()
    };
  } catch (err) {
    return buildErrorResponse_(err);
  }
}

/** Returns initial full sanitized state and live station presence. */
function apiGetState(stationInfo) {
  try {
    var state = readStateFast_();
    var presence = recordAndReadPresence_(stationInfo);
    return {
      ok: true,
      state: sanitizeClientState(state),
      presence: presence,
      serverTime: getNowIso_()
    };
  } catch (err) {
    return buildErrorResponse_(err);
  }
}

/** Fast version-checked poll endpoint minimizing payload and execution time. */
function apiPollState(lastVersion, stationInfo) {
  try {
    var state = readStateFast_();
    var presence = recordAndReadPresence_(stationInfo);
    var clientVer = parseInt(lastVersion, 10);
    if (!isNaN(clientVer) && clientVer === state.version) {
      return {
        ok: true,
        changed: false,
        version: state.version,
        presence: presence,
        serverTime: getNowIso_()
      };
    }
    return {
      ok: true,
      changed: true,
      state: sanitizeClientState(state),
      presence: presence,
      serverTime: getNowIso_()
    };
  } catch (err) {
    return buildErrorResponse_(err);
  }
}

/** Verifies Staff or Admin PIN and returns sanitized state on success. */
function apiVerifyPin(role, pin) {
  try {
    var state = readStateFast_();
    if (role === "admin") {
      requireAdminPin_(state, pin);
    } else {
      requireStaffPin_(state, pin);
    }
    return {
      ok: true,
      role: role === "admin" ? "admin" : "staff",
      state: sanitizeClientState(state),
      serverTime: getNowIso_()
    };
  } catch (err) {
    return buildErrorResponse_(err);
  }
}

function apiCallNext(counterId, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso, bizDate) {
    requireStaffPin_(state, pin);
    return callNextInState(state, counterId, nowIso, bizDate);
  });
}

function apiCallSpecific(counterId, ticketNumber, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso, bizDate) {
    requireStaffPin_(state, pin);
    return callSpecificInState(state, counterId, ticketNumber, nowIso, bizDate);
  });
}

function apiRecall(counterId, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso) {
    requireStaffPin_(state, pin);
    return recallInState(state, counterId, nowIso);
  });
}

function apiComplete(counterId, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso, bizDate) {
    requireStaffPin_(state, pin);
    return completeInState(state, counterId, nowIso, bizDate);
  });
}

function apiNoShow(counterId, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso, bizDate) {
    requireStaffPin_(state, pin);
    return noShowInState(state, counterId, nowIso, bizDate);
  });
}

function apiDismissMissed(ticketNumber, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state) {
    requireStaffPin_(state, pin);
    return dismissMissedInState(state, ticketNumber);
  });
}

function apiSetCounterStatus(counterId, status, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso, bizDate) {
    requireStaffPin_(state, pin);
    return setCounterStatusInState(state, counterId, status, nowIso, bizDate);
  });
}

function apiUpdateSettings(patch, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state) {
    requireAdminPin_(state, pin);
    return updateSettingsInState(state, patch);
  });
}

function apiSetNextNumber(nextNumber, pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state) {
    requireAdminPin_(state, pin);
    return setNextNumberInState(state, nextNumber);
  });
}

function apiResetQueue(pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso, bizDate) {
    requireAdminPin_(state, pin);
    return resetQueueInState(state, nowIso, bizDate);
  });
}

function apiTestAudio(pin, stationInfo) {
  return runLockedMutation_(stationInfo, function (state, nowIso) {
    requireAdminPin_(state, pin);
    return createTestAudioAnnouncement(state, nowIso);
  });
}

function apiExportCsv(businessDate, pin) {
  try {
    var state = readStateFast_();
    requireAdminPin_(state, pin);
    var targetDate = businessDate ? String(businessDate).trim() : getManilaDateString_();
    var csv = getDailyLogsForCsv_(targetDate, state);
    return {
      ok: true,
      filename: "ARMMC_Pharmacy_Queue_" + targetDate + ".csv",
      csv: csv
    };
  } catch (err) {
    return buildErrorResponse_(err);
  }
}
