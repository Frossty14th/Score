const CHANNEL_NAME = "scoreboard_channel";
const WS_PATH = "/scoreboard-ws";

function createTransport(role) {
    const listeners = new Set();
    const selfId = `${role}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    const seenMessageIds = new Map();
    let messageCounter = 0;
    let ws = null;
    let wsReconnectTimer = null;
    let manualClose = false;
    let bc = null;

    function pruneSeen() {
        const now = Date.now();
        for (const [id, ts] of seenMessageIds.entries()) {
            if (now - ts > 30000) seenMessageIds.delete(id);
        }
        if (seenMessageIds.size > 400) {
            const sorted = [...seenMessageIds.entries()].sort((a, b) => a[1] - b[1]);
            const overflow = sorted.length - 300;
            for (let i = 0; i < overflow; i += 1) {
                seenMessageIds.delete(sorted[i][0]);
            }
        }
    }

    function emit(payload) {
        listeners.forEach((listener) => {
            try {
                listener(payload);
            } catch (error) {
                console.warn("Transport listener failed:", error);
            }
        });
    }

    function handleIncoming(raw) {
        if (!raw) return;
        if (!raw.__scoreboardEnvelope) {
            emit(raw);
            return;
        }

        if (raw.sourceId === selfId) return;
        const messageId = typeof raw.messageId === "string" ? raw.messageId : "";
        if (!messageId) return;
        if (seenMessageIds.has(messageId)) return;
        seenMessageIds.set(messageId, Date.now());
        pruneSeen();
        emit(raw.payload);
    }

    function safeParse(json) {
        try {
            return JSON.parse(json);
        } catch (_error) {
            return null;
        }
    }

    function getWsUrl() {
        if (!window.location.host) return "";
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${window.location.host}${WS_PATH}`;
    }

    function connectWs() {
        if (!("WebSocket" in window)) return;
        const wsUrl = getWsUrl();
        if (!wsUrl) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        try {
            ws = new WebSocket(wsUrl);
        } catch (_error) {
            scheduleReconnect();
            return;
        }

        ws.addEventListener("message", (event) => {
            const parsed = typeof event.data === "string" ? safeParse(event.data) : null;
            if (parsed) handleIncoming(parsed);
        });
        ws.addEventListener("close", () => {
            ws = null;
            if (!manualClose) scheduleReconnect();
        });
        ws.addEventListener("error", () => {
            if (ws && ws.readyState !== WebSocket.OPEN) {
                try { ws.close(); } catch (_error) {}
            }
        });
    }

    function scheduleReconnect() {
        if (wsReconnectTimer) return;
        wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            connectWs();
        }, 1500);
    }

    if ("BroadcastChannel" in window) {
        bc = new BroadcastChannel(CHANNEL_NAME);
        bc.onmessage = (event) => handleIncoming(event.data);
    }
    connectWs();

    return {
        send(payload) {
            const envelope = {
                __scoreboardEnvelope: true,
                sourceId: selfId,
                messageId: `${selfId}-${Date.now()}-${messageCounter += 1}`,
                payload
            };
            seenMessageIds.set(envelope.messageId, Date.now());
            pruneSeen();

            if (bc) bc.postMessage(envelope);
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify(envelope));
                } catch (_error) {}
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        destroy() {
            manualClose = true;
            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }
            if (bc) bc.close();
            if (ws) {
                try { ws.close(); } catch (_error) {}
                ws = null;
            }
            listeners.clear();
        }
    };
}

const transport = createTransport("control");
const STORAGE_KEY = "scoreboard_state_v1";
const ADVERTISEMENT_FOLDER_URL = "../Advertisement/";
const ADVERTISEMENT_MANIFEST_URL = "../Advertisement/advertisement-manifest.json";

const DEFAULT_TEAMS = [
    { name: "Team A", score: 0, logo: "", logoWidth: 150, logoHeight: null, teamColor: "" },
    { name: "Team B", score: 0, logo: "", logoWidth: 150, logoHeight: null, teamColor: "" }
];
const VALID_VIEWS = new Set(["all", "top10", "top5", "top3", "spotlight", "final"]);
const HOTKEY_ACTIONS = [
    "toggleLive",
    "toggleStandby",
    "toggleHold",
    "startPauseTimer",
    "resetTimer",
    "add10Seconds",
    "add20Seconds",
    "testSnow",
    "undo",
    "redo"
];
const HOTKEY_LABELS = {
    toggleLive: "Toggle Live",
    toggleStandby: "Toggle Standby",
    toggleHold: "Toggle Hold",
    startPauseTimer: "Start/Pause Timer",
    resetTimer: "Reset Timer",
    add10Seconds: "Add 10 sec",
    add20Seconds: "Add 20 sec",
    testSnow: "Test Snow",
    undo: "Undo",
    redo: "Redo"
};
const DEFAULT_HOTKEY_BINDINGS = {
    toggleLive: "Ctrl+L",
    toggleStandby: "Ctrl+B",
    toggleHold: "Ctrl+H",
    startPauseTimer: "Space",
    resetTimer: "Ctrl+R",
    add10Seconds: "Ctrl+1",
    add20Seconds: "Ctrl+2",
    testSnow: "Ctrl+Shift+S",
    undo: "Ctrl+Z",
    redo: "Ctrl+Y"
};
const HISTORY_LIMIT = 80;
const OPERATOR_LOG_LIMIT = 50;
const TEAM_LOGO_FIXED_SIZE = 150;
const DEFAULT_SFX_CLIPS = { birthday: "", laugh: "", cheer: "" };

let teams = DEFAULT_TEAMS.map((team) => ({ ...team }));
let timerDuration = 300;
let timerRemaining = timerDuration;
let timerInterval = null;
let roundName = "ROUND 1";
let eventTitle = "TITLE NAME EVENT";
let sponsorLogos = {
    "1": "",
    "2": "",
    "3": "",
    "4": ""
};
let liveMode = false;
let holdMode = false;
let viewMode = "all";
let allViewScroll = 0;
let standbyMode = true;
let standbyMediaSrc = "";
let standbyMediaType = "";
let standbyLibrary = [];
let standbyPlaylist = [];
let teamSearchQuery = "";
let adCurrentIndex = 0;
let adHold = false;
let adSeekToken = 0;
let standbyFallbackMode = "message";
let standbyFallbackData = {
    title: "Standby",
    subtitle: "Match starts soon",
    dvdImageSrc: ""
};
let pendingAdMediaSrc = "";
let pendingAdMediaType = "";
let pendingAdMediaName = "";
let hotkeyBindings = { ...DEFAULT_HOTKEY_BINDINGS };
let hotkeyCaptureMode = false;
let hotkeyCapturedValue = "";
let toastTimer = null;
let buttonAudioCtx = null;
let controlLockMode = false;
let undoStack = [];
let redoStack = [];
let isHistoryRestoring = false;
let operatorLog = [];
let overlayHealthTimeout = null;
let overlayChannelOnline = false;
let overlayHealthPending = false;
let shortcutDockCollapsed = false;
let winnerFxActive = false;
let sfxClips = { ...DEFAULT_SFX_CLIPS };
let activeSfxKey = "";
let activeSfxAudio = null;
let sfxPaused = false;
let sfxUploadTargetKey = "";
let sfxClipDurations = {};
const sfxDurationLoadingKeys = new Set();
let addTeamLogoData = "";

function playButtonClickSound() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!buttonAudioCtx) {
            buttonAudioCtx = new AudioCtx();
        }
        if (buttonAudioCtx.state === "suspended") {
            buttonAudioCtx.resume().catch(() => {});
        }

        const oscillator = buttonAudioCtx.createOscillator();
        const gain = buttonAudioCtx.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(740, buttonAudioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(520, buttonAudioCtx.currentTime + 0.055);
        gain.gain.setValueAtTime(0.0001, buttonAudioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.03, buttonAudioCtx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, buttonAudioCtx.currentTime + 0.07);
        oscillator.connect(gain);
        gain.connect(buttonAudioCtx.destination);
        oscillator.start();
        oscillator.stop(buttonAudioCtx.currentTime + 0.075);
    } catch (_error) {
        // Ignore audio errors to avoid blocking UI actions.
    }
}

function initButtonSoundEffects() {
    document.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const button = target.closest("button");
        if (!button || button.disabled) return;
        playButtonClickSound();
    });
}

function clampNumber(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return num;
}

