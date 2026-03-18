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

const transport = createTransport("overlay");
const STORAGE_KEY = "scoreboard_state_v1";

const timerEl = document.getElementById("timer");
const roundEl = document.getElementById("round");
const eventTitleEl = document.getElementById("event-title");
const sponsor1El = document.getElementById("sponsor-1");
const sponsor2El = document.getElementById("sponsor-2");
const sponsor3El = document.getElementById("sponsor-3");
const sponsor4El = document.getElementById("sponsor-4");
const teamsContainer = document.getElementById("teams-container");
const holdIndicator = document.getElementById("hold-indicator");
const standbyScreen = document.getElementById("standby-screen");
const standbyImage = document.getElementById("standby-image");
const standbyVideo = document.getElementById("standby-video");
const standbyDvd = document.getElementById("standby-dvd");
const standbyMessage = document.getElementById("standby-message");
const standbySubmessage = document.getElementById("standby-submessage");
const scoreboardScreen = document.getElementById("scoreboard-screen");
const winnerFireworks = document.getElementById("winner-fireworks");
const winnerConfetti = document.getElementById("winner-confetti");

let presentationState = {
    live: false,
    standby: true,
    standbyMediaSrc: "",
    standbyMediaType: "",
    standbyPlaylist: [],
    adCurrentIndex: 0,
    adHold: false,
    allViewScroll: 0,
    eventTitle: "TITLE NAME EVENT",
    sponsorLogos: { "1": "", "2": "", "3": "", "4": "" },
    standbyFallbackMode: "message",
    standbyFallbackData: {
        title: "Standby",
        subtitle: "Match starts soon"
    }
};

let standbyPlaybackIndex = 0;
let adAdvanceTimer = null;
const IMAGE_AD_DURATION_MS = 8000;
let allScrollCurrent = 0;
let allScrollVelocity = 0;
let allScrollRaf = null;
let allScrollRatio = 0;
let allScrollResizeObserver = null;
let allScrollRatioPending = null;
let allScrollApplyFrame = null;
let lastAppliedSeekToken = -1;
let dvdFrame = null;
let snowContainer = null;
let snowSpawnInterval = null;
let snowStopTimer = null;
let dvdState = {
    x: 30,
    y: 30,
    vx: 2.2,
    vy: 1.8,
    hue: 30
};
const SNOW_DURATION_MS = 5000;
const SNOW_SPAWN_MS = 120;
const SNOW_PER_TICK = 6;
const SNOW_FADE_OUT_MS = 1200;
const MIS_CHANCE = 0.14;
const CORNER_EASTER_EGG_CHANCE = 0.4;
let winnerCelebrationActive = false;
let fireworksFrame = null;
let fireworksBursts = [];
let fireworksBurstTimer = null;
let balloonSpawnTimer = null;
let winnerFadeTimer = null;
let hasRenderedOverlayTeams = false;
let previousRenderedTeamKeys = new Set();
let holdFreezeActive = false;
let frozenOverlayState = null;
let previousOverlayLayout = "";

function ensureSnowContainer() {
    if (snowContainer) return snowContainer;
    snowContainer = document.createElement("div");
    snowContainer.id = "standby-snow";
    standbyScreen.appendChild(snowContainer);
    return snowContainer;
}

function clearSnowflakes() {
    if (snowSpawnInterval) {
        clearInterval(snowSpawnInterval);
        snowSpawnInterval = null;
    }
    if (snowStopTimer) {
        clearTimeout(snowStopTimer);
        snowStopTimer = null;
    }
    if (snowContainer) {
        snowContainer.classList.remove("active", "fading");
        snowContainer.innerHTML = "";
    }
}

function resizeFireworksCanvas() {
    if (!winnerFireworks) return;
    winnerFireworks.width = window.innerWidth;
    winnerFireworks.height = window.innerHeight;
}

