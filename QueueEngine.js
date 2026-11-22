/**
 * Pure rotating-card queuing engine for ARMMC Pharmacy (4 dispensing counters).
 * Designed for Google Apps Script V8 (global scope) and testable under Node.js.
 */

var VOICE_PRESETS = {
  en: "Number {number}, please proceed to {counter}",
  fil: "Numero {number}, pumunta po sa {counter}"
};

var DEFAULT_SETTINGS = {
  hospitalName: "Amang Rodriguez Memorial Medical Center",
  departmentSubtitle: "Department of Health • Pharmacy — Dispensing Area",
  tickerMessage: "ARMMC PHARMACY: Please prepare your prescription and hand over your physical queue number card when called. / Pakihanda ang inyong reseta at ibigay ang inyong queue number card sa parmasyutiko pagkatawag. Maraming salamat po!",
  customLogoUrl: "",
  minNumber: 1,
  maxNumber: 100,
  padDigits: 3,
  displayTheme: "light",
  flashSeconds: 6,
  audioMode: "chime_voice",
  voiceRate: 0.95,
  voiceGender: "female",
  voiceAccent: "en_ph",
  voiceTemplate: "Number {number}, please proceed to {counter}",
  pollingPreset: "standard",
  staffPin: "1234",
  adminPin: "2468"
};

var RECENT_CALLS_LIMIT = 10;
var RECENT_LOGS_LIMIT = 15;
var MISSED_TICKETS_LIMIT = 25;