function sanitizeHexColor(value, fallback = "") {
    const raw = String(value || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    return fallback;
}

function sanitizeTeam(team, fallbackName) {
    const safeName = typeof team?.name === "string" && team.name.trim() ? team.name.trim() : fallbackName;
    const score = Math.max(0, Math.floor(clampNumber(team?.score, 0)));
    const logo = typeof team?.logo === "string" ? team.logo : "";
    const logoWidth = Math.max(60, Math.min(240, Math.floor(clampNumber(team?.logoWidth, TEAM_LOGO_FIXED_SIZE))));
    const logoHeight = null;
    const teamColor = sanitizeHexColor(team?.teamColor, "");
    return { name: safeName, score, logo, logoWidth, logoHeight, teamColor };
}

function sanitizeHotkeyBindings(rawBindings) {
    const next = { ...DEFAULT_HOTKEY_BINDINGS };
    if (!rawBindings || typeof rawBindings !== "object") return next;
    HOTKEY_ACTIONS.forEach((action) => {
        const value = rawBindings[action];
        if (typeof value === "string") {
            next[action] = value.trim();
        }
    });
    return next;
}

function sanitizeOperatorLog(rawLog) {
    if (!Array.isArray(rawLog)) return [];
    return rawLog
        .filter((item) => item && typeof item === "object")
        .map((item) => {
            const timestamp = typeof item.timestamp === "string" && item.timestamp.trim()
                ? item.timestamp.trim()
                : new Date().toISOString();
            const action = typeof item.action === "string" ? item.action.trim() : "";
            const details = typeof item.details === "string" ? item.details.trim() : "";
            return { timestamp, action, details };
        })
        .filter((item) => item.action)
        .slice(-OPERATOR_LOG_LIMIT);
}

function sanitizeSfxClips(rawClips) {
    const next = { ...DEFAULT_SFX_CLIPS };
    if (!rawClips || typeof rawClips !== "object") return next;
    Object.entries(rawClips).forEach(([rawKey, value]) => {
        if (typeof value !== "string") return;
        const key = normalizeSfxKey(rawKey);
        if (!key) return;
        next[key] = value;
    });
    return next;
}

function normalizeSponsorLogos(rawLogos) {
    const next = { "1": "", "2": "", "3": "", "4": "" };
    if (!rawLogos || typeof rawLogos !== "object") return next;

    // Backward compatibility: map old left/right to slot 1 and 4.
    if (typeof rawLogos.left === "string") next["1"] = rawLogos.left;
    if (typeof rawLogos.right === "string") next["4"] = rawLogos.right;

    ["1", "2", "3", "4"].forEach((slot) => {
        if (typeof rawLogos[slot] === "string") next[slot] = rawLogos[slot];
    });
    return next;
}

function getSponsorSlotLabel(slot) {
    const safeSlot = String(slot);
    if (safeSlot === "1") return "Left 1";
    if (safeSlot === "2") return "Left 2";
    if (safeSlot === "3") return "Right 1";
    if (safeSlot === "4") return "Right 2";
    return `Slot ${safeSlot}`;
}

function cloneData(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function createHistorySnapshot() {
    return {
        teams: cloneData(teams),
        timerDuration,
        timerRemaining,
        roundName,
        eventTitle,
        sponsorLogos: cloneData(sponsorLogos),
        liveMode,
        holdMode,
        viewMode,
        allViewScroll,
        standbyMode,
        standbyMediaSrc,
        standbyMediaType,
        standbyLibrary: cloneData(standbyLibrary),
        standbyPlaylist: cloneData(standbyPlaylist),
        teamSearchQuery,
        adCurrentIndex,
        adHold,
        adSeekToken,
        standbyFallbackMode,
        standbyFallbackData: cloneData(standbyFallbackData),
        pendingAdMediaSrc,
        pendingAdMediaType,
        pendingAdMediaName,
        sfxClips: cloneData(sfxClips)
    };
}

function snapshotEquals(a, b) {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch (_error) {
        return false;
    }
}

function updateHistoryButtons() {
    const undoBtn = document.getElementById("undo-btn");
    const redoBtn = document.getElementById("redo-btn");
    const historyMeta = document.getElementById("history-meta");
    if (undoBtn) undoBtn.disabled = controlLockMode || undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = controlLockMode || redoStack.length === 0;
    if (historyMeta) {
        historyMeta.textContent = `History: ${undoStack.length} undo / ${redoStack.length} redo`;
    }
}

function recordHistory() {
    if (isHistoryRestoring) return;
    const snapshot = createHistorySnapshot();
    const previous = undoStack[undoStack.length - 1];
    if (previous && snapshotEquals(previous, snapshot)) return;
    undoStack.push(snapshot);
    if (undoStack.length > HISTORY_LIMIT) {
        undoStack.shift();
    }
    redoStack = [];
    updateHistoryButtons();
}

function restoreHistorySnapshot(snapshot) {
    isHistoryRestoring = true;
    teams = Array.isArray(snapshot.teams) ? cloneData(snapshot.teams) : [];
    timerDuration = Math.max(0, Math.floor(clampNumber(snapshot.timerDuration, timerDuration)));
    timerRemaining = Math.max(0, Math.floor(clampNumber(snapshot.timerRemaining, timerRemaining)));
    roundName = typeof snapshot.roundName === "string" ? snapshot.roundName : roundName;
    eventTitle = typeof snapshot.eventTitle === "string" && snapshot.eventTitle.trim() ? snapshot.eventTitle : eventTitle;
    sponsorLogos = normalizeSponsorLogos(snapshot.sponsorLogos);
    liveMode = Boolean(snapshot.liveMode);
    holdMode = Boolean(snapshot.holdMode);
    viewMode = VALID_VIEWS.has(snapshot.viewMode) ? snapshot.viewMode : "all";
    allViewScroll = Math.max(0, Math.min(1000, Math.floor(clampNumber(snapshot.allViewScroll, 0))));
    standbyMode = Boolean(snapshot.standbyMode);
    standbyMediaSrc = typeof snapshot.standbyMediaSrc === "string" ? snapshot.standbyMediaSrc : "";
    standbyMediaType = snapshot.standbyMediaType === "video" ? "video" : (snapshot.standbyMediaType === "image" ? "image" : "");
    standbyLibrary = Array.isArray(snapshot.standbyLibrary) ? cloneData(snapshot.standbyLibrary) : [];
    standbyPlaylist = Array.isArray(snapshot.standbyPlaylist) ? cloneData(snapshot.standbyPlaylist) : [];
    teamSearchQuery = typeof snapshot.teamSearchQuery === "string" ? snapshot.teamSearchQuery : "";
    adCurrentIndex = Math.max(0, Math.floor(clampNumber(snapshot.adCurrentIndex, 0)));
    adHold = Boolean(snapshot.adHold);
    adSeekToken = Math.max(0, Math.floor(clampNumber(snapshot.adSeekToken, adSeekToken)));
    standbyFallbackMode = typeof snapshot.standbyFallbackMode === "string" ? snapshot.standbyFallbackMode : "message";
    standbyFallbackData = snapshot.standbyFallbackData && typeof snapshot.standbyFallbackData === "object"
        ? cloneData(snapshot.standbyFallbackData)
        : { title: "Standby", subtitle: "Match starts soon", dvdImageSrc: "" };
    pendingAdMediaSrc = typeof snapshot.pendingAdMediaSrc === "string" ? snapshot.pendingAdMediaSrc : "";
    pendingAdMediaType = snapshot.pendingAdMediaType === "video" ? "video" : (snapshot.pendingAdMediaType === "image" ? "image" : "");
    pendingAdMediaName = typeof snapshot.pendingAdMediaName === "string" ? snapshot.pendingAdMediaName : "";
    sfxClips = sanitizeSfxClips(snapshot.sfxClips);

    renderTeams();
    updateTimerDisplay();
    syncTimerInputsFromState();
    syncEventHeaderControls();
    syncButtonStates();
    renderStandbyLibrarySelect();
    syncFallbackControlsFromState();
    updateAdStatus();
    syncAdStartIndexInput();
    renderAdPreview();
    renderSfxButtonsState();
    saveState();
    broadcastControlState();
    if (liveMode) broadcastUpdate();
    isHistoryRestoring = false;
}

function undoAction() {
    if (controlLockMode || undoStack.length === 0) return;
    const previous = undoStack.pop();
    redoStack.push(createHistorySnapshot());
    restoreHistorySnapshot(previous);
    updateHistoryButtons();
    addOperatorLog("Undo", "Reverted to previous state");
    showToast("Undone", "info");
}

function redoAction() {
    if (controlLockMode || redoStack.length === 0) return;
    const next = redoStack.pop();
    undoStack.push(createHistorySnapshot());
    restoreHistorySnapshot(next);
    updateHistoryButtons();
    addOperatorLog("Redo", "Re-applied next state");
    showToast("Redone", "info");
}

function getStatePayload() {
    return {
        teams,
        timerDuration,
        timerRemaining,
        roundName,
        eventTitle,
        sponsorLogos,
        liveMode,
        holdMode,
        viewMode,
        allViewScroll,
        standbyMode,
        standbyMediaSrc,
        standbyMediaType,
        standbyPlaylist,
        adCurrentIndex,
        adHold,
        adSeekToken,
        standbyFallbackMode,
        standbyFallbackData,
        hotkeyBindings,
        controlLockMode,
        operatorLog,
        shortcutDockCollapsed,
        sfxClips
    };
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(getStatePayload()));
    } catch (error) {
        console.warn("Failed to save scoreboard state:", error);
    }
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.teams) && parsed.teams.length > 0) {
            teams = parsed.teams.map((team, index) => sanitizeTeam(team, `Team ${index + 1}`));
        }

        timerDuration = Math.max(0, Math.floor(clampNumber(parsed.timerDuration, timerDuration)));
        timerRemaining = Math.max(0, Math.floor(clampNumber(parsed.timerRemaining, timerDuration)));
        roundName = typeof parsed.roundName === "string" && parsed.roundName.trim() ? parsed.roundName.trim() : roundName;
        eventTitle = typeof parsed.eventTitle === "string" && parsed.eventTitle.trim() ? parsed.eventTitle.trim() : eventTitle;
        sponsorLogos = normalizeSponsorLogos(parsed.sponsorLogos);
        liveMode = Boolean(parsed.liveMode);
        holdMode = Boolean(parsed.holdMode);
        viewMode = VALID_VIEWS.has(parsed.viewMode) ? parsed.viewMode : "all";
        allViewScroll = Math.max(0, Math.min(1000, Math.floor(clampNumber(parsed.allViewScroll, 0))));
        standbyMode = parsed.standbyMode === undefined ? true : Boolean(parsed.standbyMode);
        standbyMediaSrc = typeof parsed.standbyMediaSrc === "string" ? parsed.standbyMediaSrc : "";
        standbyMediaType = parsed.standbyMediaType === "video" ? "video" : (parsed.standbyMediaType === "image" ? "image" : "");
        standbyPlaylist = [];
        adCurrentIndex = 0;
        adHold = false;
        adSeekToken = 0;
        standbyFallbackMode = typeof parsed.standbyFallbackMode === "string" ? parsed.standbyFallbackMode : "message";
        const parsedFallbackData = parsed.standbyFallbackData && typeof parsed.standbyFallbackData === "object" ? parsed.standbyFallbackData : {};
        standbyFallbackData = {
            title: typeof parsedFallbackData.title === "string" ? parsedFallbackData.title : "Standby",
            subtitle: typeof parsedFallbackData.subtitle === "string" ? parsedFallbackData.subtitle : "Match starts soon",
            dvdImageSrc: typeof parsedFallbackData.dvdImageSrc === "string" ? parsedFallbackData.dvdImageSrc : ""
        };
        hotkeyBindings = sanitizeHotkeyBindings(parsed.hotkeyBindings);
        controlLockMode = Boolean(parsed.controlLockMode);
        operatorLog = sanitizeOperatorLog(parsed.operatorLog);
        shortcutDockCollapsed = Boolean(parsed.shortcutDockCollapsed);
        sfxClips = sanitizeSfxClips(parsed.sfxClips);
    } catch (error) {
        console.warn("Failed to load scoreboard state:", error);
    }
}

function applyShortcutDockState() {
    const dock = document.getElementById("shortcut-dock");
    const toggleBtn = document.getElementById("dock-toggle-btn");
    if (!dock || !toggleBtn) return;
    dock.classList.toggle("collapsed", shortcutDockCollapsed);
    toggleBtn.textContent = shortcutDockCollapsed ? "Expand" : "Collapse";
    toggleBtn.title = shortcutDockCollapsed ? "Expand shortcuts panel" : "Collapse shortcuts panel";
}

function toggleShortcutDock() {
    shortcutDockCollapsed = !shortcutDockCollapsed;
    applyShortcutDockState();
    saveState();
}

function formatLogTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
}

function addOperatorLog(action, details = "") {
    if (isHistoryRestoring) return;
    const safeAction = String(action || "").trim();
    if (!safeAction) return;
    const safeDetails = String(details || "").trim();
    const last = operatorLog[operatorLog.length - 1];
    if (last && last.action === safeAction && last.details === safeDetails) {
        return;
    }
    operatorLog.push({
        timestamp: new Date().toISOString(),
        action: safeAction,
        details: safeDetails
    });
    if (operatorLog.length > OPERATOR_LOG_LIMIT) {
        operatorLog = operatorLog.slice(-OPERATOR_LOG_LIMIT);
    }
    saveState();
    renderOperatorLogTable();
}

function runStartupChecks() {
    if (!Array.isArray(teams) || teams.length === 0) {
        showToast("Warning: no teams configured", "warn");
    } else {
        const placeholderOnly = teams.every((team, index) => {
            const fallback = DEFAULT_TEAMS[index];
            if (!fallback) return false;
            return team.name === fallback.name && team.score === 0 && !team.logo;
        });
        if (placeholderOnly) {
            showToast("Heads up: teams still on default placeholders", "warn");
        }
    }

    overlayChannelOnline = false;
    overlayHealthPending = true;
    updateStatusStrip();
    transport.send({ type: "health_ping" });
    if (overlayHealthTimeout) clearTimeout(overlayHealthTimeout);
    overlayHealthTimeout = setTimeout(() => {
        overlayHealthPending = false;
        updateStatusStrip();
        if (!overlayChannelOnline) {
            showToast("Overlay not detected on channel", "warn");
        }
    }, 1800);
}

function setStatusChipState(el, text, mode) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("ok", "warn", "off");
    if (mode) el.classList.add(mode);
}