function stopWinnerCelebration() {
    winnerCelebrationActive = false;
    if (fireworksBurstTimer) {
        clearInterval(fireworksBurstTimer);
        fireworksBurstTimer = null;
    }
    if (balloonSpawnTimer) {
        clearInterval(balloonSpawnTimer);
        balloonSpawnTimer = null;
    }
    if (fireworksFrame) {
        cancelAnimationFrame(fireworksFrame);
        fireworksFrame = null;
    }
    fireworksBursts = [];
    if (winnerFadeTimer) {
        clearTimeout(winnerFadeTimer);
        winnerFadeTimer = null;
    }

    if (winnerConfetti) {
        winnerConfetti.classList.remove("active");
        winnerConfetti.classList.add("fading");
    }
    if (winnerFireworks) {
        winnerFireworks.classList.remove("active");
        winnerFireworks.classList.add("fading");
    }

    winnerFadeTimer = setTimeout(() => {
        if (winnerConfetti) {
            winnerConfetti.classList.remove("fading");
            winnerConfetti.innerHTML = "";
        }
        if (winnerFireworks) {
            winnerFireworks.classList.remove("fading");
            const ctx = winnerFireworks.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, winnerFireworks.width, winnerFireworks.height);
        }
        winnerFadeTimer = null;
    }, 760);
}

function showWinnerLayers() {
    if (winnerFadeTimer) {
        clearTimeout(winnerFadeTimer);
        winnerFadeTimer = null;
    }
    if (winnerConfetti) {
        winnerConfetti.classList.remove("fading");
        winnerConfetti.classList.add("active");
    }
    if (winnerFireworks) {
        winnerFireworks.classList.remove("fading");
        winnerFireworks.classList.add("active");
    }
}

function spawnConfettiPiece() {
    if (!winnerConfetti) return;
    const colors = ["#ffd166", "#ff5ea8", "#53f3ff", "#9aff6a", "#ffffff", "#7f7bff", "#ff8b3d"];
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.opacity = `${0.68 + Math.random() * 0.3}`;
    piece.style.width = `${6 + Math.random() * 8}px`;
    piece.style.height = `${10 + Math.random() * 12}px`;
    piece.style.animationDuration = `${3.2 + Math.random() * 3.6}s`;
    piece.style.setProperty("--drift", `${-80 + Math.random() * 160}px`);
    piece.style.setProperty("--twist", `${220 + Math.random() * 520}deg`);
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
    winnerConfetti.appendChild(piece);
}

function spawnFireworkBurst() {
    if (!winnerFireworks) return;
    const width = winnerFireworks.width || window.innerWidth;
    const height = winnerFireworks.height || window.innerHeight;
    const cx = width * (0.14 + Math.random() * 0.72);
    const cy = height * (0.12 + Math.random() * 0.44);
    const particles = [];
    const count = 44 + Math.floor(Math.random() * 24);
    const hue = Math.floor(Math.random() * 360);
    for (let i = 0; i < count; i += 1) {
        const angle = (Math.PI * 2 * i) / count;
        const speed = 2.2 + Math.random() * 3.2;
        particles.push({
            x: cx,
            y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 58 + Math.random() * 28,
            hue
        });
    }
    fireworksBursts.push(particles);
}