/** Deep-clones plain JSON data safely. */
function cloneData_(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Formats a queue ticket number with optional zero-padding. */
function formatTicketNumber(num, padDigits) {
  if (num === null || num === undefined || num === "") return "";
  var n = parseInt(num, 10);
  if (isNaN(n)) return "";
  var pad = parseInt(padDigits, 10);
  if (isNaN(pad) || pad <= 0) return String(n);
  var s = String(n);
  while (s.length < pad) {
    s = "0" + s;
  }
  return s;
}

/** Creates a fresh initial queue state for the given ISO timestamp and YYYY-MM-DD business date. */
function createInitialState(nowIso, businessDate) {
  var dateStr = businessDate || (nowIso ? String(nowIso).slice(0, 10) : "1970-01-01");
  var counters = [];
  for (var i = 1; i <= 4; i++) {
    counters.push({
      id: i,
      label: "Counter " + i,
      status: "OPEN",
      currentNumber: null,
      calledAt: null,
      lastRecalledAt: null,
      recallCount: 0,
      currentCallType: null
    });
  }
  return {
    version: 1,
    eventSeq: 0,
    nextNumber: DEFAULT_SETTINGS.minNumber,
    settings: cloneData_(DEFAULT_SETTINGS),
    counters: counters,
    lastAnnouncement: null,
    missedTickets: [],
    recentCalls: [],
    recentLogEntries: [],
    todayStats: {
      businessDate: dateStr,
      totalServed: 0,
      totalNoShow: 0,
      perCounter: { "1": 0, "2": 0, "3": 0, "4": 0 },
      totalServiceSeconds: 0,
      completedWithDuration: 0
    }
  };
}

/** Ensures all expected fields exist and rolls over daily stats when the business date changes. */
function ensureBusinessDate_(state, businessDate) {
  if (!state.settings) state.settings = cloneData_(DEFAULT_SETTINGS);
  var key;
  for (key in DEFAULT_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) && state.settings[key] === undefined) {
      state.settings[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (!Array.isArray(state.counters) || state.counters.length !== 4) {
    state.counters = createInitialState("", businessDate).counters;
  }
  if (!Array.isArray(state.missedTickets)) state.missedTickets = [];
  if (!Array.isArray(state.recentCalls)) state.recentCalls = [];
  if (!Array.isArray(state.recentLogEntries)) state.recentLogEntries = [];

  if (!state.todayStats || state.todayStats.businessDate !== businessDate) {
    state.todayStats = {
      businessDate: businessDate,
      totalServed: 0,
      totalNoShow: 0,
      perCounter: { "1": 0, "2": 0, "3": 0, "4": 0 },
      totalServiceSeconds: 0,
      completedWithDuration: 0
    };
  }
  if (!state.todayStats.perCounter) {
    state.todayStats.perCounter = { "1": 0, "2": 0, "3": 0, "4": 0 };
  }
}

/** Validates and returns the counter object matching counterId (1..4). */
function getCounterOrThrow_(state, counterId) {
  var id = parseInt(counterId, 10);
  if (isNaN(id) || id < 1 || id > 4) {
    throw new Error("INVALID: Counter ID must be between 1 and 4.");
  }
  for (var i = 0; i < state.counters.length; i++) {
    if (state.counters[i].id === id) return state.counters[i];
  }
  throw new Error("INVALID: Counter " + id + " was not found.");
}

/** Computes elapsed whole seconds between two ISO timestamps, clamped at >= 0. */
function diffSeconds_(startIso, endIso) {
  if (!startIso || !endIso) return null;
  var t1 = Date.parse(startIso);
  var t2 = Date.parse(endIso);
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.max(0, Math.round((t2 - t1) / 1000));
}

/** Updates an existing SERVING log entry in recentLogEntries (or inserts one if missing). */
function upsertLogEntryOutcome_(state, counter, outcome, nowIso, businessDate) {
  var targetTicket = counter.currentNumber;
  var targetCalledAt = counter.calledAt;
  for (var i = 0; i < state.recentLogEntries.length; i++) {
    var item = state.recentLogEntries[i];
    if (
      item.counterId === counter.id &&
      item.ticketNumber === targetTicket &&
      item.calledAt === targetCalledAt
    ) {
      item.completedAt = nowIso;
      item.outcome = outcome;
      item.recallCount = counter.recallCount || 0;
      return;
    }
  }
  state.recentLogEntries.unshift({
    businessDate: businessDate,
    ticketNumber: targetTicket,
    formattedNumber: formatTicketNumber(targetTicket, state.settings.padDigits),
    counterId: counter.id,
    counterLabel: counter.label,
    callType: counter.currentCallType || "NEXT",
    calledAt: targetCalledAt || nowIso,
    completedAt: nowIso,
    outcome: outcome,
    recallCount: counter.recallCount || 0
  });
  if (state.recentLogEntries.length > RECENT_LOGS_LIMIT) {
    state.recentLogEntries.length = RECENT_LOGS_LIMIT;
  }
}

/** Marks the counter's active ticket as COMPLETED or NO_SHOW, updates stats, and clears the counter. */
function finalizeActiveTicket_(state, counter, outcome, nowIso, businessDate) {
  if (counter.currentNumber === null || counter.currentNumber === undefined) {
    return null;
  }
  var ticketNum = counter.currentNumber;
  var formatted = formatTicketNumber(ticketNum, state.settings.padDigits);
  var calledAt = counter.calledAt || nowIso;
  var recallCount = counter.recallCount || 0;
  var callType = counter.currentCallType || "NEXT";

  if (outcome === "COMPLETED") {
    state.todayStats.totalServed += 1;
    var cKey = String(counter.id);
    state.todayStats.perCounter[cKey] = (state.todayStats.perCounter[cKey] || 0) + 1;
    var dur = diffSeconds_(calledAt, nowIso);
    if (dur !== null) {
      state.todayStats.totalServiceSeconds += dur;
      state.todayStats.completedWithDuration += 1;
    }
  } else if (outcome === "NO_SHOW") {
    state.todayStats.totalNoShow += 1;
  }

  upsertLogEntryOutcome_(state, counter, outcome, nowIso, businessDate);

  var event = {
    action: "FINALIZE",
    businessDate: businessDate,
    ticketNumber: ticketNum,
    formattedNumber: formatted,
    counterId: counter.id,
    counterLabel: counter.label,
    callType: callType,
    calledAt: calledAt,
    completedAt: nowIso,
    outcome: outcome,
    recallCount: recallCount
  };

  counter.currentNumber = null;
  counter.calledAt = null;
  counter.lastRecalledAt = null;
  counter.recallCount = 0;
  counter.currentCallType = null;

  return event;
}

/** Removes a ticket number from missedTickets if present and returns true if found. */
function removeFromMissed_(state, ticketNumber) {
  var removed = false;
  var nextList = [];
  for (var i = 0; i < state.missedTickets.length; i++) {
    if (state.missedTickets[i].number === ticketNumber) {
      removed = true;
    } else {
      nextList.push(state.missedTickets[i]);
    }
  }
  state.missedTickets = nextList;
  return removed;
}

/** Assigns a picked ticket number to a counter, records announcement, recent call, and log event. */
function assignTicketToCounter_(state, counter, pickedNum, callType, nowIso, businessDate, logEvents) {
  var formatted = formatTicketNumber(pickedNum, state.settings.padDigits);
  counter.status = "OPEN";
  counter.currentNumber = pickedNum;
  counter.calledAt = nowIso;
  counter.lastRecalledAt = null;
  counter.recallCount = 0;
  counter.currentCallType = callType;

  state.eventSeq += 1;
  state.version += 1;

  var announcement = {
    seq: state.eventSeq,
    type: "CALL",
    ticketNumber: pickedNum,
    formattedNumber: formatted,
    counterId: counter.id,
    counterLabel: counter.label,
    at: nowIso
  };
  state.lastAnnouncement = announcement;

  state.recentCalls.unshift({
    seq: state.eventSeq,
    ticketNumber: pickedNum,
    formattedNumber: formatted,
    counterId: counter.id,
    counterLabel: counter.label,
    callType: callType,
    at: nowIso
  });
  if (state.recentCalls.length > RECENT_CALLS_LIMIT) {
    state.recentCalls.length = RECENT_CALLS_LIMIT;
  }

  var logEntry = {
    businessDate: businessDate,
    ticketNumber: pickedNum,
    formattedNumber: formatted,
    counterId: counter.id,
    counterLabel: counter.label,
    callType: callType,
    calledAt: nowIso,
    completedAt: "",
    outcome: "SERVING",
    recallCount: 0
  };
  state.recentLogEntries.unshift(logEntry);
  if (state.recentLogEntries.length > RECENT_LOGS_LIMIT) {
    state.recentLogEntries.length = RECENT_LOGS_LIMIT;
  }

  logEvents.push({
    action: "INSERT",
    businessDate: businessDate,
    ticketNumber: pickedNum,
    formattedNumber: formatted,
    counterId: counter.id,
    counterLabel: counter.label,
    callType: callType,
    calledAt: nowIso,
    completedAt: "",
    outcome: "SERVING",
    recallCount: 0
  });

  return announcement;
}

/** Completes the previous card on counterId and assigns the next available rotating number. */
function callNextInState(rawState, counterId, nowIso, businessDate) {
  var state = cloneData_(rawState);
  ensureBusinessDate_(state, businessDate);
  var counter = getCounterOrThrow_(state, counterId);

  var minNum = state.settings.minNumber;
  var maxNum = state.settings.maxNumber;
  var poolSize = maxNum - minNum + 1;

  // Build set of numbers still actively serving at other counters so we never double-call.
  var activeElsewhere = {};
  for (var i = 0; i < state.counters.length; i++) {
    var other = state.counters[i];
    if (other.id !== counter.id && other.currentNumber !== null && other.currentNumber !== undefined) {
      activeElsewhere[other.currentNumber] = other;
    }
  }

  var candidate = state.nextNumber;
  if (candidate < minNum || candidate > maxNum) {
    candidate = minNum;
  }

  var picked = null;
  for (var step = 0; step < poolSize; step++) {
    if (!activeElsewhere[candidate]) {
      picked = candidate;
      break;
    }
    candidate = (candidate >= maxNum) ? minNum : candidate + 1;
  }

  if (picked === null) {
    throw new Error("CONFLICT: All queue card numbers are currently active at counters.");
  }

  var logEvents = [];
  var prevEvent = finalizeActiveTicket_(state, counter, "COMPLETED", nowIso, businessDate);
  if (prevEvent) logEvents.push(prevEvent);

  var wasMissed = removeFromMissed_(state, picked);
  state.nextNumber = (picked >= maxNum) ? minNum : picked + 1;

  var callType = wasMissed ? "MISSED_RECALL" : "NEXT";
  var announcement = assignTicketToCounter_(state, counter, picked, callType, nowIso, businessDate, logEvents);

  return { state: state, announcement: announcement, logEvents: logEvents };
}

/** Calls a specific physical card number at counterId without skipping upcoming sequential numbers. */
function callSpecificInState(rawState, counterId, rawNumber, nowIso, businessDate) {
  var state = cloneData_(rawState);
  ensureBusinessDate_(state, businessDate);
  var counter = getCounterOrThrow_(state, counterId);

  var num = parseInt(rawNumber, 10);
  if (isNaN(num) || String(rawNumber).trim() === "" || !/^\d+$/.test(String(rawNumber).trim())) {
    throw new Error("INVALID: Please enter a valid whole ticket number.");
  }
  var minNum = state.settings.minNumber;
  var maxNum = state.settings.maxNumber;
  if (num < minNum || num > maxNum) {
    throw new Error("INVALID: Ticket number must be between " + minNum + " and " + maxNum + ".");
  }

  for (var i = 0; i < state.counters.length; i++) {
    var c = state.counters[i];
    if (c.id !== counter.id && c.currentNumber === num) {
      var fmtConflict = formatTicketNumber(num, state.settings.padDigits);
      throw new Error("CONFLICT: Number " + fmtConflict + " is currently being served at " + c.label + ".");
    }
  }

  // If this counter is already serving that exact card number, treat it cleanly as a recall.
  if (counter.currentNumber === num) {
    return recallInState(state, counter.id, nowIso);
  }

  var logEvents = [];
  var prevEvent = finalizeActiveTicket_(state, counter, "COMPLETED", nowIso, businessDate);
  if (prevEvent) logEvents.push(prevEvent);

  var wasMissed = removeFromMissed_(state, num);
  if (num === state.nextNumber) {
    state.nextNumber = (num >= maxNum) ? minNum : num + 1;
  }

  var callType = wasMissed ? "MISSED_RECALL" : "SPECIFIC";
  var announcement = assignTicketToCounter_(state, counter, num, callType, nowIso, businessDate, logEvents);

  return { state: state, announcement: announcement, logEvents: logEvents };
}

/** Re-flashes and replays the announcement for the counter's active ticket. */
function recallInState(rawState, counterId, nowIso) {
  var state = cloneData_(rawState);
  var counter = getCounterOrThrow_(state, counterId);
  if (counter.currentNumber === null || counter.currentNumber === undefined) {
    throw new Error("INVALID: " + counter.label + " currently has no active number to recall.");
  }

  counter.recallCount = (counter.recallCount || 0) + 1;
  counter.lastRecalledAt = nowIso;
  state.eventSeq += 1;
  state.version += 1;

  var formatted = formatTicketNumber(counter.currentNumber, state.settings.padDigits);
  var announcement = {
    seq: state.eventSeq,
    type: "RECALL",
    ticketNumber: counter.currentNumber,
    formattedNumber: formatted,
    counterId: counter.id,
    counterLabel: counter.label,
    at: nowIso
  };
  state.lastAnnouncement = announcement;

  for (var i = 0; i < state.recentLogEntries.length; i++) {
    var item = state.recentLogEntries[i];
    if (
      item.counterId === counter.id &&
      item.ticketNumber === counter.currentNumber &&
      item.calledAt === counter.calledAt
    ) {
      item.recallCount = counter.recallCount;
      break;
    }
  }

  var logEvents = [{
    action: "RECALL",
    ticketNumber: counter.currentNumber,
    formattedNumber: formatted,
    counterId: counter.id,
    calledAt: counter.calledAt || nowIso,
    recallCount: counter.recallCount
  }];

  return { state: state, announcement: announcement, logEvents: logEvents };
}

/** Marks the counter's current card as returned/completed and leaves the counter idle. */
function completeInState(rawState, counterId, nowIso, businessDate) {
  var state = cloneData_(rawState);
  ensureBusinessDate_(state, businessDate);
  var counter = getCounterOrThrow_(state, counterId);
  if (counter.currentNumber === null || counter.currentNumber === undefined) {
    throw new Error("INVALID: " + counter.label + " has no active number to complete.");
  }

  var logEvents = [];
  var ev = finalizeActiveTicket_(state, counter, "COMPLETED", nowIso, businessDate);
  if (ev) logEvents.push(ev);
  state.version += 1;

  return { state: state, announcement: null, logEvents: logEvents };
}

/** Marks the counter's current ticket as NO_SHOW, moves it into missedTickets, and frees the counter. */
function noShowInState(rawState, counterId, nowIso, businessDate) {
  var state = cloneData_(rawState);
  ensureBusinessDate_(state, businessDate);
  var counter = getCounterOrThrow_(state, counterId);
  if (counter.currentNumber === null || counter.currentNumber === undefined) {
    throw new Error("INVALID: " + counter.label + " has no active number to mark as No-Show.");
  }

  var ticketNum = counter.currentNumber;
  var formatted = formatTicketNumber(ticketNum, state.settings.padDigits);
  var logEvents = [];
  var ev = finalizeActiveTicket_(state, counter, "NO_SHOW", nowIso, businessDate);
  if (ev) logEvents.push(ev);

  removeFromMissed_(state, ticketNum);
  state.missedTickets.unshift({
    number: ticketNum,
    formattedNumber: formatted,
    fromCounterId: counter.id,
    fromCounterLabel: counter.label,
    missedAt: nowIso
  });
  if (state.missedTickets.length > MISSED_TICKETS_LIMIT) {
    state.missedTickets.length = MISSED_TICKETS_LIMIT;
  }

  state.version += 1;
  return { state: state, announcement: null, logEvents: logEvents };
}

/** Removes a ticket number from missedTickets. */
function dismissMissedInState(rawState, rawNumber) {
  var state = cloneData_(rawState);
  var num = parseInt(rawNumber, 10);
  if (isNaN(num)) {
    throw new Error("INVALID: Invalid missed ticket number.");
  }
  var removed = removeFromMissed_(state, num);
  if (!removed) {
    throw new Error("INVALID: Ticket #" + num + " is not in the missed list.");
  }
  state.version += 1;
  return { state: state, announcement: null, logEvents: [] };
}

/** Opens or closes a counter; auto-completes active ticket when closing so TV never shows stale cards. */
function setCounterStatusInState(rawState, counterId, status, nowIso, businessDate) {
  var state = cloneData_(rawState);
  ensureBusinessDate_(state, businessDate);
  var counter = getCounterOrThrow_(state, counterId);
  var normalized = String(status || "").toUpperCase();
  if (normalized !== "OPEN" && normalized !== "CLOSED") {
    throw new Error("INVALID: Counter status must be OPEN or CLOSED.");
  }

  var logEvents = [];
  if (normalized === "CLOSED" && counter.currentNumber !== null && counter.currentNumber !== undefined) {
    var ev = finalizeActiveTicket_(state, counter, "COMPLETED", nowIso, businessDate);
    if (ev) logEvents.push(ev);
  }
  counter.status = normalized;
  state.version += 1;

  return { state: state, announcement: null, logEvents: logEvents };
}

/** Validates and applies settings updates and counter labels. */
function updateSettingsInState(rawState, patch) {
  var state = cloneData_(rawState);
  if (!patch || typeof patch !== "object") {
    throw new Error("INVALID: Settings payload is required.");
  }

  var s = state.settings;

  var nextMin = patch.minNumber !== undefined ? parseInt(patch.minNumber, 10) : s.minNumber;
  var nextMax = patch.maxNumber !== undefined ? parseInt(patch.maxNumber, 10) : s.maxNumber;
  if (isNaN(nextMin) || isNaN(nextMax) || nextMin < 1 || nextMax > 9999 || nextMin >= nextMax) {
    throw new Error("INVALID: Card range must have 1 <= Min < Max <= 9999.");
  }
  s.minNumber = nextMin;
  s.maxNumber = nextMax;

  if (patch.padDigits !== undefined) {
    var pad = parseInt(patch.padDigits, 10);
    if ([0, 2, 3, 4].indexOf(pad) === -1) {
      throw new Error("INVALID: Zero-padding digits must be 0, 2, 3, or 4.");
    }
    s.padDigits = pad;
  }

  if (patch.hospitalName !== undefined) {
    var hn = String(patch.hospitalName).trim();
    if (!hn) throw new Error("INVALID: Hospital name cannot be empty.");
    s.hospitalName = hn.slice(0, 120);
  }
  if (patch.departmentSubtitle !== undefined) {
    s.departmentSubtitle = String(patch.departmentSubtitle).trim().slice(0, 140);
  }
  if (patch.tickerMessage !== undefined) {
    s.tickerMessage = String(patch.tickerMessage).trim().slice(0, 400);
  }
  if (patch.customLogoUrl !== undefined) {
    var logo = String(patch.customLogoUrl).trim();
    if (logo && !/^https?:\/\//i.test(logo) && !/^data:image\//i.test(logo)) {
      throw new Error("INVALID: Custom logo URL must start with https://, http://, or data:image/.");
    }
    s.customLogoUrl = logo.slice(0, 500);
  }
  if (patch.displayTheme !== undefined) {
    if (patch.displayTheme !== "light" && patch.displayTheme !== "dark") {
      throw new Error("INVALID: Theme must be light or dark.");
    }
    s.displayTheme = patch.displayTheme;
  }
  if (patch.flashSeconds !== undefined) {
    var fs = parseInt(patch.flashSeconds, 10);
    if (isNaN(fs)) throw new Error("INVALID: Flash seconds must be a number.");
    s.flashSeconds = Math.min(15, Math.max(3, fs));
  }
  if (patch.audioMode !== undefined) {
    if (["chime_voice", "chime_only", "silent"].indexOf(patch.audioMode) === -1) {
      throw new Error("INVALID: Invalid audio mode.");
    }
    s.audioMode = patch.audioMode;
  }
  if (patch.voiceRate !== undefined) {
    var vr = parseFloat(patch.voiceRate);
    if (isNaN(vr)) throw new Error("INVALID: Voice speed must be numeric.");
    s.voiceRate = Math.min(1.3, Math.max(0.6, Math.round(vr * 100) / 100));
  }
  if (patch.voiceGender !== undefined) {
    var vg = String(patch.voiceGender).trim().toLowerCase();
    if (vg !== "female" && vg !== "male") {
      throw new Error("INVALID: Voice gender must be female or male.");
    }
    s.voiceGender = vg;
  }
  if (patch.voiceAccent !== undefined) {
    var va = String(patch.voiceAccent).trim().toLowerCase();
    if (["en_ph", "fil_ph", "en_us"].indexOf(va) === -1) {
      throw new Error("INVALID: Voice language/accent must be en_ph, fil_ph, or en_us.");
    }
    s.voiceAccent = va;
  }
  if (patch.voiceTemplate !== undefined) {
    var vt = String(patch.voiceTemplate).trim();
    if (!vt) throw new Error("INVALID: Voice template cannot be empty.");
    s.voiceTemplate = vt.slice(0, 160);
  }
  if (patch.pollingPreset !== undefined) {
    if (patch.pollingPreset !== "standard" && patch.pollingPreset !== "eco_24h") {
      throw new Error("INVALID: Polling preset must be standard or eco_24h.");
    }
    s.pollingPreset = patch.pollingPreset;
  }

  if (patch.staffPin !== undefined && String(patch.staffPin).trim() !== "") {
    var sp = String(patch.staffPin).trim();
    if (sp.length < 4 || sp.length > 20) {
      throw new Error("INVALID: Staff PIN must be 4 to 20 characters.");
    }
    s.staffPin = sp;
  }
  if (patch.adminPin !== undefined && String(patch.adminPin).trim() !== "") {
    var ap = String(patch.adminPin).trim();
    if (ap.length < 4 || ap.length > 20) {
      throw new Error("INVALID: Admin PIN must be 4 to 20 characters.");
    }
    s.adminPin = ap;
  }

  if (Array.isArray(patch.counterLabels) && patch.counterLabels.length === 4) {
    for (var i = 0; i < 4; i++) {
      var lbl = String(patch.counterLabels[i] || "").trim();
      if (!lbl) {
        throw new Error("INVALID: Counter " + (i + 1) + " label cannot be empty.");
      }
      state.counters[i].label = lbl.slice(0, 40);
    }
  }

  // Clamp nextNumber and re-format displayed cached numbers if padDigits changed.
  if (state.nextNumber < s.minNumber || state.nextNumber > s.maxNumber) {
    state.nextNumber = s.minNumber;
  }
  for (var m = 0; m < state.missedTickets.length; m++) {
    state.missedTickets[m].formattedNumber = formatTicketNumber(state.missedTickets[m].number, s.padDigits);
  }
  for (var r = 0; r < state.recentCalls.length; r++) {
    state.recentCalls[r].formattedNumber = formatTicketNumber(state.recentCalls[r].ticketNumber, s.padDigits);
  }
  if (state.lastAnnouncement) {
    state.lastAnnouncement.formattedNumber = formatTicketNumber(state.lastAnnouncement.ticketNumber, s.padDigits);
  }

  state.version += 1;
  return { state: state, announcement: null, logEvents: [] };
}

/** Manually aligns the next rotating card number inside [minNumber, maxNumber]. */
function setNextNumberInState(rawState, rawNextNum) {
  var state = cloneData_(rawState);
  var num = parseInt(rawNextNum, 10);
  if (isNaN(num) || num < state.settings.minNumber || num > state.settings.maxNumber) {
    throw new Error(
      "INVALID: Next number must be between " + state.settings.minNumber + " and " + state.settings.maxNumber + "."
    );
  }
  state.nextNumber = num;
  state.version += 1;
  return { state: state, announcement: null, logEvents: [] };
}

/** Resets all active counters and missed/recent lists back to minNumber (preserving daily stats & logs). */
function resetQueueInState(rawState, nowIso, businessDate) {
  var state = cloneData_(rawState);
  ensureBusinessDate_(state, businessDate);
  var logEvents = [];
  for (var i = 0; i < state.counters.length; i++) {
    var c = state.counters[i];
    if (c.currentNumber !== null && c.currentNumber !== undefined) {
      var ev = finalizeActiveTicket_(state, c, "COMPLETED", nowIso, businessDate);
      if (ev) logEvents.push(ev);
    }
    c.status = "OPEN";
  }
  state.missedTickets = [];
  state.recentCalls = [];
  state.lastAnnouncement = null;
  state.nextNumber = state.settings.minNumber;
  state.version += 1;

  return { state: state, announcement: null, logEvents: logEvents };
}

/** Emits a non-destructive TEST announcement for the Display Monitor audio & flash check. */
function createTestAudioAnnouncement(rawState, nowIso) {
  var state = cloneData_(rawState);
  state.eventSeq += 1;
  state.version += 1;
  var c2 = state.counters[1] || state.counters[0];
  var sampleNum = Math.min(15, state.settings.maxNumber);
  if (sampleNum < state.settings.minNumber) sampleNum = state.settings.minNumber;
  var announcement = {
    seq: state.eventSeq,
    type: "TEST",
    ticketNumber: sampleNum,
    formattedNumber: formatTicketNumber(sampleNum, state.settings.padDigits),
    counterId: c2.id,
    counterLabel: c2.label,
    at: nowIso
  };
  state.lastAnnouncement = announcement;
  return { state: state, announcement: announcement, logEvents: [] };
}

/** Computes client-safe state without PIN secrets, enriched with formatted helpers and polling intervals. */
function sanitizeClientState(rawState) {
  var state = cloneData_(rawState);
  var pad = state.settings.padDigits;
  var preset = state.settings.pollingPreset || "standard";

  var pollingConfig = preset === "eco_24h"
    ? { displayMs: 4000, idleDisplayMs: 15000, counterMs: 12000, hiddenCounterMs: 25000 }
    : { displayMs: 2500, idleDisplayMs: 10000, counterMs: 6000, hiddenCounterMs: 15000 };

  for (var i = 0; i < state.counters.length; i++) {
    var c = state.counters[i];
    c.formattedNumber = formatTicketNumber(c.currentNumber, pad);
  }

  state.nextFormatted = formatTicketNumber(state.nextNumber, pad);
  state.pollingConfig = pollingConfig;

  if (state.todayStats && state.todayStats.completedWithDuration > 0) {
    state.todayStats.avgServiceSeconds = Math.round(
      state.todayStats.totalServiceSeconds / state.todayStats.completedWithDuration
    );
  } else if (state.todayStats) {
    state.todayStats.avgServiceSeconds = 0;
  }

  delete state.settings.staffPin;
  delete state.settings.adminPin;
  state.settings.hasStaffPin = true;
  state.settings.hasAdminPin = true;
  state.settings.defaultTickerMessage = DEFAULT_SETTINGS.tickerMessage;
  state.settings.voicePresets = cloneData_(VOICE_PRESETS);

  return state;
}

/** Escapes a single CSV field according to RFC 4180. */
function escapeCsvField_(value) {
  var s = (value === null || value === undefined) ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Formats daily call log entries into an RFC-4180 CSV string. */
function buildDailyCsv(logRows) {
  var headers = [
    "Date",
    "Ticket #",
    "Counter",
    "Call Type",
    "Called At",
    "Completed At",
    "Outcome",
    "Recalls"
  ];
  var lines = [headers.map(escapeCsvField_).join(",")];
  var rows = Array.isArray(logRows) ? logRows : [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    lines.push([
      r.businessDate || "",
      r.formattedNumber || (r.ticketNumber !== undefined ? r.ticketNumber : ""),
      r.counterLabel || ("Counter " + (r.counterId || "")),
      r.callType || "",
      r.calledAt || "",
      r.completedAt || "",
      r.outcome || "",
      r.recallCount !== undefined ? r.recallCount : 0
    ].map(escapeCsvField_).join(","));
  }
  return lines.join("\r\n");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    VOICE_PRESETS: VOICE_PRESETS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    formatTicketNumber: formatTicketNumber,
    createInitialState: createInitialState,
    ensureBusinessDate_: ensureBusinessDate_,
    callNextInState: callNextInState,
    callSpecificInState: callSpecificInState,
    recallInState: recallInState,
    completeInState: completeInState,
    noShowInState: noShowInState,
    dismissMissedInState: dismissMissedInState,
    setCounterStatusInState: setCounterStatusInState,
    updateSettingsInState: updateSettingsInState,
    setNextNumberInState: setNextNumberInState,
    resetQueueInState: resetQueueInState,
    createTestAudioAnnouncement: createTestAudioAnnouncement,
    sanitizeClientState: sanitizeClientState,
    buildDailyCsv: buildDailyCsv
  };
}