function updateStatusStrip() {
    const overlayEl = document.getElementById("status-overlay");
    const liveEl = document.getElementById("status-live");
    const standbyEl = document.getElementById("status-standby");
    const lockEl = document.getElementById("status-lock");
    const timerStateEl = document.getElementById("status-timer");

    if (overlayHealthPending) {
        setStatusChipState(overlayEl, "Overlay: Checking", "warn");
    } else if (overlayChannelOnline) {
        setStatusChipState(overlayEl, "Overlay: Connected", "ok");
    } else {
        setStatusChipState(overlayEl, "Overlay: Offline", "off");
    }

    setStatusChipState(liveEl, `Live: ${liveMode ? "ON" : "OFF"}`, liveMode ? "ok" : "off");
    setStatusChipState(standbyEl, `Standby: ${standbyMode ? "ON" : "OFF"}`, standbyMode ? "ok" : "warn");
    setStatusChipState(lockEl, `Lock: ${controlLockMode ? "ON" : "OFF"}`, controlLockMode ? "warn" : "ok");

    let timerText = "Paused";
    let timerMode = "warn";
    if (timerRemaining <= 0) {
        timerText = "Finished";
        timerMode = "off";
    } else if (timerInterval) {
        timerText = "Running";
        timerMode = "ok";
    }
    setStatusChipState(timerStateEl, `Timer: ${timerText}`, timerMode);
}

function renderOperatorLogTable() {
    const tbody = document.getElementById("operator-log-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (operatorLog.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "log-empty";
        cell.textContent = "No operator activity yet.";
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }

    const entries = [...operatorLog].reverse();
    entries.forEach((entry) => {
        const row = document.createElement("tr");
        const timeCell = document.createElement("td");
        const actionCell = document.createElement("td");
        const detailsCell = document.createElement("td");
        timeCell.textContent = formatLogTime(entry.timestamp);
        actionCell.textContent = entry.action;
        detailsCell.textContent = entry.details || "-";
        row.appendChild(timeCell);
        row.appendChild(actionCell);
        row.appendChild(detailsCell);
        tbody.appendChild(row);
    });
}

function toggleTopMenu() {
    const menu = document.getElementById("top-menu");
    if (!menu) return;
    menu.classList.toggle("open");
}

function closeTopMenu() {
    const menu = document.getElementById("top-menu");
    if (!menu) return;
    menu.classList.remove("open");
}

function openOperatorLog() {
    closeTopMenu();
    const modal = document.getElementById("operator-log-modal");
    if (!modal) return;
    renderOperatorLogTable();
    modal.style.display = "flex";
}

function closeOperatorLog() {
    const modal = document.getElementById("operator-log-modal");
    if (!modal) return;
    modal.style.display = "none";
}

function resetMatch() {
    closeTopMenu();
    const firstConfirm = confirm("Reset current match state?");
    if (!firstConfirm) return;
    const token = prompt("Type RESET to confirm match reset:");
    if (token !== "RESET") {
        showToast("Match reset canceled", "info");
        return;
    }

    recordHistory();
    pauseTimer();

    teams = teams.map((team) => ({
        ...team,
        score: 0
    }));

    timerRemaining = timerDuration;
    holdMode = false;
    liveMode = false;
    standbyMode = true;
    viewMode = "all";
    allViewScroll = 0;
    adHold = false;
    adCurrentIndex = 0;
    adSeekToken += 1;

    renderTeams();
    updateTimerDisplay();
    syncTimerInputsFromState();
    syncButtonStates();
    updateAllTeamsScrollControls();
    saveState();
    broadcastControlState();
    updateAdStatus();
    addOperatorLog("Match Reset", "Scores and timer reset");
    showToast("Match reset complete", "warn");
}

function openHotkeySettings() {
    closeTopMenu();
    const modal = document.getElementById("hotkey-modal");
    if (!modal) return;
    renderHotkeyList();
    updateHotkeyEditorInput();
    modal.style.display = "flex";
}

function closeHotkeySettings() {
    const modal = document.getElementById("hotkey-modal");
    if (!modal) return;
    modal.style.display = "none";
}

function openAddTeamModal() {
    const modal = document.getElementById("add-team-modal");
    if (!modal) return;

    const nameInput = document.getElementById("add-team-name");
    const scoreInput = document.getElementById("add-team-score");
    const widthRange = document.getElementById("add-team-logo-width");
    const widthNumber = document.getElementById("add-team-logo-width-num");
    const colorInput = document.getElementById("add-team-color");
    const colorText = document.getElementById("add-team-color-text");
    const logoInput = document.getElementById("add-team-logo-file");
    const logoPreview = document.getElementById("add-team-logo-preview");

    addTeamLogoData = "";
    if (nameInput) nameInput.value = "";
    if (scoreInput) scoreInput.value = "0";
    if (widthRange) widthRange.value = String(TEAM_LOGO_FIXED_SIZE);
    if (widthNumber) widthNumber.value = String(TEAM_LOGO_FIXED_SIZE);
    if (colorInput) colorInput.value = "#44d07c";
    if (colorText) colorText.value = "#44d07c";
    if (logoInput) logoInput.value = "";
    if (logoPreview) {
        logoPreview.removeAttribute("src");
        logoPreview.style.display = "none";
    }

    modal.style.display = "flex";
    if (nameInput) {
        setTimeout(() => {
            nameInput.focus();
        }, 0);
    }
}

function closeAddTeamModal() {
    const modal = document.getElementById("add-team-modal");
    if (!modal) return;
    modal.style.display = "none";
}

function handleAddTeamLogoFile(event) {
    const input = event?.target;
    const file = input?.files?.[0];
    const preview = document.getElementById("add-team-logo-preview");
    if (!file) {
        addTeamLogoData = "";
        if (preview) {
            preview.removeAttribute("src");
            preview.style.display = "none";
        }
        return;
    }

    const name = String(file.name || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    const isAllowedType = ["image/png", "image/jpeg", "image/gif"].includes(type)
        || /\.(png|jpe?g|gif)$/i.test(name);
    if (!isAllowedType) {
        showToast("Logo must be PNG, JPG, or GIF", "warn");
        addTeamLogoData = "";
        if (input) input.value = "";
        if (preview) {
            preview.removeAttribute("src");
            preview.style.display = "none";
        }
        return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
        addTeamLogoData = typeof ev.target?.result === "string" ? ev.target.result : "";
        if (preview && addTeamLogoData) {
            preview.src = addTeamLogoData;
            preview.style.display = "block";
        }
    };
    reader.readAsDataURL(file);
}

function initAddTeamModal() {
    const widthRange = document.getElementById("add-team-logo-width");
    const widthNumber = document.getElementById("add-team-logo-width-num");
    const colorInput = document.getElementById("add-team-color");
    const colorText = document.getElementById("add-team-color-text");
    const logoInput = document.getElementById("add-team-logo-file");
    const nameInput = document.getElementById("add-team-name");

    if (widthRange && widthNumber) {
        widthRange.addEventListener("input", () => {
            widthNumber.value = widthRange.value;
        });
        widthNumber.addEventListener("input", () => {
            const safe = Math.max(60, Math.min(240, Math.floor(Number(widthNumber.value) || TEAM_LOGO_FIXED_SIZE)));
            widthNumber.value = String(safe);
            widthRange.value = String(safe);
        });
    }

    if (colorInput && colorText) {
        colorInput.addEventListener("input", () => {
            colorText.value = colorInput.value;
        });
        colorText.addEventListener("change", () => {
            const safe = sanitizeHexColor(colorText.value, colorInput.value);
            colorInput.value = safe;
            colorText.value = safe;
        });
    }

    if (logoInput) {
        logoInput.addEventListener("change", handleAddTeamLogoFile);
    }

    if (nameInput) {
        nameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                createTeamFromModal();
            }
        });
    }
}

function createTeamFromModal() {
    const nameInput = document.getElementById("add-team-name");
    const scoreInput = document.getElementById("add-team-score");
    const widthInput = document.getElementById("add-team-logo-width-num");
    const colorText = document.getElementById("add-team-color-text");

    const name = String(nameInput?.value || "").trim();
    if (!name) {
        showToast("Team name is required", "warn");
        if (nameInput) nameInput.focus();
        return;
    }

    const score = Math.max(0, Math.floor(Number(scoreInput?.value) || 0));
    const logoWidth = Math.max(60, Math.min(240, Math.floor(Number(widthInput?.value) || TEAM_LOGO_FIXED_SIZE)));
    const teamColor = sanitizeHexColor(colorText?.value, "#44d07c");

    recordHistory();
    teams.push({
        name,
        score,
        logo: addTeamLogoData || "",
        logoWidth,
        logoHeight: null,
        teamColor
    });
    renderTeams();
    saveState();
    broadcastUpdate();
    addOperatorLog("Team Added", name);
    showToast(`${name} added`, "ok");
    closeAddTeamModal();
}

function clearOperatorLog() {
    if (operatorLog.length === 0) return;
    const confirmed = confirm("Clear operator activity log?");
    if (!confirmed) return;
    operatorLog = [];
    saveState();
    renderOperatorLogTable();
    showToast("Operator log cleared", "warn");
}

function initTopMenu() {
    document.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const menuRoot = target.closest(".topbar-tools");
        if (!menuRoot) {
            closeTopMenu();
        }
        const operatorBackdrop = target.closest("#operator-log-modal");
        if (operatorBackdrop && target.id === "operator-log-modal") {
            closeOperatorLog();
        }
        const hotkeyBackdrop = target.closest("#hotkey-modal");
        if (hotkeyBackdrop && target.id === "hotkey-modal") {
            closeHotkeySettings();
        }
        const addTeamBackdrop = target.closest("#add-team-modal");
        if (addTeamBackdrop && target.id === "add-team-modal") {
            closeAddTeamModal();
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeTopMenu();
            closeOperatorLog();
            closeHotkeySettings();
            closeAddTeamModal();
        }
    });
}

function syncButtonStates() {
    const liveBtn = document.getElementById("live-btn");
    liveBtn.textContent = liveMode ? "Live: ON" : "Live: OFF";
    liveBtn.classList.toggle("is-on", liveMode);
    document.getElementById("hold-btn").textContent = holdMode ? "Hold: ON" : "Hold: OFF";
    document.getElementById("standby-btn").textContent = standbyMode ? "Standby: ON" : "Standby: OFF";
    const lockBtn = document.getElementById("lock-btn");
    if (lockBtn) lockBtn.textContent = controlLockMode ? "Lock: ON" : "Lock: OFF";
    const winnerBtn = document.getElementById("winner-btn");
    if (winnerBtn) {
        winnerBtn.textContent = winnerFxActive ? "Winner FX: ON" : "Winner FX: OFF";
        winnerBtn.classList.toggle("is-on", winnerFxActive);
    }
    document.querySelectorAll(".view-btn").forEach((btn) => btn.classList.remove("active"));
    const activeViewButton = document.getElementById(`btn-${viewMode}`);
    if (activeViewButton) activeViewButton.classList.add("active");
    updateAllTeamsScrollControls();
    updateStatusStrip();
}

function syncEventHeaderControls() {
    const titleInput = document.getElementById("event-title-input");
    if (titleInput) {
        titleInput.value = eventTitle || "";
    }
}

function updateAllTeamsScrollControls() {
    const range = document.getElementById("all-scroll-range");
    const value = document.getElementById("all-scroll-value");
    const resetBtn = document.getElementById("all-scroll-reset-btn");
    const row = document.querySelector(".all-scroll-row");
    const safe = Math.max(0, Math.min(1000, Math.floor(Number(allViewScroll) || 0)));
    const enabled = viewMode === "all";

    if (range) {
        range.value = String(safe);
        range.disabled = !enabled || controlLockMode;
    }
    if (value) {
        value.textContent = `${Math.round((safe / 1000) * 100)}%`;
    }
    if (resetBtn) {
        resetBtn.disabled = !enabled || controlLockMode;
    }
    if (row) {
        row.style.opacity = enabled ? "1" : "0.6";
    }
}

function setAllTeamsScroll(rawValue) {
    const safe = Math.max(0, Math.min(1000, Math.floor(Number(rawValue) || 0)));
    if (safe === allViewScroll) {
        updateAllTeamsScrollControls();
        return;
    }
    allViewScroll = safe;
    updateAllTeamsScrollControls();
    saveState();
    broadcastControlState();
    if (liveMode) broadcastUpdate();
}