function startFireworksAnimation() {
    if (!winnerFireworks) return;
    resizeFireworksCanvas();
    winnerFireworks.classList.add("active");
    const ctx = winnerFireworks.getContext("2d");
    if (!ctx) return;

    const draw = () => {
        ctx.clearRect(0, 0, winnerFireworks.width, winnerFireworks.height);
        fireworksBursts = fireworksBursts.filter((burst) => burst.length > 0);

        fireworksBursts.forEach((burst) => {
            for (let i = burst.length - 1; i >= 0; i -= 1) {
                const p = burst[i];
                p.x += p.vx;
                p.y += p.vy;
                p.vx *= 0.985;
                p.vy = p.vy * 0.985 + 0.03;
                p.life -= 1;
                if (p.life <= 0) {
                    burst.splice(i, 1);
                    continue;
                }
                const alpha = Math.max(0, p.life / 90);
                ctx.beginPath();
                ctx.fillStyle = `hsla(${p.hue}, 95%, 62%, ${alpha})`;
                ctx.arc(p.x, p.y, 2 + (1 - alpha) * 1.8, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        fireworksFrame = requestAnimationFrame(draw);
    };

    draw();
    spawnFireworkBurst();
    fireworksBurstTimer = setInterval(spawnFireworkBurst, 440);
}

function startWinnerCelebration() {
    if (winnerCelebrationActive) return;
    stopWinnerCelebration();
    winnerCelebrationActive = true;
    showWinnerLayers();
    for (let i = 0; i < 36; i += 1) spawnConfettiPiece();
    balloonSpawnTimer = setInterval(() => {
        for (let i = 0; i < 8; i += 1) spawnConfettiPiece();
    }, 260);
    startFireworksAnimation();
}

function spawnSnowflake() {
    const container = ensureSnowContainer();
    const flake = document.createElement("span");
    const isMis = Math.random() < MIS_CHANCE;
    flake.className = isMis ? "snowflake snowflake-mis" : "snowflake snowflake-dot";
    flake.textContent = isMis ? "MIS" : "";
    flake.style.left = `${Math.random() * 100}%`;
    flake.style.fontSize = isMis ? `${14 + Math.random() * 10}px` : `${8 + Math.random() * 8}px`;
    flake.style.opacity = `${0.55 + Math.random() * 0.45}`;
    flake.style.animationDuration = `${3.1 + Math.random() * 3.2}s`;
    flake.style.setProperty("--flake-drift", `${-40 + Math.random() * 80}px`);
    flake.addEventListener("animationend", () => flake.remove(), { once: true });
    container.appendChild(flake);
}

function startSnowflakesRain(durationMs = SNOW_DURATION_MS) {
    const container = ensureSnowContainer();
    container.classList.remove("fading");
    container.classList.add("active");

    if (!snowSpawnInterval) {
        snowSpawnInterval = setInterval(() => {
            for (let i = 0; i < SNOW_PER_TICK; i += 1) {
                spawnSnowflake();
            }
        }, SNOW_SPAWN_MS);
    }

    if (snowStopTimer) {
        clearTimeout(snowStopTimer);
    }
    snowStopTimer = setTimeout(() => {
        if (snowSpawnInterval) {
            clearInterval(snowSpawnInterval);
            snowSpawnInterval = null;
        }
        if (snowContainer) {
            snowContainer.classList.add("fading");
        }
        setTimeout(() => {
            clearSnowflakes();
        }, SNOW_FADE_OUT_MS);
    }, durationMs);
}

function stopDvdBounce() {
    if (dvdFrame) {
        cancelAnimationFrame(dvdFrame);
        dvdFrame = null;
    }
    clearSnowflakes();
    standbyDvd.style.display = "none";
}

function startDvdBounce(labelText, imageSrc) {
    stopDvdBounce();
    standbyDvd.innerHTML = "";
    if (imageSrc) {
        const img = document.createElement("img");
        img.src = imageSrc;
        img.alt = "DVD Bounce";
        img.className = "standby-dvd-image";
        standbyDvd.appendChild(img);
    } else {
        standbyDvd.textContent = labelText || "DVD";
    }
    standbyDvd.style.display = "block";

    const tick = () => {
        const stageW = standbyScreen.clientWidth || window.innerWidth;
        const stageH = standbyScreen.clientHeight || window.innerHeight;
        const boxW = standbyDvd.offsetWidth;
        const boxH = standbyDvd.offsetHeight;

        dvdState.x += dvdState.vx;
        dvdState.y += dvdState.vy;

        let bounced = false;
        let bouncedX = false;
        let bouncedY = false;
        if (dvdState.x <= 0 || dvdState.x + boxW >= stageW) {
            dvdState.vx *= -1;
            dvdState.x = Math.max(0, Math.min(stageW - boxW, dvdState.x));
            bounced = true;
            bouncedX = true;
        }
        if (dvdState.y <= 0 || dvdState.y + boxH >= stageH) {
            dvdState.vy *= -1;
            dvdState.y = Math.max(0, Math.min(stageH - boxH, dvdState.y));
            bounced = true;
            bouncedY = true;
        }

        if (bounced) {
            dvdState.hue = (dvdState.hue + 47) % 360;
        }
        if (bouncedX && bouncedY && Math.random() < CORNER_EASTER_EGG_CHANCE) {
            startSnowflakesRain(SNOW_DURATION_MS);
        }

        const color = `hsl(${dvdState.hue}, 95%, 62%)`;
        standbyDvd.style.left = `${dvdState.x}px`;
        standbyDvd.style.top = `${dvdState.y}px`;
        standbyDvd.style.color = color;
        standbyDvd.style.borderColor = color;
        standbyDvd.style.boxShadow = `0 0 16px ${color}`;
        dvdFrame = requestAnimationFrame(tick);
    };

    dvdFrame = requestAnimationFrame(tick);
}

function loadInitialState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (error) {
        console.warn("Failed to load initial overlay state:", error);
        return null;
    }
}

function formatTime(seconds) {
    return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function syncAllTeamsScrollToRatio() {
    if (!teamsContainer) return;
    const maxScroll = Math.max(0, teamsContainer.scrollHeight - teamsContainer.clientHeight);
    const target = maxScroll * allScrollRatio;
    allScrollCurrent = target;
    teamsContainer.scrollTop = target;
}

function scheduleAllTeamsScrollApply(scrollValue) {
    if (allScrollApplyFrame) {
        cancelAnimationFrame(allScrollApplyFrame);
    }
    allScrollApplyFrame = requestAnimationFrame(() => {
        allScrollApplyFrame = null;
        applyAllTeamsScroll(scrollValue);
    });
}

function applyAllTeamsScroll(scrollValue) {
    if (!teamsContainer) return;
    const ratio = Math.max(0, Math.min(1000, Math.floor(Number(scrollValue) || 0))) / 1000;
    allScrollRatioPending = ratio;
    if (allScrollRaf) return;
    allScrollRaf = requestAnimationFrame(() => {
        allScrollRaf = null;
        if (allScrollRatioPending === null) return;
        allScrollRatio = allScrollRatioPending;
        allScrollRatioPending = null;
        syncAllTeamsScrollToRatio();
    });
}

function getDisplayTeams(teams, view) {
    const sortedTeams = [...teams].sort((a, b) => b.score - a.score);
    if (view === "all") return [...teams];
    if (view === "final") return sortedTeams.slice(0, 1);
    if (view === "spotlight") return sortedTeams.slice(0, 2);
    if (view === "top3") return sortedTeams.slice(0, 3);
    if (view === "top5") return sortedTeams.slice(0, 5);
    if (view === "top10") return sortedTeams.slice(0, 10);
    return sortedTeams;
}

function getOverlayLayout(view, displayedCount) {
    if (view === "final") return "final";
    if (view === "spotlight") return "spotlight";
    if (view === "top3") return "top3";
    if (view === "top5") return "top5";
    if (view === "top10") return "top10";
    if (view === "all") return "all";
    if (displayedCount <= 3) return "top3";
    if (displayedCount <= 5) return "top5";
    if (displayedCount <= 10) return "top10";
    return "all";
}

function normalizeSponsorLogos(rawLogos) {
    const next = { "1": "", "2": "", "3": "", "4": "" };
    if (!rawLogos || typeof rawLogos !== "object") return next;
    // backward compatibility for old left/right fields
    if (typeof rawLogos.left === "string") next["1"] = rawLogos.left;
    if (typeof rawLogos.right === "string") next["4"] = rawLogos.right;
    ["1", "2", "3", "4"].forEach((slot) => {
        if (typeof rawLogos[slot] === "string") next[slot] = rawLogos[slot];
    });
    return next;
}

function applySponsorLogo(el, src) {
    if (!el) return;
    if (src) {
        el.src = src;
        el.style.display = "block";
    } else {
        el.removeAttribute("src");
        el.style.display = "none";
    }
}

function sanitizeTeamColor(value) {
    const raw = String(value || "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : "";
}

function updateEventTitleDisplay(titleText) {
    const safeText = titleText || "TITLE NAME EVENT";
    eventTitleEl.dataset.currentTitle = safeText;
    eventTitleEl.classList.remove("scroll");
    eventTitleEl.style.removeProperty("--title-shift");
    eventTitleEl.style.removeProperty("--title-gap");
    eventTitleEl.style.removeProperty("--title-marquee-duration");

    const textEl = document.createElement("span");
    textEl.className = "event-title-text";
    textEl.textContent = safeText;
    eventTitleEl.replaceChildren(textEl);

    const overflow = Math.max(0, textEl.scrollWidth - eventTitleEl.clientWidth);
    if (overflow > 0) {
        const gap = 72;
        const shift = textEl.scrollWidth + gap;
        const pixelsPerSecond = 70;
        const duration = Math.max(8, Math.min(40, shift / pixelsPerSecond));

        const track = document.createElement("span");
        track.className = "event-title-track";

        const first = document.createElement("span");
        first.className = "event-title-text";
        first.textContent = safeText;

        const second = document.createElement("span");
        second.className = "event-title-text";
        second.textContent = safeText;

        track.appendChild(first);
        track.appendChild(second);
        eventTitleEl.replaceChildren(track);

        eventTitleEl.style.setProperty("--title-gap", `${gap}px`);
        eventTitleEl.style.setProperty("--title-shift", `${shift}px`);
        eventTitleEl.style.setProperty("--title-marquee-duration", `${duration}s`);
        eventTitleEl.classList.add("scroll");
    }
}

function renderStandbyScreen() {
    const { standby } = presentationState;
    const resetStandbyMedia = () => {
        standbyVideo.onended = null;
        standbyVideo.onerror = null;
        standbyVideo.onstalled = null;
        standbyVideo.onloadedmetadata = null;
        standbyVideo.pause();
    };
    const clearAdAdvanceTimer = () => {
        if (adAdvanceTimer) {
            clearTimeout(adAdvanceTimer);
            adAdvanceTimer = null;
        }
    };
    const playlist = Array.isArray(presentationState.standbyPlaylist)
        ? presentationState.standbyPlaylist.filter((item) => item && typeof item.path === "string" && item.path.trim())
        : [];
    const hasPlaylist = playlist.length > 0;
    if (hasPlaylist) {
        standbyPlaybackIndex = ((standbyPlaybackIndex % playlist.length) + playlist.length) % playlist.length;
    }
    const activeItem = hasPlaylist ? playlist[standbyPlaybackIndex] : null;
    const standbyMediaSrc = activeItem?.path || presentationState.standbyMediaSrc;
    const standbyMediaType = activeItem?.type || presentationState.standbyMediaType;

    if (!standby) {
        standbyScreen.style.display = "none";
        stopDvdBounce();
        resetStandbyMedia();
        clearAdAdvanceTimer();
        return;
    }

    standbyScreen.style.display = "flex";
    standbyImage.style.display = "none";
    standbyVideo.style.display = "none";
    stopDvdBounce();
    standbyMessage.style.display = "none";
    standbySubmessage.style.display = "none";
    clearAdAdvanceTimer();

    if (!standbyMediaSrc) {
        const fallbackTitle = presentationState.standbyFallbackData?.title || "Standby";
        const fallbackSubtitle = presentationState.standbyFallbackData?.subtitle || "Match starts soon";
        const fallbackDvdImageSrc = presentationState.standbyFallbackData?.dvdImageSrc || "";
        const fallbackMode = presentationState.standbyFallbackMode || "message";

        if (fallbackMode === "dvd") {
            startDvdBounce(fallbackTitle || "DVD", fallbackDvdImageSrc);
            standbySubmessage.style.display = "none";
            standbyMessage.style.display = "none";
        } else {
            standbyMessage.textContent = fallbackTitle;
            standbySubmessage.textContent = fallbackSubtitle;
            standbyMessage.style.display = "block";
            standbySubmessage.style.display = fallbackSubtitle ? "block" : "none";
        }
        resetStandbyMedia();
        return;
    }

    const itemType = standbyMediaType === "video" ? "video" : "image";

    resetStandbyMedia();

    if (itemType === "video") {
        const isSameVideo = standbyVideo.dataset.path === standbyMediaSrc;
        if (!isSameVideo) {
            standbyVideo.src = standbyMediaSrc;
            standbyVideo.dataset.path = standbyMediaSrc;
        }
        const shouldAutoAdvance = hasPlaylist && playlist.length > 1 && !presentationState.adHold;
        standbyVideo.loop = false;
        standbyVideo.onended = shouldAutoAdvance
            ? () => {
                standbyPlaybackIndex = (standbyPlaybackIndex + 1) % playlist.length;
                presentationState.adCurrentIndex = standbyPlaybackIndex;
                renderStandbyScreen();
            }
            : null;
        standbyVideo.style.display = "block";
        standbyVideo.play().catch(() => {});
    } else {
        standbyImage.src = standbyMediaSrc;
        standbyImage.style.display = "block";
        if (hasPlaylist && playlist.length > 1 && !presentationState.adHold) {
            adAdvanceTimer = setTimeout(() => {
                standbyPlaybackIndex = (standbyPlaybackIndex + 1) % playlist.length;
                presentationState.adCurrentIndex = standbyPlaybackIndex;
                renderStandbyScreen();
            }, IMAGE_AD_DURATION_MS);
        }
    }
}

function renderOverlayState(data) {
    const incomingHold = Boolean(data.hold);
    if (incomingHold && !holdFreezeActive) {
        holdFreezeActive = true;
        frozenOverlayState = {
            teams: Array.isArray(data.teams) ? data.teams : [],
            timer: Number.isFinite(data.timer) ? data.timer : 0,
            round: typeof data.round === "string" ? data.round : "ROUND 1",
            view: typeof data.view === "string" ? data.view : "all",
            eventTitle: typeof data.eventTitle === "string" ? data.eventTitle : "TITLE NAME EVENT",
            sponsorLogos: data.sponsorLogos,
            allViewScroll: Math.max(0, Math.min(1000, Math.floor(Number(data.allViewScroll) || 0)))
        };
    }
    if (!incomingHold && holdFreezeActive) {
        holdFreezeActive = false;
        frozenOverlayState = null;
    }

    const source = holdFreezeActive && frozenOverlayState ? frozenOverlayState : data;
    const { teams, timer, round, view, eventTitle, sponsorLogos, allViewScroll } = source;
    const safeTitle = (typeof eventTitle === "string" && eventTitle.trim()) ? eventTitle : "TITLE NAME EVENT";
    timerEl.textContent = formatTime(timer);
    updateEventTitleDisplay(safeTitle);
    const normalizedLogos = normalizeSponsorLogos(sponsorLogos);
    applySponsorLogo(sponsor1El, normalizedLogos["1"]);
    applySponsorLogo(sponsor2El, normalizedLogos["2"]);
    applySponsorLogo(sponsor3El, normalizedLogos["3"]);
    applySponsorLogo(sponsor4El, normalizedLogos["4"]);

    const displayTeams = getDisplayTeams(teams, view);
    const layout = getOverlayLayout(view, displayTeams.length);
    const previousCardRects = new Map();
    if (previousOverlayLayout === layout) {
        teamsContainer.querySelectorAll(".team-card[data-team-key]").forEach((card) => {
            previousCardRects.set(card.dataset.teamKey, card.getBoundingClientRect());
        });
    }
    teamsContainer.dataset.layout = layout;
    const isFinalLayout = layout === "final";
    scoreboardScreen.classList.toggle("final-mode", isFinalLayout);
    roundEl.textContent = isFinalLayout ? safeTitle : round;
    const allowDensityCompression = layout !== "all";
    teamsContainer.classList.toggle("dense", allowDensityCompression && displayTeams.length >= 12);
    teamsContainer.classList.toggle("ultra-dense", allowDensityCompression && displayTeams.length >= 18);
    timerEl.style.display = isFinalLayout ? "none" : "block";
    teamsContainer.innerHTML = "";
    const nextRenderedTeamKeys = new Set();
    const keyCounts = {};

    displayTeams.forEach((team, index) => {
        const baseKey = String(team.name || "team").trim().toLowerCase() || "team";
        keyCounts[baseKey] = (keyCounts[baseKey] || 0) + 1;
        const teamKey = `${baseKey}#${keyCounts[baseKey]}`;
        nextRenderedTeamKeys.add(teamKey);

        const card = document.createElement("div");
        card.className = "team-card";
        card.dataset.teamKey = teamKey;
        if (index === 0) card.classList.add("rank-1");
        if (index === 1) card.classList.add("rank-2");
        if (index === 2) card.classList.add("rank-3");
        const teamColor = sanitizeTeamColor(team?.teamColor);
        if (teamColor) {
            card.style.borderColor = teamColor;
        }
        const isNewTeamCard = hasRenderedOverlayTeams && !previousRenderedTeamKeys.has(teamKey);
        if (isNewTeamCard) card.classList.add("team-card-enter");

        if (!isFinalLayout) {
            const rank = document.createElement("div");
            rank.className = "rank";
            rank.textContent = `#${index + 1}`;
            card.appendChild(rank);
        }

        if (team.logo) {
            const logoWrap = document.createElement("div");
            logoWrap.className = "team-logo-wrap";
            const img = document.createElement("img");
            img.src = team.logo;
            img.className = "team-logo";
            img.style.width = `${team.logoWidth}px`;
            img.style.height = team.logoHeight === null ? "auto" : `${team.logoHeight}px`;
            if (layout === "all") {
                img.addEventListener("load", () => {
                    scheduleAllTeamsScrollApply(allViewScroll);
                }, { once: true });
            }
            logoWrap.appendChild(img);
            card.appendChild(logoWrap);
        } else {
            card.classList.add("no-logo");
        }

        const name = document.createElement("div");
        name.className = "team-name";
        name.textContent = team.name;
        card.appendChild(name);

        const score = document.createElement("div");
        score.className = "team-score";
        score.textContent = String(team.score);
        if (teamColor) {
            score.style.color = teamColor;
            score.style.textShadow = `0 0 16px ${teamColor}88, 0 0 7px rgba(255, 255, 255, 0.2)`;
        }
        card.appendChild(score);

        teamsContainer.appendChild(card);
    });
    const cardsToAnimate = [];
    if (previousOverlayLayout === layout) {
        teamsContainer.querySelectorAll(".team-card[data-team-key]").forEach((card) => {
            const previousRect = previousCardRects.get(card.dataset.teamKey);
            if (!previousRect) return;
            const nextRect = card.getBoundingClientRect();
            const deltaX = previousRect.left - nextRect.left;
            const deltaY = previousRect.top - nextRect.top;
            if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
            card.style.transition = "none";
            card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
            cardsToAnimate.push(card);
        });
    }
    previousRenderedTeamKeys = nextRenderedTeamKeys;
    hasRenderedOverlayTeams = true;
    previousOverlayLayout = layout;
    if (cardsToAnimate.length) {
        requestAnimationFrame(() => {
            cardsToAnimate.forEach((card) => {
                card.classList.add("team-card-moving");
                card.style.removeProperty("transition");
                card.style.transform = "translate(0, 0)";
                const cleanup = () => {
                    card.classList.remove("team-card-moving");
                    card.style.removeProperty("transform");
                    card.removeEventListener("transitionend", cleanup);
                };
                card.addEventListener("transitionend", cleanup);
            });
        });
    }
    if (layout === "all") {
        scheduleAllTeamsScrollApply(allViewScroll);
    } else {
        teamsContainer.scrollTop = 0;
    }

    holdIndicator.style.display = incomingHold ? "block" : "none";
}

window.addEventListener("resize", () => {
    const currentTitle = eventTitleEl.dataset.currentTitle || "TITLE NAME EVENT";
    updateEventTitleDisplay(currentTitle);
});

function renderScreenMode() {
    if (presentationState.live) {
        scoreboardScreen.style.display = "block";
        standbyScreen.style.display = "none";
    } else {
        scoreboardScreen.classList.remove("final-mode");
        timerEl.style.display = "block";
        stopWinnerCelebration();
        scoreboardScreen.style.display = "none";
        holdIndicator.style.display = "none";
        holdFreezeActive = false;
        frozenOverlayState = null;
        renderStandbyScreen();
    }
}

transport.subscribe((data) => {
    if (!data || !data.type) return;

    if (data.type === "health_ping") {
        transport.send({ type: "health_pong" });
        return;
    }

    if (data.type === "control_state") {
        const incomingSeekToken = Number.isFinite(data.adSeekToken) ? Math.max(0, Math.floor(data.adSeekToken)) : 0;
        presentationState = {
            live: Boolean(data.live),
            standby: Boolean(data.standby),
            eventTitle: typeof data.eventTitle === "string" ? data.eventTitle : "TITLE NAME EVENT",
            sponsorLogos: normalizeSponsorLogos(data.sponsorLogos),
            standbyMediaSrc: typeof data.standbyMediaSrc === "string" ? data.standbyMediaSrc : "",
            standbyMediaType: data.standbyMediaType === "video" ? "video" : (data.standbyMediaType === "image" ? "image" : ""),
            standbyPlaylist: Array.isArray(data.standbyPlaylist) ? data.standbyPlaylist : [],
            adCurrentIndex: Number.isFinite(data.adCurrentIndex) ? Math.max(0, Math.floor(data.adCurrentIndex)) : 0,
            adHold: Boolean(data.adHold),
            allViewScroll: Math.max(0, Math.min(1000, Math.floor(Number(data.allViewScroll) || 0))),
            adSeekToken: incomingSeekToken,
            standbyFallbackMode: typeof data.standbyFallbackMode === "string" ? data.standbyFallbackMode : "message",
            standbyFallbackData: data.standbyFallbackData && typeof data.standbyFallbackData === "object"
                ? data.standbyFallbackData
                : { title: "Standby", subtitle: "Match starts soon" }
        };
        if (incomingSeekToken !== lastAppliedSeekToken) {
            standbyPlaybackIndex = presentationState.adCurrentIndex;
            lastAppliedSeekToken = incomingSeekToken;
        }
        renderScreenMode();
        if (presentationState.live && teamsContainer?.dataset.layout === "all") {
            scheduleAllTeamsScrollApply(presentationState.allViewScroll);
        }
        return;
    }

    if (data.type === "ad_command") {
        const playlist = Array.isArray(presentationState.standbyPlaylist)
            ? presentationState.standbyPlaylist.filter((item) => item && typeof item.path === "string" && item.path.trim())
            : [];
        const length = playlist.length;
        if (!length) return;

        if (data.action === "next") {
            presentationState.adHold = false;
            standbyPlaybackIndex = (standbyPlaybackIndex + 1) % length;
            presentationState.adCurrentIndex = standbyPlaybackIndex;
            renderStandbyScreen();
            return;
        }
        if (data.action === "prev") {
            presentationState.adHold = false;
            standbyPlaybackIndex = (standbyPlaybackIndex - 1 + length) % length;
            presentationState.adCurrentIndex = standbyPlaybackIndex;
            renderStandbyScreen();
            return;
        }
        if (data.action === "toggle_hold") {
            presentationState.adHold = !presentationState.adHold;
            renderStandbyScreen();
            return;
        }
    }

    if (data.type === "fallback_command") {
        if (data.action === "test_snow") {
            startSnowflakesRain(SNOW_DURATION_MS);
        }
        return;
    }

    if (data.type === "winner_command") {
        if (!presentationState.live) return;
        if (data.action === "start") startWinnerCelebration();
        if (data.action === "stop") stopWinnerCelebration();
        if (data.action === "toggle" || data.action === "celebrate") {
            if (winnerCelebrationActive) stopWinnerCelebration();
            else startWinnerCelebration();
        }
        return;
    }

    if (data.type === "update") {
        if (typeof data.live === "boolean") {
            presentationState.live = data.live;
        }
        renderScreenMode();
        if (presentationState.live) {
            renderOverlayState(data);
        }
    }
});

const initialState = loadInitialState();
if (initialState) {
    presentationState.live = Boolean(initialState.liveMode);
    presentationState.standby = initialState.standbyMode === undefined ? true : Boolean(initialState.standbyMode);
    presentationState.eventTitle = typeof initialState.eventTitle === "string" ? initialState.eventTitle : "TITLE NAME EVENT";
    presentationState.sponsorLogos = normalizeSponsorLogos(initialState.sponsorLogos);
    presentationState.standbyMediaSrc = typeof initialState.standbyMediaSrc === "string" ? initialState.standbyMediaSrc : "";
    presentationState.standbyMediaType = initialState.standbyMediaType === "video" ? "video" : (initialState.standbyMediaType === "image" ? "image" : "");
    presentationState.standbyPlaylist = Array.isArray(initialState.standbyPlaylist) ? initialState.standbyPlaylist : [];
    presentationState.adCurrentIndex = Number.isFinite(initialState.adCurrentIndex) ? Math.max(0, Math.floor(initialState.adCurrentIndex)) : 0;
    presentationState.adHold = Boolean(initialState.adHold);
    presentationState.adSeekToken = Number.isFinite(initialState.adSeekToken) ? Math.max(0, Math.floor(initialState.adSeekToken)) : 0;
    presentationState.standbyFallbackMode = typeof initialState.standbyFallbackMode === "string" ? initialState.standbyFallbackMode : "message";
    presentationState.standbyFallbackData = initialState.standbyFallbackData && typeof initialState.standbyFallbackData === "object"
        ? initialState.standbyFallbackData
        : { title: "Standby", subtitle: "Match starts soon" };
    standbyPlaybackIndex = presentationState.adCurrentIndex;
    lastAppliedSeekToken = presentationState.adSeekToken;

    if (presentationState.live) {
        renderOverlayState({
            teams: Array.isArray(initialState.teams) ? initialState.teams : [],
            timer: Number.isFinite(initialState.timerRemaining) ? initialState.timerRemaining : 0,
            round: typeof initialState.roundName === "string" ? initialState.roundName : "ROUND 1",
            eventTitle: presentationState.eventTitle,
            sponsorLogos: presentationState.sponsorLogos,
            hold: Boolean(initialState.holdMode),
            view: typeof initialState.viewMode === "string" ? initialState.viewMode : "all",
            allViewScroll: Math.max(0, Math.min(1000, Math.floor(Number(initialState.allViewScroll) || 0)))
        });
    }
}

renderScreenMode();
resizeFireworksCanvas();
window.addEventListener("resize", resizeFireworksCanvas);

if (teamsContainer && "ResizeObserver" in window) {
    allScrollResizeObserver = new ResizeObserver(() => {
        if (teamsContainer.dataset.layout === "all") {
            syncAllTeamsScrollToRatio();
        }
    });
    allScrollResizeObserver.observe(teamsContainer);
}