function resetAllTeamsScroll() {
    setAllTeamsScroll(0);
}

function applyControlLockState() {
    const interactive = document.querySelectorAll("button, input, select, textarea");
    interactive.forEach((el) => {
        const htmlEl = el;
        if (htmlEl.id === "lock-btn" || htmlEl.hasAttribute("data-lock-exempt")) {
            htmlEl.disabled = false;
            return;
        }
        htmlEl.disabled = controlLockMode;
    });
    updateHistoryButtons();
    renderSfxButtonsState();
}

function toggleControlLock() {
    controlLockMode = !controlLockMode;
    syncButtonStates();
    applyControlLockState();
    saveState();
    addOperatorLog(controlLockMode ? "Controls Locked" : "Controls Unlocked", "");
    showToast(controlLockMode ? "Controls locked" : "Controls unlocked", controlLockMode ? "warn" : "ok");
}

function getSfxLabel(key) {
    return String(key || "")
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function normalizeSfxKey(value) {
    const normalized = String(value || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    return normalized;
}

function formatSfxDuration(seconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const remainSeconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainSeconds}`;
}

function formatSfxTimePair(currentSeconds, totalSeconds) {
    const hasTotal = Number.isFinite(totalSeconds) && totalSeconds > 0;
    const current = formatSfxDuration(currentSeconds);
    const total = hasTotal ? formatSfxDuration(totalSeconds) : "--:--";
    return `${current} / ${total}`;
}

function getSfxDurationText(key) {
    const duration = sfxClipDurations[key];
    if (Number.isFinite(duration) && duration > 0) {
        return `Duration: ${formatSfxDuration(duration)}`;
    }
    return "Duration: --:--";
}

function getSfxProgressValue(key) {
    if (!activeSfxAudio || activeSfxKey !== key) return 0;
    const duration = Number(activeSfxAudio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.round((Math.max(0, activeSfxAudio.currentTime) / duration) * 1000);
}

function getSfxProgressText(key) {
    const clipDuration = Number(sfxClipDurations[key]);
    if (!activeSfxAudio || activeSfxKey !== key) {
        return formatSfxTimePair(0, clipDuration);
    }
    const current = Number(activeSfxAudio.currentTime);
    const duration = Number(activeSfxAudio.duration);
    return formatSfxTimePair(current, duration || clipDuration);
}

function updateActiveSfxProgressUI() {
    if (!activeSfxKey || !activeSfxAudio) return;
    const slot = document.querySelector(`.sfx-slot[data-sfx-key="${activeSfxKey}"]`);
    if (!slot) return;

    const timeEl = slot.querySelector(".sfx-progress-time");
    const rangeEl = slot.querySelector(".sfx-progress-range");
    if (timeEl) timeEl.textContent = getSfxProgressText(activeSfxKey);
    if (rangeEl) rangeEl.value = String(getSfxProgressValue(activeSfxKey));
}

function seekSfxToValue(key, sliderValue) {
    if (!key || !Object.prototype.hasOwnProperty.call(sfxClips, key)) return;
    if (!activeSfxAudio || activeSfxKey !== key) return;

    const duration = Number(activeSfxAudio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const normalized = Math.max(0, Math.min(1000, Math.floor(Number(sliderValue) || 0)));
    activeSfxAudio.currentTime = (normalized / 1000) * duration;
    updateActiveSfxProgressUI();
}

function loadSfxDuration(key, src) {
    if (!key || !src || sfxDurationLoadingKeys.has(key)) return;
    sfxDurationLoadingKeys.add(key);

    const probe = new Audio();
    probe.preload = "metadata";
    probe.src = src;

    const clearLoading = () => {
        sfxDurationLoadingKeys.delete(key);
    };

    probe.addEventListener("loadedmetadata", () => {
        const duration = Number(probe.duration);
        sfxClipDurations[key] = Number.isFinite(duration) ? duration : 0;
        clearLoading();
        renderSfxButtonsState();
    }, { once: true });

    probe.addEventListener("error", () => {
        sfxClipDurations[key] = 0;
        clearLoading();
        renderSfxButtonsState();
    }, { once: true });
}

function ensureSfxAudio() {
    if (activeSfxAudio) return activeSfxAudio;
    activeSfxAudio = new Audio();
    activeSfxAudio.preload = "auto";
    activeSfxAudio.addEventListener("timeupdate", updateActiveSfxProgressUI);
    activeSfxAudio.addEventListener("loadedmetadata", updateActiveSfxProgressUI);
    activeSfxAudio.addEventListener("ended", () => {
        activeSfxKey = "";
        sfxPaused = false;
        renderSfxButtonsState();
    });
    return activeSfxAudio;
}

function renderSfxButtonsState() {
    const list = document.getElementById("sfx-list");
    if (list) {
        list.innerHTML = "";
        const keys = Object.keys(sfxClips);
        if (keys.length === 0) {
            const empty = document.createElement("div");
            empty.className = "team-empty";
            empty.textContent = "No SFX slots. Add one using the field above.";
            list.appendChild(empty);
        } else {
            keys.forEach((key) => {
                const slot = document.createElement("div");
                slot.className = "sfx-slot";
                slot.dataset.sfxKey = key;
                if (activeSfxKey === key) slot.classList.add("is-active");

                const title = document.createElement("strong");
                title.textContent = getSfxLabel(key);
                slot.appendChild(title);

                const hasClip = Boolean(sfxClips[key]);
                if (hasClip && !Object.prototype.hasOwnProperty.call(sfxClipDurations, key)) {
                    loadSfxDuration(key, sfxClips[key]);
                }

                const duration = document.createElement("span");
                duration.className = "sfx-duration";
                duration.textContent = getSfxDurationText(key);
                slot.appendChild(duration);

                const progressWrap = document.createElement("div");
                progressWrap.className = "sfx-progress";

                const progressTime = document.createElement("span");
                progressTime.className = "sfx-progress-time";
                progressTime.textContent = getSfxProgressText(key);
                progressWrap.appendChild(progressTime);

                const progress = document.createElement("input");
                progress.type = "range";
                progress.min = "0";
                progress.max = "1000";
                progress.step = "1";
                progress.value = String(getSfxProgressValue(key));
                progress.className = "sfx-progress-range";
                progress.disabled = controlLockMode || !hasClip || activeSfxKey !== key;
                progress.addEventListener("input", () => seekSfxToValue(key, progress.value));
                progressWrap.appendChild(progress);

                slot.appendChild(progressWrap);

                const actions = document.createElement("div");
                actions.className = "sfx-actions";

                const isActive = activeSfxKey === key;
                const isPlaying = Boolean(isActive && activeSfxAudio && !activeSfxAudio.paused && !activeSfxAudio.ended);
                const isPaused = Boolean(isActive && sfxPaused);

                const playBtn = document.createElement("button");
                playBtn.textContent = isPlaying ? "Playing" : (isPaused ? "Resume" : "Play");
                playBtn.disabled = !hasClip || controlLockMode || isPlaying;
                playBtn.onclick = () => playSfx(key);
                actions.appendChild(playBtn);

                const pauseBtn = document.createElement("button");
                pauseBtn.textContent = isPaused ? "Paused" : "Pause";
                pauseBtn.disabled = controlLockMode || !isPlaying;
                pauseBtn.onclick = () => pauseSfx();
                actions.appendChild(pauseBtn);

                const uploadBtn = document.createElement("button");
                uploadBtn.textContent = "Upload";
                uploadBtn.disabled = controlLockMode;
                uploadBtn.onclick = () => uploadSfx(key);
                actions.appendChild(uploadBtn);

                const clearBtn = document.createElement("button");
                clearBtn.textContent = "Clear";
                clearBtn.disabled = !hasClip || controlLockMode;
                clearBtn.onclick = () => clearSfx(key);
                actions.appendChild(clearBtn);

                const removeBtn = document.createElement("button");
                removeBtn.textContent = "Remove";
                removeBtn.disabled = controlLockMode;
                removeBtn.onclick = () => removeSfxSlot(key);
                actions.appendChild(removeBtn);

                slot.appendChild(actions);
                list.appendChild(slot);
            });
        }
    }
    const stopBtn = document.getElementById("sfx-stop-btn");
    if (stopBtn) stopBtn.disabled = !activeSfxKey || controlLockMode;
}

function uploadSfx(key) {
    if (!key || !Object.prototype.hasOwnProperty.call(sfxClips, key)) return;
    const input = document.getElementById("sfx-upload-input");
    if (!input) return;
    sfxUploadTargetKey = key;

    input.onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("audio/")) {
            showToast("Please select an audio file", "warn");
            input.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            recordHistory();
            if (!sfxUploadTargetKey) return;
            sfxClips[sfxUploadTargetKey] = ev.target.result;
            delete sfxClipDurations[sfxUploadTargetKey];
            sfxDurationLoadingKeys.delete(sfxUploadTargetKey);
            saveState();
            loadSfxDuration(sfxUploadTargetKey, sfxClips[sfxUploadTargetKey]);
            renderSfxButtonsState();
            addOperatorLog("SFX Uploaded", getSfxLabel(sfxUploadTargetKey));
            showToast(`${getSfxLabel(sfxUploadTargetKey)} SFX ready`, "ok");
            sfxUploadTargetKey = "";
        };
        reader.readAsDataURL(file);
        input.value = "";
    };
    input.click();
}

function playSfx(key) {
    if (!key || !Object.prototype.hasOwnProperty.call(sfxClips, key)) return;
    const src = sfxClips[key];
    if (!src) {
        showToast(`Upload ${getSfxLabel(key)} SFX first`, "warn");
        return;
    }
    const audio = ensureSfxAudio();
    if (!audio) return;
    const isSameClip = activeSfxKey === key && audio.src === src;
    activeSfxKey = key;
    if (!isSameClip) {
        audio.pause();
        audio.src = src;
        audio.currentTime = 0;
    }
    audio.play().catch(() => {});
    sfxPaused = false;
    renderSfxButtonsState();
    updateActiveSfxProgressUI();
}

function pauseSfx() {
    if (!activeSfxAudio || !activeSfxKey) return;
    if (activeSfxAudio.paused) return;
    activeSfxAudio.pause();
    sfxPaused = true;
    renderSfxButtonsState();
}

function stopSfx() {
    if (!activeSfxAudio) return;
    activeSfxAudio.pause();
    activeSfxAudio.currentTime = 0;
    activeSfxKey = "";
    sfxPaused = false;
    renderSfxButtonsState();
}

function clearSfx(key) {
    if (!key || !Object.prototype.hasOwnProperty.call(sfxClips, key)) return;
    if (!sfxClips[key]) return;
    recordHistory();
    if (activeSfxKey === key) {
        stopSfx();
    }
    sfxClips[key] = "";
    delete sfxClipDurations[key];
    sfxDurationLoadingKeys.delete(key);
    saveState();
    renderSfxButtonsState();
    addOperatorLog("SFX Cleared", getSfxLabel(key));
    showToast(`${getSfxLabel(key)} SFX cleared`, "info");
}

function addSfxSlot() {
    const input = document.getElementById("sfx-name-input");
    if (!input) return;
    const key = normalizeSfxKey(input.value);
    if (!key) {
        showToast("Enter an effect name first", "warn");
        return;
    }
    if (Object.prototype.hasOwnProperty.call(sfxClips, key)) {
        showToast("SFX slot already exists", "warn");
        return;
    }
    recordHistory();
    sfxClips[key] = "";
    input.value = "";
    saveState();
    renderSfxButtonsState();
    addOperatorLog("SFX Slot Added", getSfxLabel(key));
}

function removeSfxSlot(key) {
    if (!key || !Object.prototype.hasOwnProperty.call(sfxClips, key)) return;
    const keys = Object.keys(sfxClips);
    if (keys.length <= 1) {
        showToast("At least one SFX slot should remain", "warn");
        return;
    }
    recordHistory();
    if (activeSfxKey === key) stopSfx();
    delete sfxClips[key];
    delete sfxClipDurations[key];
    sfxDurationLoadingKeys.delete(key);
    saveState();
    renderSfxButtonsState();
    addOperatorLog("SFX Slot Removed", getSfxLabel(key));
}

function updateModeDateTime() {
    const dateEl = document.getElementById("mode-date");
    const timeEl = document.getElementById("mode-time");
    if (!dateEl || !timeEl) return;

    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "2-digit"
    });
    timeEl.textContent = now.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
}

function initModeDateTime() {
    updateModeDateTime();
    setInterval(updateModeDateTime, 1000);
}

function showToast(message, type = "info") {
    const stack = document.getElementById("toast-stack");
    if (!stack || !message) return;

    if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
    }

    stack.innerHTML = "";
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    stack.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, 220);
    }, 1800);
}

function getHotkeyHintElement() {
    return document.getElementById("hotkey-hint");
}

function getHotkeyActionSelect() {
    return document.getElementById("hotkey-action-select");
}

function getHotkeyInput() {
    return document.getElementById("hotkey-record-input");
}

function setHotkeyHint(message) {
    const hint = getHotkeyHintElement();
    if (!hint) return;
    hint.textContent = message;
}

function normalizeHotkeyToken(key) {
    if (!key) return "";
    if (key === " ") return "Space";
    if (key === "Escape") return "Esc";
    if (key.length === 1) return key.toUpperCase();
    return key;
}

function buildHotkeyFromEvent(event) {
    const key = normalizeHotkeyToken(event.key);
    if (!key || key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return "";

    const parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    parts.push(key);
    return parts.join("+");
}

function isTypingTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || "").toLowerCase();
    if (target.isContentEditable) return true;
    return tag === "input" || tag === "textarea" || tag === "select";
}

function getSelectedHotkeyAction() {
    const select = getHotkeyActionSelect();
    if (!select) return HOTKEY_ACTIONS[0];
    const value = select.value;
    return HOTKEY_ACTIONS.includes(value) ? value : HOTKEY_ACTIONS[0];
}

function updateHotkeyEditorInput() {
    const input = getHotkeyInput();
    if (!input) return;
    const action = getSelectedHotkeyAction();
    const value = hotkeyBindings[action] || "";
    input.value = value;
    if (!hotkeyCaptureMode) {
        setHotkeyHint("Press Record, then press your shortcut.");
    }
}

function renderHotkeyList() {
    const targets = [
        document.getElementById("hotkey-list"),
        document.getElementById("hotkey-list-dock")
    ].filter(Boolean);
    if (targets.length === 0) return;

    targets.forEach((list) => {
        list.innerHTML = "";
        HOTKEY_ACTIONS.forEach((action) => {
            const row = document.createElement("div");
            row.className = "hotkey-item";
            const label = HOTKEY_LABELS[action] || action;
            const value = hotkeyBindings[action] || "Unassigned";
            row.textContent = `${label}: ${value}`;
            list.appendChild(row);
        });
    });
}

function ensureUniqueHotkeyBinding(action, value) {
    HOTKEY_ACTIONS.forEach((key) => {
        if (key !== action && hotkeyBindings[key] === value) {
            hotkeyBindings[key] = "";
        }
    });
}

function toggleHotkeyRecording() {
    hotkeyCaptureMode = !hotkeyCaptureMode;
    hotkeyCapturedValue = "";

    const btn = document.getElementById("hotkey-record-btn");
    if (btn) {
        btn.textContent = hotkeyCaptureMode ? "Listening..." : "Record";
    }

    if (hotkeyCaptureMode) {
        setHotkeyHint("Press any key combination now.");
    } else {
        updateHotkeyEditorInput();
    }
}

function saveHotkeyBinding() {
    const action = getSelectedHotkeyAction();
    const input = getHotkeyInput();
    if (!input) return;

    const value = (input.value || "").trim();
    ensureUniqueHotkeyBinding(action, value);
    hotkeyBindings[action] = value;
    hotkeyCaptureMode = false;
    hotkeyCapturedValue = "";

    const btn = document.getElementById("hotkey-record-btn");
    if (btn) btn.textContent = "Record";

    saveState();
    renderHotkeyList();
    updateHotkeyEditorInput();
    setHotkeyHint("Hotkey saved.");
}

function clearHotkeyBinding() {
    const action = getSelectedHotkeyAction();
    hotkeyBindings[action] = "";
    hotkeyCaptureMode = false;
    hotkeyCapturedValue = "";

    const btn = document.getElementById("hotkey-record-btn");
    if (btn) btn.textContent = "Record";

    saveState();
    renderHotkeyList();
    updateHotkeyEditorInput();
    setHotkeyHint("Hotkey cleared.");
}

function resetHotkeyBindings() {
    hotkeyBindings = { ...DEFAULT_HOTKEY_BINDINGS };
    hotkeyCaptureMode = false;
    hotkeyCapturedValue = "";

    const btn = document.getElementById("hotkey-record-btn");
    if (btn) btn.textContent = "Record";

    saveState();
    renderHotkeyList();
    updateHotkeyEditorInput();
    setHotkeyHint("Hotkeys reset to defaults.");
}

function executeHotkeyAction(action) {
    if (action === "toggleLive") {
        toggleLive();
        return;
    }
    if (action === "toggleStandby") {
        toggleStandby();
        return;
    }
    if (action === "toggleHold") {
        toggleHold();
        return;
    }
    if (action === "startPauseTimer") {
        if (timerInterval) {
            pauseTimer();
        } else {
            startTimer();
        }
        return;
    }
    if (action === "resetTimer") {
        resetTimer();
        return;
    }
    if (action === "add10Seconds") {
        addSeconds(10);
        return;
    }
    if (action === "add20Seconds") {
        addSeconds(20);
        return;
    }
    if (action === "testSnow") {
        testFallbackSnow();
        return;
    }
    if (action === "undo") {
        undoAction();
        return;
    }
    if (action === "redo") {
        redoAction();
    }
}

function findActionByHotkey(combo) {
    return HOTKEY_ACTIONS.find((action) => hotkeyBindings[action] === combo) || "";
}

function onGlobalHotkeyKeydown(event) {
    if (controlLockMode) return;

    if (hotkeyCaptureMode) {
        const combo = buildHotkeyFromEvent(event);
        if (!combo) return;
        event.preventDefault();
        hotkeyCaptureMode = false;
        hotkeyCapturedValue = combo;

        const btn = document.getElementById("hotkey-record-btn");
        if (btn) btn.textContent = "Record";

        const input = getHotkeyInput();
        if (input) input.value = hotkeyCapturedValue;
        setHotkeyHint("Captured. Click Save to apply.");
        return;
    }

    if (isTypingTarget(event.target) || event.repeat) return;

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = String(event.key || "").toLowerCase();
        if (key === "z" && !event.shiftKey) {
            event.preventDefault();
            undoAction();
            return;
        }
        if (key === "y" || (key === "z" && event.shiftKey)) {
            event.preventDefault();
            redoAction();
            return;
        }
    }

    const combo = buildHotkeyFromEvent(event);
    if (!combo) return;
    const action = findActionByHotkey(combo);
    if (!action) return;

    event.preventDefault();
    executeHotkeyAction(action);
}

function initHotkeyUI() {
    const select = getHotkeyActionSelect();
    if (!select) return;

    select.innerHTML = "";
    HOTKEY_ACTIONS.forEach((action) => {
        const option = document.createElement("option");
        option.value = action;
        option.textContent = HOTKEY_LABELS[action] || action;
        select.appendChild(option);
    });

    select.addEventListener("change", () => {
        updateHotkeyEditorInput();
    });

    renderHotkeyList();
    updateHotkeyEditorInput();
    document.addEventListener("keydown", onGlobalHotkeyKeydown);
}

function getMediaLibrarySelect() {
    return document.getElementById("standby-media-select");
}

function renderStandbyLibrarySelect() {
    const select = getMediaLibrarySelect();
    if (!select) return;

    select.innerHTML = "";
    if (standbyLibrary.length === 0) {
        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = "No ads loaded";
        select.appendChild(emptyOption);
        return;
    }

    standbyLibrary.forEach((item, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${item.name} (${item.type})`;
        select.appendChild(option);
    });

    updateAdStatus();
}

function updateAdStatus() {
    const adStatus = document.getElementById("ad-status");
    if (!adStatus) return;
    const liveAdText = standbyMediaSrc ? `Overlay Ad: loaded (${standbyMediaType || "image"})` : "Overlay Ad: none";
    const previewText = pendingAdMediaSrc ? `Preview: ready (${pendingAdMediaType || "image"})` : "Preview: empty";
    adStatus.textContent = `${liveAdText} | ${previewText} | Fallback: ${standbyFallbackMode}`;
}

function syncAdStartIndexInput() {
    const input = document.getElementById("ad-start-index");
    if (!input) return;
    input.value = String(adCurrentIndex + 1);
}

function renderAdPreview() {
    const previewImage = document.getElementById("ad-preview-image");
    const previewVideo = document.getElementById("ad-preview-video");
    const previewName = document.getElementById("ad-preview-name");
    if (!previewImage || !previewVideo || !previewName) return;

    previewImage.style.display = "none";
    previewVideo.style.display = "none";
    previewVideo.pause();
    previewVideo.currentTime = 0;
    setAdPreviewControlsEnabled(false);
    updateAdPreviewTime();

    if (!pendingAdMediaSrc) {
        previewName.textContent = "No media selected";
        return;
    }

    previewName.textContent = pendingAdMediaName || "Selected media";
    if (pendingAdMediaType === "video") {
        previewVideo.src = pendingAdMediaSrc;
        previewVideo.style.display = "block";
        setAdPreviewControlsEnabled(true);
        updateAdPreviewTime();
        previewVideo.play().catch(() => {});
    } else {
        previewImage.src = pendingAdMediaSrc;
        previewImage.style.display = "block";
    }
}

function formatMediaTime(seconds) {
    const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateAdPreviewTime() {
    const video = document.getElementById("ad-preview-video");
    const timeEl = document.getElementById("ad-preview-time");
    const seekEl = document.getElementById("ad-preview-seek");
    if (!video || !timeEl || !seekEl) return;

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const percent = duration > 0 ? Math.min(1000, Math.max(0, Math.floor((current / duration) * 1000))) : 0;
    seekEl.value = String(percent);
    timeEl.textContent = `${formatMediaTime(current)} / ${formatMediaTime(duration)}`;
}

function setAdPreviewControlsEnabled(enabled) {
    const controlsWrap = document.getElementById("ad-preview-controls");
    const timelineWrap = document.getElementById("ad-preview-timeline-wrap");
    const seekEl = document.getElementById("ad-preview-seek");
    const timeEl = document.getElementById("ad-preview-time");
    if (controlsWrap) {
        controlsWrap.querySelectorAll("button").forEach((btn) => {
            btn.disabled = !enabled || controlLockMode;
        });
    }
    if (timelineWrap) {
        timelineWrap.style.opacity = enabled ? "1" : "0.55";
    }
    if (seekEl) seekEl.disabled = !enabled || controlLockMode;
    if (timeEl && !enabled) timeEl.textContent = "00:00 / 00:00";
}

function previewPlayPause() {
    const previewVideo = document.getElementById("ad-preview-video");
    if (!previewVideo || previewVideo.style.display !== "block") return;
    if (previewVideo.paused) {
        previewVideo.play().catch(() => {});
    } else {
        previewVideo.pause();
    }
}

function previewStop() {
    const previewVideo = document.getElementById("ad-preview-video");
    if (!previewVideo || previewVideo.style.display !== "block") return;
    previewVideo.pause();
    previewVideo.currentTime = 0;
    updateAdPreviewTime();
}

function previewSeek(deltaSeconds) {
    const previewVideo = document.getElementById("ad-preview-video");
    if (!previewVideo || previewVideo.style.display !== "block") return;
    const duration = Number.isFinite(previewVideo.duration) ? previewVideo.duration : 0;
    if (duration <= 0) return;
    const next = Math.min(duration, Math.max(0, previewVideo.currentTime + Number(deltaSeconds || 0)));
    previewVideo.currentTime = next;
    updateAdPreviewTime();
}

function initAdPreviewPlayer() {
    const previewVideo = document.getElementById("ad-preview-video");
    const seekEl = document.getElementById("ad-preview-seek");
    if (!previewVideo || !seekEl) return;

    const sync = () => updateAdPreviewTime();
    previewVideo.addEventListener("loadedmetadata", sync);
    previewVideo.addEventListener("timeupdate", sync);
    previewVideo.addEventListener("seeking", sync);
    previewVideo.addEventListener("seeked", sync);
    previewVideo.addEventListener("durationchange", sync);
    previewVideo.addEventListener("ended", () => {
        updateAdPreviewTime();
    });

    seekEl.addEventListener("input", () => {
        const duration = Number.isFinite(previewVideo.duration) ? previewVideo.duration : 0;
        if (duration <= 0) return;
        const ratio = Number(seekEl.value) / 1000;
        previewVideo.currentTime = Math.max(0, Math.min(duration, duration * ratio));
        updateAdPreviewTime();
    });
}

function syncFallbackControlsFromState() {
    const modeSelect = document.getElementById("fallback-mode");
    const titleInput = document.getElementById("fallback-title");
    const subtitleInput = document.getElementById("fallback-subtitle");
    if (!modeSelect || !titleInput || !subtitleInput) return;

    modeSelect.value = standbyFallbackMode;
    titleInput.value = standbyFallbackData.title || "";
    subtitleInput.value = standbyFallbackData.subtitle || "";
}

function getActiveAdPlaylist() {
    const fromState = Array.isArray(standbyPlaylist) && standbyPlaylist.length > 0 ? standbyPlaylist : standbyLibrary;
    return fromState.filter((item) => item && typeof item.path === "string" && item.path.trim());
}

function updateNextAdPreview() {
    const nextImage = document.getElementById("ad-next-image");
    const nextVideo = document.getElementById("ad-next-video");
    const nextName = document.getElementById("ad-next-name");
    if (!nextImage || !nextVideo || !nextName) return;

    const playlist = getActiveAdPlaylist();
    if (playlist.length === 0) {
        nextImage.style.display = "none";
        nextVideo.style.display = "none";
        nextName.textContent = "No next ad";
        return;
    }

    const nextIndex = (adCurrentIndex + 1) % playlist.length;
    const item = playlist[nextIndex];
    const type = item.type === "video" ? "video" : "image";

    if (type === "video") {
        nextImage.style.display = "none";
        nextVideo.style.display = "block";
        nextVideo.src = item.path;
        nextVideo.play().catch(() => {});
    } else {
        nextVideo.style.display = "none";
        nextImage.style.display = "block";
        nextImage.src = item.path;
    }

    nextName.textContent = item.name || `Ad ${nextIndex + 1}`;
}

function syncTimerInputsFromState() {
    const minutesInput = document.getElementById("timer-minutes-input");
    const secondsInput = document.getElementById("timer-seconds-input");
    if (!minutesInput || !secondsInput) return;

    const minutes = Math.floor(timerRemaining / 60);
    const seconds = timerRemaining % 60;
    minutesInput.value = String(minutes);
    secondsInput.value = String(seconds);
}

function updateTimerBoardMeta() {
    const statusEl = document.getElementById("timer-status");
    const baseEl = document.getElementById("timer-base");
    if (baseEl) {
        baseEl.textContent = `Base: ${formatTime(timerDuration)}`;
    }

    if (!statusEl) return;
    statusEl.classList.remove("running", "paused", "finished");

    if (timerRemaining <= 0) {
        statusEl.textContent = "Finished";
        statusEl.classList.add("finished");
        updateStatusStrip();
        return;
    }

    if (timerInterval) {
        statusEl.textContent = "Running";
        statusEl.classList.add("running");
    } else {
        statusEl.textContent = "Paused";
        statusEl.classList.add("paused");
    }
    updateStatusStrip();
}

function normalizeManifestItem(item, index) {
    if (!item || typeof item.path !== "string" || !item.path.trim()) {
        return null;
    }

    const cleanPath = item.path.trim();
    const normalizedType = item.type === "video" ? "video" : (item.type === "image" ? "image" : "");
    const inferredType = normalizedType || (/\.(mp4|webm|ogg)$/i.test(cleanPath) ? "video" : "image");
    const safeName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `Media ${index + 1}`;

    return {
        name: safeName,
        path: cleanPath,
        type: inferredType
    };
}

function isMediaPath(path) {
    return /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|ogg|mov)$/i.test(path);
}

function detectMediaTypeFromPath(path) {
    return /\.(mp4|webm|ogg|mov)$/i.test(path) ? "video" : "image";
}

function detectMediaTypeFromFile(file) {
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("image/")) return "image";
    return detectMediaTypeFromPath(file.name);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
    });
}

function parseDirectoryListingHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll("a[href]"))
        .map((link) => link.getAttribute("href"))
        .filter(Boolean);

    const mediaItems = links
        .filter((href) => !href.startsWith("?") && !href.startsWith("#"))
        .map((href) => {
            const decoded = decodeURIComponent(href);
            const normalized = decoded.replace(/^\.?\//, "");
            return normalized;
        })
        .filter((href) => isMediaPath(href))
        .map((href, index) => {
            const path = `${ADVERTISEMENT_FOLDER_URL}${href}`;
            return normalizeManifestItem(
                {
                    name: href,
                    path,
                    type: detectMediaTypeFromPath(href)
                },
                index
            );
        })
        .filter(Boolean);

    return mediaItems;
}

function applyStandbyLibraryAsPlaylist() {
    recordHistory();
    standbyPlaylist = standbyLibrary.map((item) => ({ ...item }));
    adCurrentIndex = 0;
    adHold = false;
    adSeekToken += 1;
    if (standbyPlaylist.length > 0) {
        standbyMediaSrc = standbyPlaylist[0].path;
        standbyMediaType = standbyPlaylist[0].type;
        liveMode = false;
        standbyMode = true;
        syncButtonStates();
    } else {
        standbyMediaSrc = "";
        standbyMediaType = "";
    }

    saveState();
    broadcastControlState();
    updateAdStatus();
    syncAdStartIndexInput();
}

async function handleAdvertisementFolderSelection(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const mediaFiles = files.filter((file) => {
        if (file.type.startsWith("image/") || file.type.startsWith("video/")) return true;
        return isMediaPath(file.name);
    });

    if (mediaFiles.length === 0) {
        alert("No supported image/video files found in selected folder.");
        return;
    }

    const loadedItems = [];
    for (const file of mediaFiles) {
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const type = detectMediaTypeFromFile(file);
            const relativeName = file.webkitRelativePath || file.name;
            loadedItems.push({
                name: relativeName,
                path: dataUrl,
                type
            });
        } catch (error) {
            console.warn(error);
        }
    }

    standbyLibrary = loadedItems;
    renderStandbyLibrarySelect();
    applyStandbyLibraryAsPlaylist();

    if (loadedItems.length === 0) {
        alert("Files were selected, but none could be loaded.");
    }
}

function openAdvertisementFolderPicker() {
    const input = document.getElementById("advertisement-folder-input");
    if (!input) return;
    input.value = "";
    input.click();
}

async function loadStandbyLibrary() {
    try {
        standbyLibrary = [];

        try {
            const directoryResponse = await fetch(ADVERTISEMENT_FOLDER_URL, { cache: "no-store" });
            if (directoryResponse.ok) {
                const html = await directoryResponse.text();
                standbyLibrary = parseDirectoryListingHtml(html);
            }
        } catch (_error) {
            standbyLibrary = [];
        }

        if (standbyLibrary.length === 0) {
            const manifestResponse = await fetch(ADVERTISEMENT_MANIFEST_URL, { cache: "no-store" });
            if (!manifestResponse.ok) {
                throw new Error(`Manifest request failed (${manifestResponse.status})`);
            }

            const manifest = await manifestResponse.json();
            const items = Array.isArray(manifest) ? manifest : manifest.items;
            if (!Array.isArray(items)) {
                throw new Error("Manifest must be an array or an object with an 'items' array.");
            }

            standbyLibrary = items
                .map((item, index) => normalizeManifestItem(item, index))
                .filter(Boolean);
        }

        renderStandbyLibrarySelect();
        applyStandbyLibraryAsPlaylist();

        if (standbyLibrary.length === 0) {
            alert("No valid image/video files found in Advertisement folder.");
        }
    } catch (error) {
        console.warn("Failed to load standby media library:", error);
        alert("Could not load Advertisement folder. If folder listing is blocked by your server, create Advertisement/advertisement-manifest.json.");
    }
}

function useSelectedStandbyMedia() {
    const select = getMediaLibrarySelect();
    if (!select || !select.value) {
        alert("Select a media item first.");
        return;
    }

    const selectedIndex = Number(select.value);
    const selectedItem = standbyLibrary[selectedIndex];
    if (!selectedItem) {
        alert("Invalid media selection.");
        return;
    }

    // Start from selected item, but keep full playlist active.
    const playlist = getActiveAdPlaylist();
    if (playlist.length > 0) {
        standbyPlaylist = playlist.map((item) => ({ ...item }));
        adCurrentIndex = selectedIndex % standbyPlaylist.length;
    } else {
        standbyPlaylist = [{ ...selectedItem }];
        adCurrentIndex = 0;
    }

    standbyMediaSrc = selectedItem.path;
    standbyMediaType = selectedItem.type;
    adHold = false;
    adSeekToken += 1;
    saveState();
    broadcastControlState();
    updateAdStatus();
    syncAdStartIndexInput();
}

function changeViewMode(mode) {
    if (!VALID_VIEWS.has(mode)) return;
    if (viewMode === mode) return;
    recordHistory();
    viewMode = mode;
    syncButtonStates();
    saveState();
    broadcastUpdate();
    addOperatorLog("View Changed", mode.toUpperCase());
}

function toggleLive() {
    recordHistory();
    liveMode = !liveMode;
    if (liveMode) {
        standbyMode = false;
    } else {
        winnerFxActive = false;
        transport.send({ type: "winner_command", action: "stop" });
    }
    syncButtonStates();
    saveState();
    broadcastControlState();
    if (liveMode) broadcastUpdate();
    addOperatorLog("Live Toggled", liveMode ? "ON" : "OFF");
    showToast(liveMode ? "Live mode enabled" : "Live mode disabled", liveMode ? "ok" : "warn");
}

function toggleHold() {
    recordHistory();
    holdMode = !holdMode;
    syncButtonStates();
    saveState();
    broadcastUpdate();
    addOperatorLog("Hold Toggled", holdMode ? "ON" : "OFF");
    showToast(holdMode ? "Hold enabled" : "Hold disabled", holdMode ? "warn" : "info");
}

function toggleStandby() {
    recordHistory();
    standbyMode = !standbyMode;
    if (standbyMode) {
        liveMode = false;
        winnerFxActive = false;
        transport.send({ type: "winner_command", action: "stop" });
        pauseTimer();
    }
    syncButtonStates();
    saveState();
    broadcastControlState();
    addOperatorLog("Standby Toggled", standbyMode ? "ON" : "OFF");
    showToast(standbyMode ? "Standby enabled" : "Standby disabled", standbyMode ? "ok" : "info");
}

function broadcastUpdate() {
    if (!liveMode) return;

    transport.send({
        type: "update",
        teams,
        timer: timerRemaining,
        round: roundName,
        eventTitle,
        sponsorLogos,
        hold: holdMode,
        view: viewMode,
        allViewScroll,
        live: liveMode
    });
}

function broadcastControlState() {
    transport.send({
        type: "control_state",
        live: liveMode,
        standby: standbyMode,
        eventTitle,
        sponsorLogos,
        allViewScroll,
        standbyMediaSrc,
        standbyMediaType,
        standbyPlaylist,
        adCurrentIndex,
        adHold,
        adSeekToken,
        standbyFallbackMode,
        standbyFallbackData
    });
}

function sendAdCommand(action) {
    transport.send({
        type: "ad_command",
        action
    });
}

function triggerWinnerCelebration() {
    if (!liveMode) {
        showToast("Turn Live ON before triggering winner celebration", "warn");
        return;
    }
    const leader = [...teams].sort((a, b) => b.score - a.score)[0];
    winnerFxActive = !winnerFxActive;
    syncButtonStates();
    transport.send({
        type: "winner_command",
        action: winnerFxActive ? "start" : "stop",
        teamName: leader?.name || "Winner"
    });
    addOperatorLog("Winner FX Toggled", `${winnerFxActive ? "ON" : "OFF"} - ${leader?.name || "Winner"}`);
    showToast(`Winner FX ${winnerFxActive ? "ON" : "OFF"}`, winnerFxActive ? "ok" : "info");
}

function goToPreviousAd() {
    const playlist = getActiveAdPlaylist();
    const length = playlist.length;
    if (!length) return;
    recordHistory();
    adHold = false;
    adCurrentIndex = (adCurrentIndex - 1 + length) % length;
    adSeekToken += 1;
    saveState();
    broadcastControlState();
    updateAdStatus();
    syncAdStartIndexInput();
}

function goToNextAd() {
    const playlist = getActiveAdPlaylist();
    const length = playlist.length;
    if (!length) return;
    recordHistory();
    adHold = false;
    adCurrentIndex = (adCurrentIndex + 1) % length;
    adSeekToken += 1;
    saveState();
    broadcastControlState();
    updateAdStatus();
    syncAdStartIndexInput();
}

function toggleAdHold() {
    recordHistory();
    adHold = !adHold;
    saveState();
    broadcastControlState();
    updateAdStatus();
    syncAdStartIndexInput();
}

function showPreviewOnOverlay() {
    if (!pendingAdMediaSrc) {
        alert("Upload media first.");
        return;
    }
    recordHistory();

    standbyMediaSrc = pendingAdMediaSrc;
    standbyMediaType = pendingAdMediaType || "image";
    standbyPlaylist = [];
    standbyLibrary = [];
    adCurrentIndex = 0;
    adHold = false;
    adSeekToken += 1;
    liveMode = false;
    standbyMode = true;
    syncButtonStates();
    saveState();
    broadcastControlState();
    updateAdStatus();
    addOperatorLog("Ad Published", pendingAdMediaName || "Uploaded media");
    showToast("Ad pushed to overlay", "ok");
}

function togglePreviewPlayback() {
    previewPlayPause();
}

function startSlideshowAtIndex() {
    const input = document.getElementById("ad-start-index");
    const playlist = getActiveAdPlaylist();
    const length = playlist.length;
    if (!input || !length) return;

    const oneBased = Math.max(1, Math.floor(Number(input.value) || 1));
    recordHistory();
    adCurrentIndex = (oneBased - 1) % length;
    adHold = false;
    adSeekToken += 1;
    saveState();
    broadcastControlState();
    updateAdStatus();
    syncAdStartIndexInput();
}

function applyFallbackSettings() {
    const modeSelect = document.getElementById("fallback-mode");
    const titleInput = document.getElementById("fallback-title");
    const subtitleInput = document.getElementById("fallback-subtitle");
    if (!modeSelect || !titleInput || !subtitleInput) return;
    recordHistory();

    standbyFallbackMode = modeSelect.value || "message";
    standbyFallbackData = {
        title: (titleInput.value || "").trim() || "Standby",
        subtitle: (subtitleInput.value || "").trim() || "It Will Starts Soon",
        dvdImageSrc: standbyFallbackData.dvdImageSrc || ""
    };
    standbyMediaSrc = "";
    standbyMediaType = "";
    standbyPlaylist = [];
    standbyLibrary = [];
    adCurrentIndex = 0;
    adHold = false;
    adSeekToken += 1;
    standbyMode = true;
    liveMode = false;
    syncButtonStates();
    saveState();
    broadcastControlState();
    updateAdStatus();
    addOperatorLog("Fallback Applied", standbyFallbackMode);
    showToast("Fallback applied", "ok");
}

function applyEventTitle() {
    const input = document.getElementById("event-title-input");
    if (!input) return;
    const next = (input.value || "").trim() || "TITLE NAME EVENT";
    if (next === eventTitle) return;
    recordHistory();
    eventTitle = next;
    saveState();
    broadcastControlState();
    if (liveMode) broadcastUpdate();
    addOperatorLog("Event Title Updated", eventTitle);
    showToast("Event title updated", "info");
}

function uploadSponsorLogo(slot) {
    const safeSlot = ["1", "2", "3", "4"].includes(String(slot)) ? String(slot) : "1";
    const input = document.getElementById(`sponsor-${safeSlot}-upload`);
    if (!input) return;

    input.onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            alert("Please select an image file.");
            input.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            recordHistory();
            sponsorLogos[safeSlot] = ev.target.result;
            saveState();
            broadcastControlState();
            if (liveMode) broadcastUpdate();
            const slotLabel = getSponsorSlotLabel(safeSlot);
            addOperatorLog("Sponsor Logo Updated", slotLabel);
            showToast(`Sponsor logo ${slotLabel} updated`, "ok");
        };
        reader.readAsDataURL(file);
        input.value = "";
    };
    input.click();
}

function clearSponsorLogo(slot) {
    const safeSlot = ["1", "2", "3", "4"].includes(String(slot)) ? String(slot) : "1";
    if (!sponsorLogos[safeSlot]) return;
    recordHistory();
    sponsorLogos[safeSlot] = "";
    saveState();
    broadcastControlState();
    if (liveMode) broadcastUpdate();
    const slotLabel = getSponsorSlotLabel(safeSlot);
    addOperatorLog("Sponsor Logo Cleared", slotLabel);
    showToast(`Sponsor logo ${slotLabel} cleared`, "warn");
}

function uploadFallbackDvdImage() {
    const input = document.getElementById("fallback-dvd-upload");
    if (!input) return;

    input.onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            alert("Please select an image file.");
            input.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            recordHistory();
            standbyFallbackData.dvdImageSrc = ev.target.result;
            saveState();
            broadcastControlState();
            updateAdStatus();
        };
        reader.readAsDataURL(file);
        input.value = "";
    };

    input.click();
}

function clearFallbackDvdImage() {
    if (!standbyFallbackData.dvdImageSrc) return;
    recordHistory();
    standbyFallbackData.dvdImageSrc = "";
    saveState();
    broadcastControlState();
    updateAdStatus();
    addOperatorLog("DVD Image Cleared", "");
}

function testFallbackSnow() {
    transport.send({
        type: "fallback_command",
        action: "test_snow"
    });
}

function renderTeams() {
    teams = teams.map((team, index) => sanitizeTeam(team, `Team ${index + 1}`));
    const container = document.getElementById("teams-container");
    container.innerHTML = "";

    const normalizedQuery = teamSearchQuery.trim().toLowerCase();
    const teamsToRender = teams
        .map((team, index) => ({ team, index }))
        .filter((entry) => !normalizedQuery || entry.team.name.toLowerCase().includes(normalizedQuery));

    if (teamsToRender.length === 0) {
        const empty = document.createElement("div");
        empty.className = "team-empty";
        empty.textContent = "No teams match your search.";
        container.appendChild(empty);
        return;
    }

    teamsToRender.forEach(({ team, index }) => {
        const teamDiv = document.createElement("div");
        teamDiv.className = "team";
        if (team.teamColor) {
            teamDiv.style.borderColor = team.teamColor;
        }

        const logoWrap = document.createElement("div");
        logoWrap.className = "team-logo-wrap";

        if (team.logo) {
        const img = document.createElement("img");
        img.src = team.logo;
        img.alt = `${team.name} Logo`;
        img.className = "team-logo";

        logoWrap.appendChild(img);
    }else {
        const placeholder = document.createElement("div");
        placeholder.className = "team-logo-placeholder";
        placeholder.textContent = "No Logo";

        logoWrap.appendChild(placeholder);
}
        teamDiv.appendChild(logoWrap);

        const name = document.createElement("span");
        name.className = "team-name";
        name.textContent = team.name;
        teamDiv.appendChild(name);

        const scoreControls = document.createElement("div");
        scoreControls.className = "score-controls";

        const subBtn = document.createElement("button");
        subBtn.textContent = "-";
        subBtn.onclick = () => updateScore(index, -1);
        scoreControls.appendChild(subBtn);

        const score = document.createElement("span");
        score.className = "score";
        score.textContent = team.score;
        if (team.teamColor) score.style.color = team.teamColor;
        scoreControls.appendChild(score);

        const addBtn = document.createElement("button");
        addBtn.textContent = "+";
        addBtn.onclick = () => updateScore(index, 1);
        scoreControls.appendChild(addBtn);

        teamDiv.appendChild(scoreControls);

        const actionRow = document.createElement("div");
        actionRow.className = "team-actions";

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Remove";
        removeBtn.onclick = () => removeTeam(index);
        actionRow.appendChild(removeBtn);

        const logoBtn = document.createElement("button");
        logoBtn.textContent = "Logo";
        logoBtn.onclick = () => uploadLogo(index);
        actionRow.appendChild(logoBtn);

        const removeLogoBtn = document.createElement("button");
        removeLogoBtn.textContent = "Clear";
        removeLogoBtn.onclick = () => removeTeamLogo(index);
        actionRow.appendChild(removeLogoBtn);

        const sizeBtn = document.createElement("button");
        sizeBtn.textContent = "Fit150";
        sizeBtn.onclick = () => resizeTeamLogo(index);
        actionRow.appendChild(sizeBtn);

        const editBtn = document.createElement("button");
        editBtn.textContent = "Edit";
        editBtn.onclick = () => editTeamName(index);
        actionRow.appendChild(editBtn);

        teamDiv.appendChild(actionRow);

        container.appendChild(teamDiv);
    });
}

function uploadLogo(index) {
    const fileInput = document.getElementById("logo-upload");

    fileInput.onchange = (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function (ev) {
                recordHistory();
                teams[index].logo = ev.target.result;
                teams[index].logoWidth = TEAM_LOGO_FIXED_SIZE;
                teams[index].logoHeight = null;
                renderTeams();
                saveState();
                broadcastUpdate();
                addOperatorLog("Team Logo Updated", `${teams[index].name} (150px fit)`);
                showToast("Team logo applied (150px fit)", "ok");
            };
            reader.readAsDataURL(file);
        }
        fileInput.value = "";
    };
    fileInput.click();
}

function openLogoResizePanel(index, logoSrc) {
    const panel = document.getElementById("logo-resize-panel");
    const preview = document.getElementById("logo-preview");
    const sizeSlider = document.getElementById("logo-size-slider");
    const sizeInput = document.getElementById("logo-size-input");
    const sizeValue = document.getElementById("logo-size-value");
    const fitCheckbox = document.getElementById("logo-fit-box");
    const minSize = parseInt(sizeSlider.min, 10) || 20;
    const maxSize = parseInt(sizeSlider.max, 10) || 150;

    function clampLogoSize(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return minSize;
        return Math.min(maxSize, Math.max(minSize, Math.floor(num)));
    }

    function applySizeToPreview(nextSize) {
        const safeSize = clampLogoSize(nextSize);
        sizeSlider.value = String(safeSize);
        sizeInput.value = String(safeSize);
        sizeValue.textContent = String(safeSize);
        preview.style.width = `${safeSize}px`;
        preview.style.height = fitCheckbox.checked ? "auto" : `${safeSize}px`;
    }

    panel.style.display = "block";
    preview.src = logoSrc;
    sizeSlider.value = String(teams[index].logoWidth || 50);
    fitCheckbox.checked = teams[index].logoHeight === null;
    applySizeToPreview(sizeSlider.value);

    sizeSlider.oninput = () => {
        applySizeToPreview(sizeSlider.value);
    };

    sizeInput.oninput = () => {
        applySizeToPreview(sizeInput.value);
    };

    fitCheckbox.onchange = () => {
        applySizeToPreview(sizeSlider.value);
    };

    document.getElementById("logo-resize-ok").onclick = () => {
        recordHistory();
        const finalSize = clampLogoSize(sizeSlider.value);
        teams[index].logo = logoSrc;
        teams[index].logoWidth = finalSize;
        teams[index].logoHeight = fitCheckbox.checked ? null : finalSize;
        renderTeams();
        saveState();
        broadcastUpdate();
        panel.style.display = "none";
    };

    document.getElementById("logo-resize-cancel").onclick = () => {
        panel.style.display = "none";
    };
}

function resizeTeamLogo(index) {
    if (!teams[index]?.logo) {
        alert("Upload a logo first.");
        return;
    }
    recordHistory();
    teams[index].logoWidth = TEAM_LOGO_FIXED_SIZE;
    teams[index].logoHeight = null;
    renderTeams();
    saveState();
    broadcastUpdate();
    addOperatorLog("Team Logo Size Reset", `${teams[index].name} -> 150px fit`);
    showToast("Team logo size reset to 150px fit", "info");
}

function removeTeamLogo(index) {
    if (!teams[index]) return;
    if (!teams[index].logo) return;
    recordHistory();
    teams[index].logo = "";
    teams[index].logoWidth = TEAM_LOGO_FIXED_SIZE;
    teams[index].logoHeight = null;
    renderTeams();
    saveState();
    broadcastUpdate();
}

function updateScore(index, value) {
    const currentScore = Math.floor(clampNumber(teams[index]?.score, 0));
    const nextScore = Math.max(0, currentScore + value);
    if (nextScore === currentScore) return;
    recordHistory();
    teams[index].score = nextScore;
    renderTeams();
    saveState();
    broadcastUpdate();
    addOperatorLog("Score Updated", `${teams[index].name}: ${nextScore}`);
}

function addTeam() {
    if (controlLockMode) return;
    openAddTeamModal();
}

function editTeamName(index) {
    const currentName = teams[index]?.name || "";
    const nextName = prompt("Edit team name:", currentName);
    if (!nextName || !nextName.trim()) return;
    const sanitized = nextName.trim();
    if (sanitized === currentName) return;
    recordHistory();
    teams[index].name = sanitized;
    renderTeams();
    saveState();
    broadcastUpdate();
    addOperatorLog("Team Renamed", `${currentName || "Unnamed"} -> ${sanitized}`);
}

function removeTeam(index) {
    if (teams.length <= 1) {
        alert("At least one team must remain.");
        return;
    }

    const teamName = teams[index]?.name || "this team";
    const confirmed = confirm(`Remove ${teamName}?`);
    if (!confirmed) return;
    recordHistory();
    teams.splice(index, 1);
    renderTeams();
    saveState();
    broadcastUpdate();
    addOperatorLog("Team Removed", teamName);
}

function formatTime(seconds) {
    return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function updateTimerDisplay() {
    document.getElementById("timer").textContent = formatTime(timerRemaining);
    updateTimerBoardMeta();
}

function startTimer() {
    if (timerInterval) return;
    addOperatorLog("Timer Started", formatTime(timerRemaining));
    timerInterval = setInterval(() => {
        if (timerRemaining > 0) {
            timerRemaining -= 1;
            updateTimerDisplay();
            saveState();
            broadcastUpdate();
        } else {
            clearInterval(timerInterval);
            timerInterval = null;
            alert("Time's up!");
            saveState();
            broadcastUpdate();
        }
    }, 1000);
}

function pauseTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
        addOperatorLog("Timer Paused", formatTime(timerRemaining));
    }
    updateTimerBoardMeta();
}

function resetTimer() {
    if (liveMode && timerRemaining !== timerDuration) {
        const confirmed = confirm("Reset timer while live?");
        if (!confirmed) return;
    }
    recordHistory();
    pauseTimer();
    timerRemaining = timerDuration;
    updateTimerDisplay();
    syncTimerInputsFromState();
    saveState();
    broadcastUpdate();
    addOperatorLog("Timer Reset", formatTime(timerDuration));
    showToast("Timer reset", "warn");
}

function setTimer() {
    const minutesInput = prompt("Enter minutes:", Math.floor(timerDuration / 60));
    const minutes = Number(minutesInput);
    if (Number.isFinite(minutes) && minutes >= 0) {
        recordHistory();
        timerDuration = Math.floor(minutes * 60);
        timerRemaining = timerDuration;
        updateTimerDisplay();
        syncTimerInputsFromState();
        saveState();
        broadcastUpdate();
        addOperatorLog("Timer Set", formatTime(timerDuration));
    }
}

function addSeconds(sec) {
    const nextValue = Math.max(0, timerRemaining + sec);
    if (nextValue === timerRemaining) return;
    recordHistory();
    timerRemaining = nextValue;
    updateTimerDisplay();
    syncTimerInputsFromState();
    saveState();
    broadcastUpdate();
}

function applyTimerFromInputs() {
    const minutesInput = document.getElementById("timer-minutes-input");
    const secondsInput = document.getElementById("timer-seconds-input");
    if (!minutesInput || !secondsInput) return;

    const minutes = Math.max(0, Math.floor(Number(minutesInput.value) || 0));
    const seconds = Math.max(0, Math.min(59, Math.floor(Number(secondsInput.value) || 0)));
    const total = (minutes * 60) + seconds;
    if (timerDuration === total && timerRemaining === total) return;
    recordHistory();
    timerDuration = total;
    timerRemaining = total;
    updateTimerDisplay();
    syncTimerInputsFromState();
    saveState();
    broadcastUpdate();
    addOperatorLog("Timer Set", formatTime(total));
    showToast(`Timer set to ${formatTime(total)}`, "info");
}

function setTimerPreset(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    if (timerDuration === safeSeconds && timerRemaining === safeSeconds) return;
    recordHistory();
    timerDuration = safeSeconds;
    timerRemaining = safeSeconds;
    pauseTimer();
    updateTimerDisplay();
    syncTimerInputsFromState();
    saveState();
    broadcastUpdate();
    addOperatorLog("Timer Preset", formatTime(safeSeconds));
    showToast(`Preset loaded: ${formatTime(safeSeconds)}`, "info");
}

function applyTimerAdjust(direction) {
    const adjustInput = document.getElementById("timer-adjust-input");
    const delta = Math.max(0, Math.floor(Number(adjustInput?.value) || 0));
    if (delta <= 0) return;
    addSeconds(direction >= 0 ? delta : -delta);
}

function uploadStandbyMedia() {
    const fileInput = document.getElementById("standby-upload");
    fileInput.onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const mediaType = file.type.startsWith("video/") ? "video" : (file.type.startsWith("image/") ? "image" : "");
        if (!mediaType) {
            alert("Only image or video files are supported.");
            fileInput.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            pendingAdMediaSrc = ev.target.result;
            pendingAdMediaType = mediaType;
            pendingAdMediaName = file.name || "Uploaded media";
            renderAdPreview();
            updateAdStatus();
        };
        reader.readAsDataURL(file);
        fileInput.value = "";
    };
    fileInput.click();
}

function clearStandbyMedia() {
    if (standbyMediaSrc || pendingAdMediaSrc || standbyPlaylist.length || standbyLibrary.length) {
        const confirmed = confirm("Clear standby media and fallback queue?");
        if (!confirmed) return;
    }
    recordHistory();
    standbyMediaSrc = "";
    standbyMediaType = "";
    pendingAdMediaSrc = "";
    pendingAdMediaType = "";
    pendingAdMediaName = "";
    standbyPlaylist = [];
    standbyLibrary = [];
    adCurrentIndex = 0;
    adHold = false;
    adSeekToken += 1;
    renderStandbyLibrarySelect();
    saveState();
    broadcastControlState();
    updateAdStatus();
    renderAdPreview();
    addOperatorLog("Standby Media Cleared", "");
}

function clearTeamSearch() {
    const searchInput = document.getElementById("team-search");
    if (searchInput) searchInput.value = "";
    teamSearchQuery = "";
    renderTeams();
}

function editRoundName() {
    const newName = prompt("Enter new round name:", roundName);
    if (newName && newName.trim() !== "") {
        const nextRound = newName.trim();
        if (nextRound === roundName) return;
        recordHistory();
        roundName = nextRound;
        saveState();
        broadcastUpdate();
        addOperatorLog("Round Renamed", roundName);
        showToast(`Round updated: ${roundName}`, "info");
    }
}

loadState();
renderTeams();
updateTimerDisplay();
syncTimerInputsFromState();
syncEventHeaderControls();
updateAllTeamsScrollControls();
updateTimerBoardMeta();
syncButtonStates();
applyControlLockState();
initModeDateTime();
initButtonSoundEffects();
initTopMenu();
initAddTeamModal();
initHotkeyUI();
applyShortcutDockState();
renderStandbyLibrarySelect();
syncFallbackControlsFromState();
updateAdStatus();
syncAdStartIndexInput();
renderAdPreview();
initAdPreviewPlayer();
renderSfxButtonsState();
renderOperatorLogTable();
const advertisementFolderInput = document.getElementById("advertisement-folder-input");
if (advertisementFolderInput) {
    advertisementFolderInput.addEventListener("change", (event) => {
        handleAdvertisementFolderSelection(event.target.files);
    });
}
const teamSearchInput = document.getElementById("team-search");
if (teamSearchInput) {
    teamSearchInput.addEventListener("input", (event) => {
        teamSearchQuery = String(event.target.value || "");
        renderTeams();
    });
}
const eventTitleInput = document.getElementById("event-title-input");
if (eventTitleInput) {
    eventTitleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            applyEventTitle();
        }
    });
}
const sfxNameInput = document.getElementById("sfx-name-input");
if (sfxNameInput) {
    sfxNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addSfxSlot();
        }
    });
}
const allScrollRange = document.getElementById("all-scroll-range");
if (allScrollRange) {
    allScrollRange.addEventListener("input", (event) => {
        setAllTeamsScroll(event.target.value);
    });
}
transport.subscribe((data) => {
    if (!data || !data.type) return;
    if (data.type === "health_pong") {
        overlayChannelOnline = true;
        overlayHealthPending = false;
        updateStatusStrip();
        if (overlayHealthTimeout) {
            clearTimeout(overlayHealthTimeout);
            overlayHealthTimeout = null;
        }
    }
});
broadcastControlState();
if (liveMode) broadcastUpdate();
runStartupChecks();
