const loginOverlay = document.getElementById('login-overlay');
const loginUser = document.getElementById('login-username');
const loginPass = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const authPrimaryBtn = document.getElementById('auth-primary-btn');

const mainApp = document.getElementById('main-app');
const logoutBtn = document.getElementById('logout-btn');

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const batchModal = document.getElementById('batch-modal');
const previewModal = document.getElementById('preview-modal');
const batchUrls = document.getElementById('batch-urls');
const urlsInput = document.getElementById('urls');
const resultsList = document.getElementById('results-list');
const logsContainer = document.getElementById('logs');
const statusMessage = document.getElementById('status-message');
const paginationContainer = document.getElementById('pagination');

const missionList = document.getElementById('mission-list');
const backToHistoryBtn = document.getElementById('back-to-history');
const resultsTitle = document.getElementById('results-title');

const linkReportModal = document.getElementById('link-report-modal');
const linkReportList = document.getElementById('link-report-list');
const closeReportBtn = document.querySelector('.close-report');
const duplicateReviewModal = document.getElementById('duplicate-review-modal');
const duplicateReviewList = document.getElementById('duplicate-review-list');
const duplicateReviewTitle = document.getElementById('duplicate-review-title');

let lastProgressData = null;
let historicalMissions = [];
// State Management
let currentUser = null;
let currentPage = 1;
let missionCurrentPage = 1;    // Mission list pagination
const itemsPerPage = 15;       // Results per page inside a mission
const missionsPerPage = 5;     // Batches shown per page in history

// Helper for human-readable Madrid dates
function formatMadridDate(dateStr) {
    if (!dateStr || dateStr === 'Just now') return dateStr;
    try {
        const date = new Date(dateStr);
        return new Intl.DateTimeFormat('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'Europe/Madrid'
        }).format(date);
    } catch (e) {
        return dateStr;
    }
}
let allResults = [];
let selectedBatchId = null;
let statusPollTimer = null;
let resultsPollTimer = null;
let lastKnownActive = false;
let lastResultsSignature = '';
let lastMissionsSignature = '';
let lastResultsRevision = -1;
let resultsRefreshInFlight = null;
let resultsRefreshQueued = false;
const missionManifestCache = new Map();
let duplicateReviewState = null;
let duplicateReviewActiveGroupIndex = 0;
let duplicateReviewSelection = { left: 0, right: 1 };
let duplicateReviewDraftChanges = [];
let duplicateReviewCategoryFilter = 'all';
let duplicateReviewUnresolvedOnly = false;
let duplicateReviewSearch = '';
let duplicateReviewDifferenceOnly = false;
let duplicateReviewSelectedSourceIds = new Set();
const duplicateReviewTextCache = new Map();
const combinedReviewSelectedMissionIds = new Set();

const UI_THEME_STORAGE_KEY = 'scraperito-ui-theme';
const UI_THEMES = new Set(['classic', 'steampunk']);

function applyUiTheme(theme, persist = true) {
    const selectedTheme = UI_THEMES.has(theme) ? theme : 'classic';
    document.body.dataset.theme = selectedTheme;
    document.querySelectorAll('[data-ui-theme]').forEach(button => {
        const active = button.dataset.uiTheme === selectedTheme;
        button.setAttribute('aria-pressed', String(active));
    });
    if (persist) {
        try { localStorage.setItem(UI_THEME_STORAGE_KEY, selectedTheme); } catch (_) { }
    }
}

document.querySelectorAll('[data-ui-theme]').forEach(button => {
    button.addEventListener('click', () => applyUiTheme(button.dataset.uiTheme));
});

try {
    applyUiTheme(localStorage.getItem(UI_THEME_STORAGE_KEY) || 'classic', false);
} catch (_) {
    applyUiTheme('classic', false);
}

function triggerSteamLaunch() {
    if (document.body.dataset.theme !== 'steampunk') return;
    const engine = document.getElementById('steam-engine');
    if (!engine) return;

    // Restart the one-shot release without adding polling or scraper work.
    engine.classList.remove('steam-release');
    void engine.offsetWidth;
    engine.classList.add('steam-release');
    window.setTimeout(() => engine.classList.remove('steam-release'), 4600);
}

function updateCombinedReviewControls() {
    const launch = document.getElementById('combined-review-launch');
    const clear = document.getElementById('combined-review-clear');
    const count = combinedReviewSelectedMissionIds.size;
    if (launch) {
        launch.disabled = count !== 2;
        launch.textContent = `Review selected (${count}/2)`;
        launch.onclick = () => openCombinedReview(Array.from(combinedReviewSelectedMissionIds));
    }
    if (clear) {
        clear.style.display = count > 0 ? 'inline-flex' : 'none';
        clear.onclick = () => {
            combinedReviewSelectedMissionIds.clear();
            renderMissions();
        };
    }
}

window.toggleCombinedReviewMission = (missionId, checked) => {
    const id = String(missionId || '');
    if (!id) return;
    if (checked && !combinedReviewSelectedMissionIds.has(id) && combinedReviewSelectedMissionIds.size >= 2) {
        alert('Select exactly two missions. Clear one selection before adding another.');
        renderMissions();
        return;
    }
    if (checked) combinedReviewSelectedMissionIds.add(id);
    else combinedReviewSelectedMissionIds.delete(id);
    renderMissions();
};

backToHistoryBtn.onclick = () => {
    selectedBatchId = null;
    currentPage = 1;
    missionCurrentPage = 1; // Reset mission pagination when going back
    renderAll();
};



function getSafeDomain(urlStr, fallback = 'Mission Targets') {
    if (!urlStr) return fallback;
    try {
        const url = new URL(urlStr);
        return url.hostname;
    } catch (e) {
        // Handle cases where urlStr might be a fragment or invalid
        return urlStr.substring(0, 30) + '...';
    }
}

// Auth Logic
async function checkAuth() {
    try {
        const res = await fetch('/api/session');
        if (res.ok) {
            const session = await res.json();
            currentUser = session.user;
            loginOverlay.style.display = 'none';
            mainApp.style.display = 'block';

            // Show username in header
            document.querySelector('header p').textContent = `Welcome back, ${currentUser.username}!`;
            resultsTitle.textContent = `${currentUser.username} Scraper-ito's History`;
            missionList.innerHTML = '<p class="empty-msg">Loading history...</p>';

            // Show admin panel link if admin
            if (currentUser.id === 'Edcl87') {
                const adminLink = document.getElementById('admin-link');
                if (adminLink) adminLink.style.display = 'inline-block';
            }

            lastKnownActive = session.active === true;
            updateStatus(session.active ? false : true);
            updateResults();
            startHeartbeat(); // v16.27
            startAdaptivePolling();
        } else {
            loginOverlay.style.display = 'flex';
            mainApp.style.display = 'none';
            stopHeartbeat();
            stopAdaptivePolling();
        }
    } catch (e) {
        loginOverlay.style.display = 'flex';
        stopHeartbeat();
        stopAdaptivePolling();
    }
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 💓 Heartbeat Mechanism (v16.27)
let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) return;
    sendHeartbeat(); // Immediate first beat
    heartbeatInterval = setInterval(sendHeartbeat, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

async function sendHeartbeat() {
    try {
        const res = await fetch('/api/heartbeat', { method: 'POST' });
        if (res.status === 401) {
            stopHeartbeat();
            checkAuth(); // Session might have expired
        }
    } catch (e) {
        console.warn('[HEARTBEAT] Connection failed');
    }
}

async function submitLogin() {
    const username = loginUser.value.trim();
    const password = loginPass.value;

    if (!username || !password) return alert('Fill everything, Elmo says!');

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            checkAuth();
        } else {
            const err = await res.json();
            loginError.textContent = err.error || 'Auth failed.';
            loginError.style.display = 'block';
        }
    } catch (e) {
        alert('Connection error');
    }
}

authPrimaryBtn.onclick = submitLogin;

[loginUser, loginPass].forEach(input => {
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submitLogin();
    });
});

logoutBtn.onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
};

// UI Interaction
document.getElementById('open-batch-btn').onclick = () => batchModal.style.display = "block";
document.querySelector('.close-modal').onclick = () => batchModal.style.display = "none";
function closePreviewModal() {
    previewModal.style.display = 'none';
    previewModal.classList.remove('review-full-text-modal');
}

document.querySelector('.close-preview').onclick = closePreviewModal;

window.onclick = (e) => {
    if (e.target == batchModal) batchModal.style.display = "none";
    if (e.target == previewModal) closePreviewModal();
    if (e.target == linkReportModal) linkReportModal.style.display = "none";
};

closeReportBtn.onclick = () => linkReportModal.style.display = "none";

function renderBasicLinkReport(data = null) {
    const reportData = data || lastProgressData;
    if (!reportData || !reportData.details) return;
    linkReportList.innerHTML = reportData.details.map(item => `
        <div class="link-report-item">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 0.8rem; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.url}">${item.url}</div>
                ${item.unwrappedUrl ? `<div style="font-size: 0.7rem; opacity: 0.6;">↳ ${item.unwrappedUrl}</div>` : ''}
                ${item.reason ? `<div style="font-size: 0.75rem; color: var(--primary); margin-top: 4px; line-height: 1.2; word-break: break-word;">⚠️ ${item.reason}</div>` : ''}
            </div>
            <div class="link-report-status status-${item.status}">${item.status}</div>
        </div>
    `).join('');
}

function renderVerboseLinkReport(data = null) {
    const reportData = data || lastProgressData;
    if (!reportData || !reportData.details) return;
    linkReportList.innerHTML = reportData.details.map(item => {
        const artifacts = item.artifacts || {};
        const files = item.filesSaved || artifacts.files || {};
        const fileLabels = Object.entries(files)
            .map(([type, filename]) => `<span style="display:inline-block; margin:3px 5px 0 0; padding:2px 6px; border-radius:999px; border:1px solid rgba(148,163,184,.35); color:#cbd5e1; font-size:.68rem;">${escapeHtml(type.toUpperCase())}: ${escapeHtml(filename)}</span>`)
            .join('');
        const pdfKnown = item.status === 'success' && (item.pdfSaved !== undefined || artifacts.hasPdf !== undefined);
        const pdfSaved = item.pdfSaved === true || artifacts.hasPdf === true;
        const pdfKind = item.pdfKind || artifacts.pdfKind || 'none';
        const pdfReason = item.pdfReason || artifacts.pdfReason || '';
        const sourceDetail = item.sourceDetail || artifacts.sourceDetail || '';
        const sizeKb = item.sizeKb || artifacts.sizeKb || '';
        const storageWarning = artifacts.storageWarning || item.storageWarning || '';

        return `
        <div class="link-report-item">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 0.8rem; font-weight: 600; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
                ${item.unwrappedUrl ? `<div style="font-size: 0.7rem; opacity: 0.6;">↳ ${escapeHtml(item.unwrappedUrl)}</div>` : ''}
                <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:7px; align-items:center;">
                    ${sizeKb ? `<span style="font-size:.68rem; color:#93c5fd;">Size: ${escapeHtml(sizeKb)} KB</span>` : ''}
                    ${pdfKnown ? `<span style="font-size:.68rem; font-weight:700; color:${pdfSaved ? '#34d399' : '#f87171'};">PDF: ${pdfSaved ? `SAVED (${escapeHtml(pdfKind)})` : 'NOT SAVED'}</span>` : ''}
                    ${artifacts.hasMd ? `<span style="font-size:.68rem; color:#34d399;">MD saved</span>` : ''}
                    ${artifacts.hasTxt ? `<span style="font-size:.68rem; color:#34d399;">TXT saved</span>` : ''}
                    ${artifacts.hasJson ? `<span style="font-size:.68rem; color:#34d399;">JSON saved</span>` : ''}
                    ${artifacts.hasDocx ? `<span style="font-size:.68rem; color:#34d399;">DOCX saved</span>` : ''}
                </div>
                ${pdfReason ? `<div style="font-size: 0.72rem; color:${pdfSaved ? '#94a3b8' : '#fbbf24'}; margin-top: 5px; line-height: 1.25; word-break: break-word;">PDF detail: ${escapeHtml(pdfReason)}</div>` : ''}
                ${sourceDetail ? `<div style="font-size: 0.72rem; color:#93c5fd; margin-top: 5px; line-height: 1.25; word-break: break-word;">Source: ${escapeHtml(sourceDetail)}</div>` : ''}
                ${fileLabels ? `<div style="margin-top:5px;">${fileLabels}</div>` : ''}
                ${storageWarning ? `<div style="font-size: 0.72rem; color:#fbbf24; margin-top: 5px; line-height:1.25;">Storage warning: ${escapeHtml(storageWarning)}</div>` : ''}
                ${item.reason ? `<div style="font-size: 0.75rem; color: var(--primary); margin-top: 4px; line-height: 1.2; word-break: break-word;">⚠️ ${escapeHtml(item.reason)}</div>` : ''}
            </div>
            <div class="link-report-status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</div>
        </div>
        `;
    }).join('');
}

function renderLinkReport(data = null) {
    const reportData = data || lastProgressData;
    if (!reportData || !reportData.details) return;

    const formatFlag = (label, ok, title = '') => {
        const cls = ok === null ? 'artifact-unknown' : (ok ? 'artifact-ok' : 'artifact-missing');
        return `<span class="artifact-flag ${cls}" title="${escapeHtml(title || label)}">${label}</span>`;
    };

    linkReportList.innerHTML = reportData.details.map(item => {
        const artifacts = item.artifacts || {};
        const files = item.filesSaved || artifacts.files || {};
        const isExactDuplicate = item.status === 'deduplicated';
        const hasArtifactMetadata = Boolean(item.artifacts || item.filesSaved || item.pdfSaved !== undefined || isExactDuplicate);
        const hasMd = isExactDuplicate ? null : (hasArtifactMetadata ? Boolean(files.md || artifacts.hasMd) : null);
        const hasTxt = isExactDuplicate ? null : (hasArtifactMetadata ? Boolean(files.txt || artifacts.hasTxt) : null);
        const hasJson = isExactDuplicate ? null : (hasArtifactMetadata ? Boolean(files.json || artifacts.hasJson) : null);
        const hasPdf = isExactDuplicate ? null : (hasArtifactMetadata ? (item.pdfSaved === true || artifacts.hasPdf === true || Boolean(files.pdf)) : null);
        const hasDocx = isExactDuplicate ? null : (hasArtifactMetadata ? (artifacts.hasDocx === true || Boolean(files.docx)) : null);
        const sizeKb = item.sizeKb || artifacts.sizeKb || '';
        const pdfKind = item.pdfKind || artifacts.pdfKind || 'none';
        const pdfReason = item.pdfReason || artifacts.pdfReason || '';
        const sourceDetail = item.sourceDetail || artifacts.sourceDetail || '';
        const storageWarning = artifacts.storageWarning || item.storageWarning || '';
        const controlledDownloadFailure = item.controlledDownloadFailure === true;
        const duplicateOfUrl = item.duplicateOfUrl || '';
        const docState = isExactDuplicate
            ? 'Exact duplicate; canonical artifact reused'
            : (!hasArtifactMetadata ? 'Artifact status unavailable' : (hasDocx ? 'DOCX saved' : (hasPdf ? `PDF ${pdfKind}` : (pdfReason || 'No PDF saved'))));
        const legacyPendingReason = item.status === 'pending' ? 'No terminal status was recorded for this URL. It probably remained queued when the mission ended or was interrupted.' : '';
        const detail = item.reason || legacyPendingReason || (!hasPdf ? pdfReason : '') || storageWarning || '';

        return `
        <div class="link-report-item compact-link-report">
            <div class="compact-link-main">
                <span class="compact-link-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
                ${sizeKb ? `<span class="compact-link-size">${escapeHtml(sizeKb)} KB</span>` : ''}
                <span class="compact-artifacts">
                    ${formatFlag('MD', hasMd, files.md || 'Markdown not saved')}
                    ${formatFlag('TXT', hasTxt, files.txt || 'Text not saved')}
                    ${formatFlag('JSON', hasJson, files.json || 'JSON not saved')}
                    ${formatFlag('DOCX', hasDocx, hasDocx ? files.docx || 'DOCX saved' : 'DOCX not saved')}
                    ${formatFlag('PDF', hasPdf, hasPdf ? `${files.pdf || 'PDF saved'} (${pdfKind})` : (pdfReason || 'PDF not saved'))}
                </span>
                <span class="compact-doc-state ${isExactDuplicate ? 'doc-state-deduplicated' : (!hasArtifactMetadata ? 'doc-state-unknown' : (hasPdf || hasDocx ? 'doc-state-ok' : 'doc-state-missing'))}" title="${escapeHtml(docState)}">${escapeHtml(docState)}</span>
                ${duplicateOfUrl ? `<span class="compact-link-detail" title="Canonical URL: ${escapeHtml(duplicateOfUrl)}">canonical: ${escapeHtml(duplicateOfUrl)}</span>` : ''}
                ${sourceDetail ? `<span class="compact-link-detail" title="${escapeHtml(sourceDetail)}">official open data</span>` : ''}
                ${controlledDownloadFailure ? `<span class="compact-link-detail" title="Controlled browser download failure. The app stayed alive and recorded the URL-level failure.">controlled download failure</span>` : ''}
                ${detail ? `<span class="compact-link-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>` : ''}
            </div>
            <div class="link-report-status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</div>
        </div>
        `;
    }).join('');
}

document.getElementById('save-batch-btn').onclick = () => {
    const current = urlsInput.value.trim();
    const batch = batchUrls.value.trim();
    if (batch) {
        urlsInput.value = current ? current + "\n" + batch : batch;
    }
    batchModal.style.display = "none";
    batchUrls.value = "";
};

let lastLogCount = 0;
let lastMissionId = null;
function renderLogs(logs, missionId) {
    // 🛡️ Mission-Aware Reset (v7): If mission ID changes, reset the log state
    if (missionId && missionId !== lastMissionId) {
        logsContainer.innerHTML = '';
        lastLogCount = 0;
        lastMissionId = missionId;
    }

    if (logs.length === 0) {
        logsContainer.innerHTML = '';
        lastLogCount = 0;
        return;
    }

    // v16.80: Truncation Desync Guard
    // If the log array was truncated server-side (its length is now LESS than our
    // local counter), we must do a full re-render to resync. Without this, the
    // condition `logs.length > lastLogCount` is permanently false and the feed freezes.
    if (logs.length < lastLogCount) {
        logsContainer.innerHTML = '';
        lastLogCount = 0;
    }

    // Incremental update: Only add new logs to avoid flickering and selection loss
    if (logs.length > lastLogCount) {
        const newLogs = logs.slice(lastLogCount);
        const fragment = document.createDocumentFragment();
        newLogs.forEach(log => {
            const div = document.createElement('div');
            div.className = `log-entry ${log.type}`;
            div.textContent = `[${log.timestamp}] ${log.message}`;
            fragment.appendChild(div);
        });
        logsContainer.appendChild(fragment);
        lastLogCount = logs.length;
        while (logsContainer.children.length > 430) {
            logsContainer.removeChild(logsContainer.firstChild);
        }
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }
}

// Scrape Action
startBtn.onclick = async () => {
    const rawUrls = urlsInput.value;
    if (!rawUrls.trim()) return alert('Enter at least one URL!');

    startBtn.disabled = true;
    startBtn.textContent = "Mission Active...";
    stopBtn.style.display = "block";
    statusMessage.textContent = "Elmo is harvesting!";
    document.body.classList.add('mission-running');
    triggerSteamLaunch();

    try {
        const response = await fetch('/api/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rawUrls: rawUrls,
                depth: document.getElementById('depth').value,
                maxPages: document.getElementById('maxPages').value,
                stayOnDomain: document.getElementById('stayOnDomain').checked,
                bodyOnly: document.getElementById('bodyOnly').checked,
                excludeNoise: document.getElementById('excludeNoise').checked,
                delayMs: document.getElementById('delayMs').value,
                concurrency: document.getElementById('concurrency').value,
                pdfMetadata: document.getElementById('pdfMetadata').checked,
                smartNav: true,                                              // 🧭 Always ON (enforced server-side at depth ≥ 1)
                sailorMode: document.getElementById('sailorMode').checked    // 🏴‍☠️ Sailor Mode: link-only harvest
            })
        });
        const launch = await response.json();
        if (!response.ok) throw new Error(launch.error || 'Mission could not start');

        // Render the launch logs now rather than waiting for the next idle poll.
        renderLogs(launch.logs || [], launch.missionId);
        if (launch.inputAudit) {
            console.info('Mission input audit:', launch.inputAudit);
        }
        if (launch.progress) lastProgressData = launch.progress;
        lastKnownActive = true;
        scheduleStatusPoll(2500);
        void updateStatus();
        document.getElementById('success-overlay').style.display = 'none';
    } catch (e) {
        console.error('Error launching mission:', e);
        startBtn.disabled = false;
        startBtn.textContent = 'Launch Mission!';
        stopBtn.style.display = 'none';
        statusMessage.textContent = 'Mission could not start.';
        document.body.classList.remove('mission-running');
    }
};

stopBtn.onclick = async () => {
    try {
        await fetch('/api/stop', { method: 'POST' });
        stopBtn.disabled = true;
        stopBtn.textContent = "Stopping...";
    } catch (e) { console.error('Failed to send stop signal'); }
};

// Periodic Polling
async function updateStatus(clearLogs = false) {
    try {
        const statusParams = new URLSearchParams({ compact: 'true' });
        if (clearLogs) statusParams.set('clear', 'true');
        const res = await fetch(`/api/status?${statusParams.toString()}`);
        if (res.status === 401) return checkAuth(); // Session expired
        const status = await res.json();

        renderLogs(status.logs, status.missionId);

        // A result is persisted per URL. Refresh history only when that marker changes,
        // rather than repeatedly scanning every stored mission during an active swarm.
        const nextResultsRevision = Number(status.resultsRevision || 0);
        if (nextResultsRevision !== lastResultsRevision) {
            lastResultsRevision = nextResultsRevision;
            void updateResults();
        }

        if (status.active) {
            document.body.classList.add('mission-running');
            startBtn.disabled = true;
            startBtn.textContent = "Mission Active...";
            stopBtn.style.display = "block";
            statusMessage.textContent = "Elmo is harvesting!";

            // The compact polling response deliberately excludes detail rows.
            // Keep the last full progress snapshot for the detailed report UI.
            if (status.progress && Array.isArray(status.progress.details)) {
                lastProgressData = status.progress;
            }
        } else {
            document.body.classList.remove('mission-running');
            if (lastKnownActive) {
                updateResults();
            }
            lastKnownActive = false;

            startBtn.disabled = false;
            startBtn.textContent = "Launch Mission!";
            stopBtn.style.display = "none";
            stopBtn.disabled = false;
            stopBtn.textContent = "Stop Mission";

            // Success Ceremony Logic - Only once per missionId AND only if actually successful
            if (status.logs.length > 0 && status.logs[status.logs.length - 1].message === 'Mission concluded.') {
                const lastCelebrated = localStorage.getItem('lastCelebratedMissionId');
                const isSuccessful = status.progress && status.progress.successful > 0;

                if (status.missionId && status.missionId !== lastCelebrated) {
                    if (isSuccessful) {
                        statusMessage.textContent = "Mission Accomplished.";
                        const successImg = document.querySelector('#success-overlay img[data-src]');
                        if (successImg && !successImg.getAttribute('src')) {
                            successImg.setAttribute('src', successImg.dataset.src);
                        }
                        document.getElementById('success-overlay').style.display = 'flex';
                    } else {
                        statusMessage.textContent = "Mission Finished (No findings).";
                    }
                    localStorage.setItem('lastCelebratedMissionId', status.missionId);
                } else if (status.missionId === lastCelebrated) {
                    if (statusMessage.textContent !== "Mission Accomplished." && statusMessage.textContent !== "Mission Finished (No findings).") {
                        statusMessage.textContent = "Mission Ready.";
                    }
                }
            } else {
                statusMessage.textContent = "Ready for mission!";
            }
        }
        if (status.active) lastKnownActive = true;
        return status.active === true;
    } catch (e) { }
    return lastKnownActive;
}

async function updateResults() {
    if (resultsRefreshInFlight) {
        resultsRefreshQueued = true;
        return resultsRefreshInFlight;
    }

    const refresh = (async () => {
        do {
            resultsRefreshQueued = false;
    try {
        const [resResults, resMissions] = await Promise.all([
            fetch('/api/results'),
            fetch('/api/missions')
        ]);

        if (resResults.status === 401) return;
        const [data, missionsData] = await Promise.all([
            resResults.json(),
            resMissions.json()
        ]);

        // Lightweight signatures avoid JSON.stringify on large mission payloads.
        const firstResult = data[0] || {};
        const artifactSignature = data.reduce((acc, item) => {
            if (item.hasPdf) acc.pdf++;
            if (item.hasMd) acc.md++;
            if (item.hasTxt) acc.txt++;
            return acc;
        }, { pdf: 0, md: 0, txt: 0 });
        const firstMission = missionsData[0] || {};
        const resultsSignature = [
            data.length,
            firstResult.path || '',
            firstResult.mtime || '',
            firstResult.size_kb || '',
            artifactSignature.pdf,
            artifactSignature.md,
            artifactSignature.txt
        ].join('|');
        const missionsSignature = [
            missionsData.length,
            firstMission.id || '',
            firstMission.total || 0,
            firstMission.successful || 0,
            firstMission.deduplicated || 0,
            firstMission.firstStatus || ''
        ].join('|');

        const resultsChanged = resultsSignature !== lastResultsSignature;
        const missionsChanged = missionsSignature !== lastMissionsSignature || missionsData.length !== prevMissionsLength;

        if (resultsChanged || missionsChanged) {
            allResults = data;
            historicalMissions = missionsData;
            prevMissionsLength = missionsData.length;
            lastResultsSignature = resultsSignature;
            lastMissionsSignature = missionsSignature;
            renderAll();
        }
    } catch (e) {
        console.error('Update results error:', e);
    }
        } while (resultsRefreshQueued);
    })();
    resultsRefreshInFlight = refresh;
    try {
        return await refresh;
    } finally {
        if (resultsRefreshInFlight === refresh) resultsRefreshInFlight = null;
    }
}
let prevMissionsLength = 0;

function renderAll() {
    if (selectedBatchId) {
        missionList.style.display = 'none';
        resultsList.style.display = 'flex';
        backToHistoryBtn.style.display = 'block';
        resultsTitle.textContent = "Mission Results";
        renderResults();
    } else {
        missionList.style.display = 'flex';
        resultsList.style.display = 'none';
        backToHistoryBtn.style.display = 'none';
        const userName = currentUser ? currentUser.username : "Scraper-ito";
        resultsTitle.textContent = `${userName} Scraper-ito's History`;
        renderMissions();
    }
    renderPagination();
}

function renderMissions() {
    // 🛡️ Logic Upgrade: Use historicalMissions as the primary source of truth
    // so that missions with 0 results still appear in the history.
    const missionsMap = new Map();

    // 1. First, populate from historical manifests (the mission blueprints)
    historicalMissions.forEach(hm => {
        if (!hm || !hm.id) return;
        missionsMap.set(String(hm.id), {
            id: hm.id,
            name: hm.firstUrl ? getSafeDomain(hm.firstUrl) : ((hm.details && hm.details.length > 0) ? getSafeDomain(hm.details[0].url) : 'Mission Manifest'),
            timestamp: hm.timestamp || (isNaN(parseInt(hm.id)) ? new Date().toISOString() : new Date(parseInt(hm.id)).toISOString()),
            count: hm.successful || 0,
            deduplicated: hm.deduplicated || 0,
            total: hm.total || 0,
            mtime: hm.timestamp || (isNaN(parseInt(hm.id)) ? new Date().toISOString() : new Date(parseInt(hm.id)).toISOString()),
            isManifest: true
        });
    });

    // 2. Then, integrate allResults (the actual harvested files)
    allResults.forEach(r => {
        if (!r) return;
        const id = String(r.batchId || 'legacy');
        if (!missionsMap.has(id)) {
            missionsMap.set(id, {
                id: id,
                name: getSafeDomain(r.seedUrl, 'Isolated Objective'),
                timestamp: r.timestamp || new Date().toISOString(),
                count: 0,
                mtime: r.mtime || new Date().toISOString(),
                isManifest: false
            });
        }
        if (!missionsMap.get(id).isManifest) {
            missionsMap.get(id).count++;
        }
    });

    const missions = Array.from(missionsMap.values()).sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    // Paginate mission list — 5 per page
    const totalMissions = missions.length;
    const totalMissionPages = Math.ceil(totalMissions / missionsPerPage);
    // Clamp current page in case missions were deleted
    if (missionCurrentPage > totalMissionPages) missionCurrentPage = Math.max(1, totalMissionPages);
    const mStart = (missionCurrentPage - 1) * missionsPerPage;
    const pageMissions = missions.slice(mStart, mStart + missionsPerPage);

    // v16.76: Bulk Delete Button Management
    const bulkActions = document.getElementById('bulk-actions');
    const bulkBtn = document.getElementById('bulk-delete-btn');
    if (bulkActions && !selectedBatchId && pageMissions.length > 0) {
        bulkActions.style.display = 'flex';
        bulkBtn.onclick = () => bulkDeleteCurrentPage(pageMissions.map(m => m.id));
        updateCombinedReviewControls();
    } else if (bulkActions) {
        bulkActions.style.display = 'none';
    }

    if (pageMissions.length > 0) {
        missionList.innerHTML = pageMissions.map(m => {
            const manifest = historicalMissions.find(hm => String(hm.id) === String(m.id));
            const isFailed = manifest && manifest.total > 0 && manifest.successful === 0;

            // 🏴‍☠️ Detect sailor missions from the results for this batch
            const batchResults = allResults.filter(r => String(r.batchId) === String(m.id));
            const isSailorMission = batchResults.some(r => r.isSailor);
            // Seed URL result = url matches seedUrl (depth 0 entry)
            const seedResult = batchResults.find(r => r.isSailor && r.url === r.seedUrl);

            const deduplicatedCount = manifest?.deduplicated || 0;
            const progressHtml = manifest ? `
                <div class="mission-history-progress workshop-counter ${isFailed ? 'failed-mission' : ''}" onclick="event.stopPropagation(); showHistoricalReport('${m.id}')" title="Click to see link-by-link report">
                    ${manifest.successful}/${manifest.total}
                    ${deduplicatedCount ? `<span class="mission-dedup-count" title="${deduplicatedCount} URL(s) had exact duplicate content and reuse a canonical artifact.">+${deduplicatedCount} dedup</span>` : ''}
                </div>
            ` : `
                <div class="mission-history-progress workshop-counter legacy-badge" style="background: #334155; opacity: 0.8;" title="Full report not available for older missions">
                    ${m.count} files
                </div>
            `;

            // Action buttons differ for Sailor vs normal missions
            let actionBtns;
            if (isSailorMission) {
                let viewBtn = '';
                if (seedResult) {
                    const sd = (seedResult.domain || '').replace(/'/g, "\\'");
                    const sp = (seedResult.path || '').replace(/'/g, "\\'");
                    viewBtn = `<button onclick="event.stopPropagation(); viewSailorLinks('${sd}', '${sp}')"
                                 class="batch-btn" style="background:transparent; border:1px solid #0ea5e9; color:#0ea5e9; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer;">
                                👁 View Links
                               </button>`;
                }
                actionBtns = `${viewBtn}
                   <a href="/api/export-sailor-index?batchId=${m.id}" download="sailor_index_${m.id}.txt"
                      class="batch-btn index-btn" title="Best links, deduped, sorted by score">📋 Index</a>
                   <a href="/api/export-sailor-batch-excel?batchId=${m.id}" download="sailor_batch_${m.id}.xlsx"
                      class="batch-btn" style="background:transparent; border:1px solid #10b981; color:#34d399; border-radius:6px; padding:4px 10px; font-size:11px; text-decoration:none;" title="Export all discovered links to Excel (Macro Report)">📊 Excel</a>
                   <a href="/api/export-sailor-report?batchId=${m.id}" download="sailor_report_${m.id}.txt"
                      class="batch-btn" style="background:transparent; border:1px solid #7c3aed; color:#a78bfa; border-radius:6px; padding:4px 10px; font-size:11px; text-decoration:none;" title="Full report — all visited pages, all discovered links (lvl 0 + lvl 1)">📜 Full</a>
                   <button onclick="deleteMission('${m.id}')" class="secondary-btn"
                      style="padding: 4px 10px; font-size: 11px; opacity: 0.5;" title="Delete mission">🗑️</button>`;
            } else {
                actionBtns = `<button onclick="deleteMission('${m.id}')" class="secondary-btn" title="Delete mission and all its files" style="padding: 4px 10px; font-size: 11px; opacity: 0.5;">🗑️</button>
                   <a href="/api/export?batchId=${m.id}&amp;type=index" download="mission_${m.id}_index.xlsx" class="batch-btn index-btn" title="Download an Excel audit with URL, level, filename, status, and reason">📊 Excel</a>
                   <button onclick="downloadBatch('${m.id}', 'md')" class="batch-btn md-btn" title="Download all documents as separate Markdown files">📥 MD</button>
                   <button onclick="downloadBatch('${m.id}', 'txt')" class="batch-btn txt-btn" title="Download all documents as separate Plain Text files">📥 TXT</button>
                   <button onclick="downloadBatch('${m.id}', 'pdf')" class="batch-btn pdf-btn" title="Download PDFs grouped by source domain folders">📥 PDF</button>
                   <button onclick="downloadBatch('${m.id}', 'pdf', 'flat')" class="batch-btn pdf-flat-btn" title="Download PDFs directly in the ZIP root, without domain folders">📥 PDF Flat</button>`;
            }

            if (!isSailorMission) {
                actionBtns += `<button onclick="openDuplicateReview('${m.id}')" class="batch-btn review-btn" title="Review duplicate candidates and extraction-quality signals. This never changes original files.">Review</button>`;
                if (manifest && m.id !== 'legacy') {
                    const combinedSelected = combinedReviewSelectedMissionIds.has(String(m.id));
                    actionBtns += `<label class="combined-review-selector ${combinedSelected ? 'combined-review-selector-active' : ''}" title="Select this completed mission for a two-mission corpus review">
                        <input type="checkbox" ${combinedSelected ? 'checked' : ''} onchange="toggleCombinedReviewMission('${m.id}', this.checked)">
                        Combine
                    </label>`;
                }
            }

            const cardStyle = isSailorMission
                ? 'border-color: #0369a1; background: #0c1f2e;'
                : '';
            const missionLabel = isSailorMission
                ? `${m.name} <span style="font-size:0.65rem; color:#38bdf8; background:#0c4a6e; border-radius:3px; padding:1px 6px; border:1px solid #0369a1; font-weight:700; margin-left:6px;">⛵ Sail</span>`
                : m.name;

            return `
            <div class="mission-card workshop-ledger-row ${combinedReviewSelectedMissionIds.has(String(m.id)) ? 'mission-card-combined-selected' : ''}" onclick="openMission('${m.id}')" style="${cardStyle}">
                <div class="workshop-instrument-dial" aria-hidden="true">
                    <span class="workshop-dial-hand"></span>
                    <span class="workshop-dial-hub"></span>
                </div>
                <div class="mission-info">
                    <div class="mission-name">${missionLabel}</div>
                    <div class="mission-meta">
                        <span>📅 ${formatMadridDate(m.timestamp)}</span>
                        ${m.id === 'legacy' ? '<span>• Previous results</span>' : ''}
                    </div>
                </div>
                <div class="workshop-readout" onclick="event.stopPropagation()">
                    ${progressHtml}
                </div>
                <div class="mission-card-actions workshop-action-rack" onclick="event.stopPropagation()">
                    ${actionBtns}
                </div>
            </div>
            `;
        }).join('');
    } else {
        missionList.innerHTML = '<p class="empty-msg">No history found. Launch a mission to feed Elmo!</p>';
    }

    // Render mission pagination tabs
    renderMissionPagination(totalMissionPages);
}


window.showHistoricalReport = async (id) => {
    let manifest = missionManifestCache.get(id) || historicalMissions.find(hm => hm.id === id);
    if (manifest && Array.isArray(manifest.details)) {
        renderLinkReport(manifest);
        linkReportModal.style.display = "block";
        return;
    }

    linkReportList.innerHTML = '<p class="empty-msg">Loading detailed link report...</p>';
    linkReportModal.style.display = "block";

    if (!manifest || !Array.isArray(manifest.details)) {
        try {
            const response = await fetch(`/api/missions/${encodeURIComponent(id)}`);
            if (response.ok) {
                manifest = await response.json();
                missionManifestCache.set(id, manifest);
                const index = historicalMissions.findIndex(hm => hm.id === id);
                if (index >= 0) historicalMissions[index] = { ...historicalMissions[index], ...manifest };
            }
        } catch (e) {
            console.error('Failed to load mission details:', e);
        }
    }
    if (manifest && Array.isArray(manifest.details)) {
        renderLinkReport(manifest);
        linkReportModal.style.display = "block";
    } else {
        linkReportList.innerHTML = '<p class="empty-msg">Detailed report unavailable for this mission.</p>';
    }
};

// v16.76: Reusable deletion logic
async function deleteMissionById(id) {
    try {
        const response = await fetch(`/api/missions/${id}`, { method: 'DELETE' });
        if (response.ok) {
            allResults = allResults.filter(r => (r.batchId || 'legacy') !== id);
            historicalMissions = historicalMissions.filter(hm => hm.id !== id);
            missionManifestCache.delete(id);
            combinedReviewSelectedMissionIds.delete(String(id));
            return true;
        }
    } catch (e) {
        console.error(`Error deleting mission ${id}:`, e);
    }
    return false;
}

window.deleteMission = async (id) => {
    if (!confirm("Are you sure? This will permanently delete the mission manifest and all associated harvested files.")) return;
    if (await deleteMissionById(id)) {
        renderAll();
    } else {
        alert('Failed to delete mission.');
    }
};

window.bulkDeleteCurrentPage = async (ids) => {
    if (!ids || ids.length === 0) return;
    if (!confirm(`Are you sure you want to delete ALL ${ids.length} missions on this page? This cannot be undone.`)) return;

    const btn = document.getElementById('bulk-delete-btn');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Deleting...";

    try {
        // Run deletions in sequence to avoid server/lock congestion
        for (const id of ids) {
            await deleteMissionById(id);
        }
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
        missionCurrentPage = 1; // Reset to page 1 to see fresh data
        renderAll();
    }
};

window.downloadBatch = async (id, type, layout = 'domain') => {
    // ⌛ UI Feedback: Find the specific button clicked and show loading state
    const card = document.querySelector(`.mission-card[onclick*="${id}"]`);
    const btnClass = layout === 'flat' ? `${type}-flat-btn` : `${type}-btn`;
    const btn = card ? card.querySelector(`.${btnClass}`) : null;
    const originalText = btn ? btn.innerText : `📥 ${type.toUpperCase()}${layout === 'flat' ? ' FLAT' : ''}`;

    if (btn) btn.innerText = '⌛ Zipping...';

    try {
        const response = await fetch(`/api/export-zip?batchId=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}&layout=${encodeURIComponent(layout)}`);
        if (!response.ok) {
            let detail = await response.text();
            try {
                const json = JSON.parse(detail);
                const missingPreview = (json.missingFiles || [])
                    .slice(0, 8)
                    .map(item => `- ${item.expectedFile || 'unknown'}${item.url ? `\n  ${item.url}` : ''}`)
                    .join('\n');
                detail = `${json.message || json.error || 'ZIP creation failed.'}\n\nAdded: ${json.filesAdded || 0}\nMissing: ${json.filesSkipped || 0}${missingPreview ? `\n\nMissing examples:\n${missingPreview}` : ''}`;
            } catch (_) {}
            alert(detail || 'ZIP creation failed. Please try again.');
            return;
        }

        const blob = await response.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mission_${id}_${type}s.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    } catch (e) {
        console.error('Batch download failed:', e);
        alert('ZIP creation failed. Please try again.');
    } finally {
        if (btn) setTimeout(() => btn.innerText = originalText, 2500);
    }
};

function reviewDecisionLabel(decision) {
    if (decision === 'exclude') return '<span style="color:#fca5a5;">Excluded from curated ZIP</span>';
    if (decision === 'irrelevant') return '<span style="color:#fdba74;">Excluded as irrelevant content</span>';
    if (decision === 'rescrape') return '<span style="color:#f9a8d4;">Needs re-scrape</span>';
    if (decision === 'related') return '<span style="color:#c4b5fd;">Kept as related/version source</span>';
    if (decision === 'include') return '<span style="color:#6ee7b7;">Kept in curated ZIP</span>';
    return '<span style="color:var(--text-light);">Undecided</span>';
}

function getActiveDuplicateReviewGroup() {
    return duplicateReviewState?.groups?.[duplicateReviewActiveGroupIndex] || null;
}

function reviewMemberKey(member = {}) {
    return member.sourceId || member.url || '';
}

function getDraftReviewState(group) {
    const decisions = new Map(group.members.map(member => [reviewMemberKey(member), member.decision]));
    let canonicalUrl = group.canonicalUrl || '';
    let canonicalSourceId = group.canonicalSourceId || '';

    for (const change of duplicateReviewDraftChanges.filter(item => item.groupId === group.id)) {
        if (change.action === 'keep_all') {
            for (const member of group.members) decisions.set(reviewMemberKey(member), 'include');
            canonicalUrl = '';
            canonicalSourceId = '';
        } else if (change.action === 'canonical') {
            for (const member of group.members) {
                const selected = change.sourceId
                    ? reviewMemberKey(member) === change.sourceId
                    : member.url === change.url;
                decisions.set(reviewMemberKey(member), selected ? 'include' : 'exclude');
            }
            canonicalUrl = change.url;
            canonicalSourceId = change.sourceId || '';
        } else if (change.action === 'reset') {
            const key = change.sourceId || change.url;
            decisions.delete(key);
            if ((change.sourceId && canonicalSourceId === change.sourceId) || (!change.sourceId && canonicalUrl === change.url)) {
                canonicalUrl = '';
                canonicalSourceId = '';
            }
        } else if (['exclude', 'irrelevant', 'include', 'rescrape', 'related'].includes(change.action)) {
            decisions.set(change.sourceId || change.url, change.action);
            if (['exclude', 'irrelevant', 'rescrape'].includes(change.action)
                && ((change.sourceId && canonicalSourceId === change.sourceId) || (!change.sourceId && canonicalUrl === change.url))) {
                canonicalUrl = '';
                canonicalSourceId = '';
            }
        }
    }

    return { decisions, canonicalUrl, canonicalSourceId };
}

function stagedReviewChangeCount() {
    return duplicateReviewDraftChanges.length;
}

function selectedDuplicateReviewMemberKeys(group = getActiveDuplicateReviewGroup()) {
    if (!group) return [];
    const validKeys = new Set(group.members.map(reviewMemberKey));
    duplicateReviewSelectedSourceIds = new Set(
        [...duplicateReviewSelectedSourceIds].filter(key => validKeys.has(key))
    );
    return [...duplicateReviewSelectedSourceIds];
}

function isDuplicateReviewGroupResolved(group) {
    const draft = getDraftReviewState(group);
    return group.members.every(member => (draft.decisions.get(reviewMemberKey(member)) || 'undecided') !== 'undecided');
}

function syncDuplicateReviewBulkControls() {
    const group = getActiveDuplicateReviewGroup();
    const selectedCount = selectedDuplicateReviewMemberKeys(group).length;
    const count = document.getElementById('duplicate-review-selected-count');
    if (count) count.textContent = `${selectedCount} selected`;
    document.querySelectorAll('[data-review-bulk-action]').forEach(button => {
        button.disabled = selectedCount === 0;
    });
    document.querySelectorAll('.duplicate-review-member-select').forEach(input => {
        const key = decodeURIComponent(input.dataset.reviewMemberKey || '');
        const selected = duplicateReviewSelectedSourceIds.has(key);
        input.checked = selected;
        input.closest('.duplicate-review-source-row')?.classList.toggle('duplicate-review-source-row-selected', selected);
    });
}

window.toggleDuplicateReviewMemberSelection = (encodedKey, checked) => {
    const key = decodeURIComponent(encodedKey || '');
    if (!key) return;
    if (checked) duplicateReviewSelectedSourceIds.add(key);
    else duplicateReviewSelectedSourceIds.delete(key);
    syncDuplicateReviewBulkControls();
};

window.selectAllDuplicateReviewMembers = () => {
    const group = getActiveDuplicateReviewGroup();
    if (!group) return;
    duplicateReviewSelectedSourceIds = new Set(group.members.map(reviewMemberKey));
    syncDuplicateReviewBulkControls();
};

window.clearDuplicateReviewMemberSelection = () => {
    duplicateReviewSelectedSourceIds.clear();
    syncDuplicateReviewBulkControls();
};

window.stageSelectedDuplicateReviewDecision = action => {
    const group = getActiveDuplicateReviewGroup();
    const selectedKeys = new Set(selectedDuplicateReviewMemberKeys(group));
    if (!group || selectedKeys.size === 0) return;

    for (const member of group.members.filter(candidate => selectedKeys.has(reviewMemberKey(candidate)))) {
        const sourceId = member.sourceId || '';
        duplicateReviewDraftChanges = duplicateReviewDraftChanges.filter(change => !(
            change.groupId === group.id && (sourceId ? change.sourceId === sourceId : change.url === member.url)
        ));
        duplicateReviewDraftChanges.push({ groupId: group.id, action, url: member.url, sourceId });
    }
    duplicateReviewSelectedSourceIds.clear();
    renderDuplicateReview(duplicateReviewState);
};

function previewArtifactName(member) {
    return member?.files?.md || member?.files?.txt || '';
}

function reviewQualityMetrics(member) {
    const quality = member?.quality;
    if (!quality) return '';
    const signalText = (quality.signals || []).map(signal => signal.label).join(' | ');
    return `<div class="duplicate-review-quality-metrics">
        <span>Quality ${quality.qualityScore}/100</span>
        <span>${Number(quality.semanticChars || 0).toLocaleString()} chars</span>
        <span>${Math.round((quality.boilerplateRatio || 0) * 100)}% repeated</span>
        <span>${escapeHtml(quality.pdfKind || 'no PDF kind')}</span>
        ${signalText ? `<strong>${escapeHtml(signalText)}</strong>` : ''}
    </div>`;
}

function visibleDuplicateReviewGroupIndices(review) {
    const query = duplicateReviewSearch.trim().toLowerCase();
    return review.groups.map((group, index) => ({ group, index })).filter(({ group }) => {
        if (duplicateReviewCategoryFilter !== 'all' && group.category !== duplicateReviewCategoryFilter) return false;
        if (duplicateReviewUnresolvedOnly) {
            const draft = getDraftReviewState(group);
            if (!group.members.some(member => (draft.decisions.get(reviewMemberKey(member)) || 'undecided') === 'undecided')) return false;
        }
        if (query) {
            const haystack = `${group.matchType} ${group.title || ''} ${group.members.map(member => `${member.url} ${member.title}`).join(' ')}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        return true;
    }).map(item => item.index);
}

function captureDuplicateReviewScrollPositions() {
    const scrollTop = (id) => document.getElementById(id)?.scrollTop || 0;
    return {
        content: scrollTop('duplicate-review-content'),
        body: scrollTop('duplicate-review-body'),
        groups: scrollTop('duplicate-review-groups-scroll'),
        sources: scrollTop('duplicate-review-sources-scroll'),
        leftPreview: scrollTop('duplicate-preview-left'),
        rightPreview: scrollTop('duplicate-preview-right')
    };
}

function restoreDuplicateReviewScrollPositions(positions, preserveSourceDetails) {
    const restore = () => {
        const setScrollTop = (id, value) => {
            const element = document.getElementById(id);
            if (element) element.scrollTop = value;
        };

        setScrollTop('duplicate-review-content', positions.content);
        setScrollTop('duplicate-review-body', positions.body);
        setScrollTop('duplicate-review-groups-scroll', positions.groups);
        if (preserveSourceDetails) setScrollTop('duplicate-review-sources-scroll', positions.sources);
    };

    // The clicked element is replaced during render; restore after the browser lays out the new controls.
    restore();
    requestAnimationFrame(restore);
}

function reviewMemberSelect(group, selectedIndex, side) {
    return `<label style="display:block; font-size:11px; color:var(--text-light); margin-bottom:6px;">${side === 'left' ? 'Canonical / source A' : 'Compare / source B'}
        <select onchange="setDuplicateReviewSelection('${side}', Number(this.value))" style="width:100%; margin-top:4px; padding:7px; background:#0f172a; color:var(--text); border:1px solid var(--border); border-radius:6px;">
            ${group.members.map((member, index) => `<option value="${index}" ${index === selectedIndex ? 'selected' : ''}>${index + 1}. ${escapeHtml(member.url)}</option>`).join('')}
        </select>
    </label>`;
}

function reviewSourceList(group, draft) {
    const selectedCount = selectedDuplicateReviewMemberKeys(group).length;
    return `<section class="duplicate-review-sources">
        <div class="duplicate-review-sources-title">
            <div><strong>ALL ${group.members.length} SOURCES</strong><span>Choose any source for A or B. Decisions are staged, not applied yet.</span></div>
            <div class="duplicate-review-bulk-actions">
                <span id="duplicate-review-selected-count">${selectedCount} selected</span>
                <button class="secondary-btn" onclick="selectAllDuplicateReviewMembers()">Select all</button>
                <button class="secondary-btn" onclick="clearDuplicateReviewMemberSelection()">Clear</button>
                <button class="secondary-btn" data-review-bulk-action onclick="stageSelectedDuplicateReviewDecision('reset')" ${selectedCount ? '' : 'disabled'}>Needs review</button>
                <button class="secondary-btn review-irrelevant" data-review-bulk-action onclick="stageSelectedDuplicateReviewDecision('irrelevant')" ${selectedCount ? '' : 'disabled'}>Irrelevant</button>
                <button class="secondary-btn review-rescrape" data-review-bulk-action onclick="stageSelectedDuplicateReviewDecision('rescrape')" ${selectedCount ? '' : 'disabled'}>Needs re-scrape</button>
                <button class="secondary-btn review-keep" data-review-bulk-action onclick="stageSelectedDuplicateReviewDecision('include')" ${selectedCount ? '' : 'disabled'}>Keep</button>
                ${group.category !== 'quality' ? `<button class="secondary-btn review-duplicate" data-review-bulk-action onclick="stageSelectedDuplicateReviewDecision('exclude')" ${selectedCount ? '' : 'disabled'}>Duplicate</button>` : ''}
            </div>
        </div>
        <div id="duplicate-review-sources-scroll" class="duplicate-review-sources-scroll">
            ${group.members.map((member, index) => {
                const isLeft = index === duplicateReviewSelection.left;
                const isRight = index === duplicateReviewSelection.right;
                const decision = draft.decisions.get(reviewMemberKey(member)) || 'undecided';
                const memberKey = reviewMemberKey(member);
                const encodedMemberKey = encodeURIComponent(memberKey);
                const selected = duplicateReviewSelectedSourceIds.has(memberKey);
                return `<div class="duplicate-review-source-row ${selected ? 'duplicate-review-source-row-selected' : ''}">
                    <label class="duplicate-review-member-checkbox" title="Select this source for a staged bulk action">
                        <input class="duplicate-review-member-select" type="checkbox" data-review-member-key="${escapeHtml(encodedMemberKey)}" ${selected ? 'checked' : ''} onchange="toggleDuplicateReviewMemberSelection('${encodedMemberKey}', this.checked)">
                    </label>
                    <div class="duplicate-review-source-url">${index + 1}. ${escapeHtml(member.url)}
                        ${member.missionId ? `<small class="review-mission-origin">Mission ${escapeHtml(member.missionId)} &middot; row ${escapeHtml(member.missionInputIndex ?? '')}</small>` : ''}
                        <span>${reviewDecisionLabel(decision)}</span>
                    </div>
                    <div class="duplicate-review-source-actions">
                        <button class="secondary-btn ${isLeft ? 'review-source-selected-a' : ''}" onclick="setDuplicateReviewSelection('left', ${index})">A${isLeft ? ' selected' : ''}</button>
                        ${group.members.length > 1 ? `<button class="secondary-btn ${isRight ? 'review-source-selected-b' : ''}" onclick="setDuplicateReviewSelection('right', ${index})">B${isRight ? ' selected' : ''}</button>` : ''}
                    </div>
                </div>`;
            }).join('')}
        </div>
    </section>`;
}

function reviewSourcePanel(member, side, group, draft) {
    const name = previewArtifactName(member);
    const baseName = encodeURIComponent(name.replace(/\.(md|txt)$/i, ''));
    const domain = encodeURIComponent(member.domain || '');
    const fullPreviewButton = name && member.domain
        ? `<button class="secondary-btn" onclick="openReviewFullText(decodeURIComponent('${domain}'), decodeURIComponent('${baseName}'))" style="padding:3px 7px; font-size:10px;">Open full text</button>`
        : '';
    const decision = draft.decisions.get(reviewMemberKey(member)) || 'undecided';
    const groupId = encodeURIComponent(group.id);
    const sourceUrl = encodeURIComponent(member.url);
    const sourceId = encodeURIComponent(member.sourceId || '');
    const sourceLabel = side === 'left' ? 'A' : 'B';
    const canonicalActions = group.category !== 'quality' && group.members.length > 1
        ? `<button class="batch-btn pdf-flat-btn" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'canonical', decodeURIComponent('${sourceUrl}'), decodeURIComponent('${sourceId}'))">${sourceLabel} canonical</button>
           <button class="secondary-btn review-related" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'related', decodeURIComponent('${sourceUrl}'), decodeURIComponent('${sourceId}'))">Related/version</button>`
        : '';
    return `<article class="duplicate-review-preview-panel">
        ${group.members.length > 1 ? reviewMemberSelect(group, duplicateReviewSelection[side], side) : '<div class="duplicate-review-single-source">Single quality-review source</div>'}
        <div class="duplicate-review-preview-url">${escapeHtml(member.url)}</div>
        ${member.missionId ? `<div class="review-mission-origin">Mission ${escapeHtml(member.missionId)} &middot; original row ${escapeHtml(member.missionInputIndex ?? '')}</div>` : ''}
        <div class="duplicate-review-preview-status">${reviewDecisionLabel(decision)}${member.files.pdf ? ' &middot; PDF saved' : ''}</div>
        ${reviewQualityMetrics(member)}
        <div class="duplicate-review-panel-actions">
            <button class="secondary-btn review-keep" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'include', decodeURIComponent('${sourceUrl}'), decodeURIComponent('${sourceId}'))">Keep ${sourceLabel}</button>
            ${canonicalActions}
            ${group.category !== 'quality' ? `<button class="secondary-btn review-duplicate" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'exclude', decodeURIComponent('${sourceUrl}'), decodeURIComponent('${sourceId}'))">Duplicate</button>` : ''}
            <button class="secondary-btn review-irrelevant" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'irrelevant', decodeURIComponent('${sourceUrl}'), decodeURIComponent('${sourceId}'))">Irrelevant</button>
            <button class="secondary-btn review-rescrape" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'rescrape', decodeURIComponent('${sourceUrl}'), decodeURIComponent('${sourceId}'))">Needs re-scrape</button>
        </div>
        <div class="duplicate-review-preview-links">
            <a href="${escapeHtml(member.url)}" target="_blank" rel="noopener noreferrer" class="secondary-btn" style="padding:4px 8px; font-size:11px; text-decoration:none;">Open source</a>
            ${fullPreviewButton}
        </div>
        <pre id="duplicate-preview-${side}" class="duplicate-review-preview-text">Loading saved text preview...</pre>
    </article>`;
}

async function loadDuplicatePreview(side, member, expectedSourceId, preservedScrollTop = 0) {
    const preview = document.getElementById(`duplicate-preview-${side}`);
    if (!preview) return;
    const filename = previewArtifactName(member);
    if (!member.domain || !filename) {
        preview.textContent = 'No saved TXT or Markdown preview is available for this result.';
        return;
    }
    const baseName = filename.replace(/\.(md|txt)$/i, '');
    try {
        const cacheKey = `${member.domain}/${baseName}`;
        let text = duplicateReviewTextCache.get(cacheKey);
        if (text === undefined) {
            let response = await fetch(`/api/view?domain=${encodeURIComponent(member.domain)}&name=${encodeURIComponent(baseName)}&type=txt`);
            if (!response.ok) response = await fetch(`/api/view?domain=${encodeURIComponent(member.domain)}&name=${encodeURIComponent(baseName)}&type=md`);
            if (!response.ok) throw new Error('Saved text could not be loaded');
            text = await response.text();
            duplicateReviewTextCache.set(cacheKey, text);
            while (duplicateReviewTextCache.size > 12) {
                duplicateReviewTextCache.delete(duplicateReviewTextCache.keys().next().value);
            }
        } else {
            // Refresh recency without retaining an unbounded number of long documents.
            duplicateReviewTextCache.delete(cacheKey);
            duplicateReviewTextCache.set(cacheKey, text);
        }
        const activeMember = getActiveDuplicateReviewGroup()?.members?.[duplicateReviewSelection[side]];
        if (!activeMember || reviewMemberKey(activeMember) !== expectedSourceId) return;
        preview.dataset.fullText = text;
        applyDuplicateReviewPreviewMode();
        preview.scrollTop = preservedScrollTop;
    } catch (error) {
        preview.textContent = `Preview unavailable: ${error.message}`;
        preview.scrollTop = preservedScrollTop;
    }
}

function applyDuplicateReviewPreviewMode() {
    const left = document.getElementById('duplicate-preview-left');
    const right = document.getElementById('duplicate-preview-right');
    if (!left?.dataset.fullText) return;

    const limit = text => text.length > 7000
        ? `${text.slice(0, 7000)}\n\n[Preview limited to 7,000 characters. Use Open full text for the complete artifact.]`
        : text;
    if (!duplicateReviewDifferenceOnly || !right?.dataset.fullText) {
        left.textContent = limit(left.dataset.fullText);
        if (right?.dataset.fullText) right.textContent = limit(right.dataset.fullText);
        return;
    }

    const normalizedLines = text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const leftLines = normalizedLines(left.dataset.fullText);
    const rightLines = normalizedLines(right.dataset.fullText);
    const leftSet = new Set(leftLines);
    const rightSet = new Set(rightLines);
    const onlyLeft = leftLines.filter(line => !rightSet.has(line));
    const onlyRight = rightLines.filter(line => !leftSet.has(line));
    left.textContent = onlyLeft.length ? limit(onlyLeft.join('\n\n')) : '[No line-level text unique to source A]';
    right.textContent = onlyRight.length ? limit(onlyRight.join('\n\n')) : '[No line-level text unique to source B]';
}

window.toggleDuplicateReviewDifferences = () => {
    duplicateReviewDifferenceOnly = !duplicateReviewDifferenceOnly;
    applyDuplicateReviewPreviewMode();
    const button = document.getElementById('duplicate-review-diff-toggle');
    if (button) button.textContent = duplicateReviewDifferenceOnly ? 'Show full previews' : 'Show differences only';
};

window.openReviewFullText = async (domain, name) => {
    previewModal.classList.add('review-full-text-modal');
    await window.view(domain, name);
};

function renderDuplicateReview(review) {
    const previousGroupId = getActiveDuplicateReviewGroup()?.id;
    const scrollPositions = captureDuplicateReviewScrollPositions();
    duplicateReviewState = review;
    duplicateReviewTitle.textContent = review.combined
        ? `Combined Corpus Review · ${review.missionIds.length} missions`
        : 'Corpus Quality Review';
    if (!review.groups.length) {
        duplicateReviewList.innerHTML = `<p class="empty-msg">No duplicate, similarity, or quality-review candidates were found. All successful PDF artifacts remain eligible for the curated export.</p>
            <div class="duplicate-review-footer">
                ${review.combined ? '<button class="batch-btn index-btn" onclick="downloadCombinedReviewIndex()">Download Combined Excel</button>' : ''}
                <button class="batch-btn pdf-flat-btn" onclick="downloadCuratedPdf()">${review.combined ? 'Download Combined Curated PDF Flat' : 'Download Curated PDF Flat'}</button>
            </div>`;
        return;
    }

    const visibleIndices = visibleDuplicateReviewGroupIndices(review);
    if (!visibleIndices.includes(duplicateReviewActiveGroupIndex)) {
        duplicateReviewActiveGroupIndex = visibleIndices[0] ?? 0;
        duplicateReviewSelection = { left: 0, right: 1 };
    }
    const categoryCounts = review.groups.reduce((counts, item) => {
        counts[item.category] = (counts[item.category] || 0) + 1;
        return counts;
    }, {});
    const toolbar = `<div class="duplicate-review-toolbar">
        <select onchange="setDuplicateReviewCategoryFilter(this.value)">
            <option value="all" ${duplicateReviewCategoryFilter === 'all' ? 'selected' : ''}>All review signals (${review.groups.length})</option>
            <option value="duplicate" ${duplicateReviewCategoryFilter === 'duplicate' ? 'selected' : ''}>Exact/title matches (${categoryCounts.duplicate || 0})</option>
            <option value="near_duplicate" ${duplicateReviewCategoryFilter === 'near_duplicate' ? 'selected' : ''}>Near duplicates (${categoryCounts.near_duplicate || 0})</option>
            <option value="quality" ${duplicateReviewCategoryFilter === 'quality' ? 'selected' : ''}>Quality anomalies (${categoryCounts.quality || 0})</option>
        </select>
        <label><input type="checkbox" ${duplicateReviewUnresolvedOnly ? 'checked' : ''} onchange="setDuplicateReviewUnresolvedOnly(this.checked)"> Unresolved only</label>
        <span>${visibleIndices.length} visible group${visibleIndices.length === 1 ? '' : 's'}</span>
    </div>`;
    if (visibleIndices.length === 0) {
        duplicateReviewList.innerHTML = `${toolbar}<p class="empty-msg">No review groups match the current filters.</p>`;
        return;
    }

    const group = getActiveDuplicateReviewGroup();
    if (duplicateReviewSelection.left >= group.members.length) duplicateReviewSelection.left = 0;
    if (duplicateReviewSelection.right >= group.members.length || duplicateReviewSelection.right === duplicateReviewSelection.left) {
        duplicateReviewSelection.right = group.members.length > 1 ? (duplicateReviewSelection.left === 0 ? 1 : 0) : 0;
    }
    const left = group.members[duplicateReviewSelection.left];
    const right = group.members.length > 1 ? group.members[duplicateReviewSelection.right] : null;
    const draft = getDraftReviewState(group);
    const duplicateExcludedCount = group.members.filter(member => draft.decisions.get(reviewMemberKey(member)) === 'exclude').length;
    const irrelevantCount = group.members.filter(member => draft.decisions.get(reviewMemberKey(member)) === 'irrelevant').length;
    const rescrapeCount = group.members.filter(member => draft.decisions.get(reviewMemberKey(member)) === 'rescrape').length;
    const groupId = encodeURIComponent(group.id);

    duplicateReviewList.innerHTML = `${toolbar}<div class="duplicate-review-workbench">
        <aside id="duplicate-review-groups-scroll" class="duplicate-review-groups">
            <div class="duplicate-review-groups-title">REVIEW GROUPS</div>
            ${visibleIndices.map(index => {
                const item = review.groups[index];
                const itemDraft = getDraftReviewState(item);
                const excluded = item.members.filter(member => itemDraft.decisions.get(reviewMemberKey(member)) === 'exclude').length;
                const irrelevant = item.members.filter(member => itemDraft.decisions.get(reviewMemberKey(member)) === 'irrelevant').length;
                const rescrape = item.members.filter(member => itemDraft.decisions.get(reviewMemberKey(member)) === 'rescrape').length;
                const resolved = isDuplicateReviewGroupResolved(item);
                return `<button onclick="selectDuplicateReviewGroup(${index})" class="secondary-btn duplicate-review-group-button ${index === duplicateReviewActiveGroupIndex ? 'duplicate-review-group-active' : ''} ${resolved ? 'duplicate-review-group-complete' : ''}">
                    Review ${index + 1}<br><span>${escapeHtml(item.matchType)} &middot; ${item.members.length} source${item.members.length === 1 ? '' : 's'}${excluded ? ` &middot; ${excluded} duplicate` : ''}${irrelevant ? ` &middot; ${irrelevant} irrelevant` : ''}${rescrape ? ` &middot; ${rescrape} re-scrape` : ''}</span>
                </button>`;
            }).join('')}
        </aside>
        <section class="duplicate-review-main">
            <div class="duplicate-review-main-heading">
                <div class="duplicate-review-main-summary" title="${escapeHtml(group.reason)}"><strong>Review ${duplicateReviewActiveGroupIndex + 1}: ${escapeHtml(group.matchType)}</strong><div>${group.members.length} source${group.members.length === 1 ? '' : 's'}${group.title ? ` &middot; ${escapeHtml(group.title)}` : ''}</div></div>
                <span>${duplicateExcludedCount} duplicate &middot; ${irrelevantCount} irrelevant &middot; ${rescrapeCount} re-scrape</span>
            </div>
            ${group.qualityWarning ? `<div class="duplicate-review-warning">${escapeHtml(group.qualityWarning)}</div>` : ''}
            ${reviewSourceList(group, draft)}
            <div class="duplicate-review-preview-grid ${right ? '' : 'duplicate-review-preview-single'}">${reviewSourcePanel(left, 'left', group, draft)}${right ? reviewSourcePanel(right, 'right', group, draft) : ''}</div>
            <div class="duplicate-review-note">Actions are staged locally. Duplicate, irrelevant, related/version, and needs re-scrape remain distinct in the Excel audit. Original mission files and normal ZIP downloads remain untouched.</div>
        </section>
    </div>
    <div class="duplicate-review-footer">
        <button class="secondary-btn review-keep" onclick="stageDuplicateReviewDecision(decodeURIComponent('${groupId}'), 'keep_all', '')">Keep all current group</button>
        <button class="secondary-btn" id="duplicate-review-diff-toggle" onclick="toggleDuplicateReviewDifferences()">${duplicateReviewDifferenceOnly ? 'Show full previews' : 'Show differences only'}</button>
        <button class="secondary-btn" onclick="stageFirstSourceCanonicalForAll()" style="border-color:#f59e0b; color:#fde68a;">Stage: mark source A as canonical for duplicate groups</button>
        ${stagedReviewChangeCount() > 0 ? `<button class="secondary-btn" onclick="discardStagedDuplicateReviewChanges()">Discard ${stagedReviewChangeCount()} staged change${stagedReviewChangeCount() === 1 ? '' : 's'}</button><button class="batch-btn" onclick="applyStagedDuplicateReviewChanges()">Apply ${stagedReviewChangeCount()} review change${stagedReviewChangeCount() === 1 ? '' : 's'}</button>` : '<span style="font-size:11px; color:var(--text-light); align-self:center;">No staged review changes</span>'}
        ${review.combined ? '<button class="batch-btn index-btn" onclick="downloadCombinedReviewIndex()">Download Combined Excel</button>' : ''}
        <button class="batch-btn pdf-flat-btn" onclick="downloadCuratedPdf()">${review.combined ? 'Download Combined Curated PDF Flat' : 'Download Curated PDF Flat'}</button>
    </div>`;

    const preserveSourceDetails = previousGroupId === group.id;
    restoreDuplicateReviewScrollPositions(scrollPositions, preserveSourceDetails);
    loadDuplicatePreview('left', left, reviewMemberKey(left), preserveSourceDetails ? scrollPositions.leftPreview : 0);
    if (right) loadDuplicatePreview('right', right, reviewMemberKey(right), preserveSourceDetails ? scrollPositions.rightPreview : 0);
}

window.selectDuplicateReviewGroup = (index) => {
    duplicateReviewActiveGroupIndex = index;
    duplicateReviewSelection = { left: 0, right: 1 };
    duplicateReviewSelectedSourceIds.clear();
    renderDuplicateReview(duplicateReviewState);
};

window.setDuplicateReviewSelection = (side, index) => {
    duplicateReviewSelection[side] = index;
    const group = getActiveDuplicateReviewGroup();
    if (group.members.length > 1 && duplicateReviewSelection.left === duplicateReviewSelection.right) {
        duplicateReviewSelection[side === 'left' ? 'right' : 'left'] = index === 0 ? 1 : 0;
    }
    renderDuplicateReview(duplicateReviewState);
};

window.setDuplicateReviewCategoryFilter = value => {
    duplicateReviewCategoryFilter = value;
    renderDuplicateReview(duplicateReviewState);
};

window.setDuplicateReviewUnresolvedOnly = checked => {
    duplicateReviewUnresolvedOnly = Boolean(checked);
    renderDuplicateReview(duplicateReviewState);
};

window.setDuplicateReviewSearch = value => {
    duplicateReviewSearch = String(value || '');
    renderDuplicateReview(duplicateReviewState);
};

window.stageDuplicateReviewDecision = (groupId, action, url = '', sourceId = '') => {
    if (!getActiveDuplicateReviewGroup()) return;

    if (action === 'keep_all' || action === 'canonical') {
        duplicateReviewDraftChanges = duplicateReviewDraftChanges.filter(change => change.groupId !== groupId);
    } else {
        duplicateReviewDraftChanges = duplicateReviewDraftChanges.filter(change => !(
            change.groupId === groupId
            && (sourceId ? change.sourceId === sourceId : change.url === url)
        ));
    }

    duplicateReviewDraftChanges.push({ groupId, action, url, sourceId });
    renderDuplicateReview(duplicateReviewState);
};

window.stageFirstSourceCanonicalForAll = () => {
    const groups = duplicateReviewState?.groups || [];
    if (groups.length === 0) return;

    const groupsWithExistingChanges = new Set(duplicateReviewDraftChanges.map(change => change.groupId));
    const additions = groups
        .filter(group => ['duplicate', 'near_duplicate'].includes(group.category)
            && group.members.length > 1
            && !groupsWithExistingChanges.has(group.id)
            && group.members[0]?.url)
        .map(group => ({
            groupId: group.id,
            action: 'canonical',
            url: group.members[0].url,
            sourceId: group.members[0].sourceId || ''
        }));

    if (additions.length === 0) {
        alert('Every review group already has a staged decision. Adjust individual exceptions or discard the current staged changes first.');
        return;
    }

    duplicateReviewDraftChanges.push(...additions);
    renderDuplicateReview(duplicateReviewState);
};

window.discardStagedDuplicateReviewChanges = () => {
    duplicateReviewDraftChanges = [];
    renderDuplicateReview(duplicateReviewState);
};

window.applyStagedDuplicateReviewChanges = async () => {
    if (duplicateReviewDraftChanges.length === 0) return;
    if (!duplicateReviewState) return;
    const count = duplicateReviewDraftChanges.length;
    if (!confirm(`Apply ${count} staged review change${count === 1 ? '' : 's'} to the curated ZIP? Original mission files and regular ZIPs will remain unchanged.`)) return;

    try {
        const combined = duplicateReviewState.combined === true;
        const response = await fetch(combined ? '/api/curation/combined/decisions' : '/api/curation/duplicates/decisions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batchId: duplicateReviewState.batchId,
                missionIds: duplicateReviewState.missionIds || [],
                changes: duplicateReviewDraftChanges
            })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Unable to apply review changes');
        duplicateReviewDraftChanges = [];
        renderDuplicateReview(payload);
    } catch (error) {
        alert(`Review changes were not applied: ${error.message}`);
    }
};

window.openDuplicateReview = async (batchId) => {
    duplicateReviewTitle.textContent = 'Corpus Quality Review';
    duplicateReviewState = null;
    duplicateReviewActiveGroupIndex = 0;
    duplicateReviewSelection = { left: 0, right: 1 };
    duplicateReviewDraftChanges = [];
    duplicateReviewCategoryFilter = 'all';
    duplicateReviewUnresolvedOnly = false;
    duplicateReviewSearch = '';
    duplicateReviewDifferenceOnly = false;
    duplicateReviewSelectedSourceIds.clear();
    duplicateReviewTextCache.clear();
    duplicateReviewList.innerHTML = '<p class="empty-msg">Loading review candidates...</p>';
    duplicateReviewModal.style.display = 'block';
    try {
        const response = await fetch(`/api/curation/duplicates?batchId=${encodeURIComponent(batchId)}`);
        if (!response.ok) throw new Error(await response.text());
        renderDuplicateReview(await response.json());
    } catch (error) {
        duplicateReviewList.innerHTML = `<p class="empty-msg">Could not load review candidates: ${escapeHtml(error.message)}</p>`;
    }
};

window.openCombinedReview = async (missionIds = []) => {
    if (!Array.isArray(missionIds) || missionIds.length !== 2) {
        alert('Select exactly two completed document missions.');
        return;
    }
    duplicateReviewTitle.textContent = 'Combined Corpus Review';
    duplicateReviewState = null;
    duplicateReviewActiveGroupIndex = 0;
    duplicateReviewSelection = { left: 0, right: 1 };
    duplicateReviewDraftChanges = [];
    duplicateReviewCategoryFilter = 'all';
    duplicateReviewUnresolvedOnly = false;
    duplicateReviewSearch = '';
    duplicateReviewDifferenceOnly = false;
    duplicateReviewSelectedSourceIds.clear();
    duplicateReviewTextCache.clear();
    duplicateReviewList.innerHTML = '<p class="empty-msg">Loading cross-mission review candidates...</p>';
    duplicateReviewModal.style.display = 'block';
    try {
        const query = missionIds.map(encodeURIComponent).join(',');
        const response = await fetch(`/api/curation/combined?missionIds=${query}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Combined review could not be loaded');
        renderDuplicateReview(payload);
    } catch (error) {
        duplicateReviewList.innerHTML = `<p class="empty-msg">Could not load combined review candidates: ${escapeHtml(error.message)}</p>`;
    }
};

window.saveDuplicateDecision = async (batchId, groupId, action, url, sourceId = '') => {
    try {
        const response = await fetch('/api/curation/duplicates/decision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchId, groupId, action, url, sourceId })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Unable to save decision');
        renderDuplicateReview(payload);
    } catch (error) {
        alert(`Review decision was not saved: ${error.message}`);
    }
};

window.downloadCuratedPdf = async () => {
    if (duplicateReviewDraftChanges.length > 0) {
        alert('Apply or discard the staged review changes before downloading the curated ZIP.');
        return;
    }
    if (!duplicateReviewState) return;
    const combined = duplicateReviewState.combined === true;
    const batchId = duplicateReviewState.batchId;
    try {
        const query = combined
            ? `missionIds=${duplicateReviewState.missionIds.map(encodeURIComponent).join(',')}`
            : `batchId=${encodeURIComponent(batchId)}&type=pdf&layout=flat`;
        const response = await fetch(combined
            ? `/api/export-combined-curated-zip?${query}`
            : `/api/export-curated-zip?${query}`);
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = combined
            ? `combined_${batchId}_curated_pdfs_flat.zip`
            : `mission_${batchId}_curated_pdfs.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    } catch (error) {
        alert(`Curated ZIP could not be created: ${error.message}`);
    }
};

window.downloadCombinedReviewIndex = async () => {
    if (!duplicateReviewState?.combined) return;
    if (duplicateReviewDraftChanges.length > 0) {
        alert('Apply or discard the staged review changes before downloading the combined Excel.');
        return;
    }
    try {
        const query = duplicateReviewState.missionIds.map(encodeURIComponent).join(',');
        const response = await fetch(`/api/export-combined-index?missionIds=${query}`);
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `combined_${duplicateReviewState.batchId}_index.xlsx`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    } catch (error) {
        alert(`Combined Excel could not be created: ${error.message}`);
    }
};

window.openMission = (id) => {
    selectedBatchId = id;
    currentPage = 1;
    renderAll();
};

function renderResults() {
    const filtered = selectedBatchId
        ? allResults.filter(r => (r.batchId || 'legacy') === selectedBatchId)
        : [];

    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageItems = filtered.slice(start, end);

    if (pageItems.length > 0) {
        resultsList.innerHTML = pageItems.map(r => {
            const safeTitle = (r.title || 'document').replace(/[\\/:*?"<>|#]/g, '_').replace(/\s+/g, '_').substring(0, 120);
            const safeDomain = (r.domain || '').replace(/[^a-zA-Z0-9]/g, '_');
            const safeFilename = `${safeTitle}_${safeDomain}`;

            const escDomain = (r.domain || '').replace(/'/g, "\\'");
            const escPath = (r.path || '').replace(/'/g, "\\'");
            const escTitleAttr = (r.title || '').replace(/"/g, '&amp;quot;');

            // 🏴‍☠️ Sailor Mode: different button set
            const sailorBadge = r.isSailor ? `<span class="sailor-mode-badge">🏴‍☠️ Sailor</span>` : '';
            const actionBtns = r.isSailor
                ? `<div style="display:flex; gap:8px; flex-shrink: 0;">
                    ${r.urlCount === 1
                    ? `<button class="secondary-btn" style="padding:4px 10px; font-size:11px; border-color:#0ea5e9; color:#0ea5e9;" onclick="viewSailorLinks('${escDomain}', '${escPath}')">👁 View Links</button>`
                    : ''}
                    <a href="/api/export-sailor-single-excel?domain=${encodeURIComponent(r.domain)}&amp;name=${encodeURIComponent(r.path)}" download="sailor_links_${safeFilename}.xlsx" class="secondary-btn" style="padding:4px 10px; font-size:11px; border-color:#10b981; color:#34d399;">📊 Excel</a>
                    <a href="/api/export-sailor-index?batchId=${r.batchId}" download="sailor_index_${r.batchId}.txt" class="secondary-btn" style="padding:4px 10px; font-size:11px;" title="Download best links, deduped and scored">📋 Index</a>
                   </div>`
                : `<div style="display:flex; gap:8px; flex-shrink: 0;">
                    <button class="secondary-btn" style="padding:4px 10px; font-size:11px" onclick="view('${escDomain}', '${escPath}')">View</button>
                    ${r.hasMd ? `<a href="/api/view?domain=${encodeURIComponent(r.domain)}&amp;name=${encodeURIComponent(r.path)}&amp;type=md" download="${safeFilename}.md" class="secondary-btn" style="padding:4px 10px; font-size:11px; border-color:var(--primary); color:var(--primary)">MD</a>` : ''}
                    ${r.hasTxt ? `<a href="/api/view?domain=${encodeURIComponent(r.domain)}&amp;name=${encodeURIComponent(r.path)}&amp;type=txt" download="${safeFilename}.txt" class="secondary-btn" style="padding:4px 10px; font-size:11px; border-color:var(--success); color:var(--success)">TXT</a>` : ''}
                    ${r.hasPdf ? `<a href="/api/view?domain=${encodeURIComponent(r.domain)}&amp;name=${encodeURIComponent(r.path)}&amp;type=pdf" download="${safeFilename}.pdf" class="secondary-btn" style="padding:4px 10px; font-size:11px; border-color:#a855f7; color:#a855f7">PDF</a>` : ''}
                   </div>`;

            return `
            <div class="result-item" style="${r.isSailor ? 'border-color: #0369a1;' : ''}">
                <div class="result-info">
                    <h4 title="${escTitleAttr}">${r.title}${sailorBadge}</h4>
                    <div style="font-size: 10px; opacity: 0.6; margin-bottom: 4px;">
                        <span>Harvested: ${formatMadridDate(r.timestamp) || 'Just now'}</span>
                        ${r.size_kb ? ` • <span style="color: var(--success); font-weight: 600;">${parseFloat(r.size_kb).toFixed(1)} KB</span>` : ''}
                        ${r.seedUrl ? ` • <span style="color: var(--primary)">Source: ${new URL(r.seedUrl).hostname}</span>` : ''}
                    </div>
                    <a href="${r.url}" target="_blank" rel="noopener noreferrer" style="font-size: 11px; color: var(--accent); text-decoration: none; display: inline-block;" title="${r.url}">🔗 ${r.url}</a>
                </div>
                ${actionBtns}
            </div>
        `;
        }).join('');
    } else {
        resultsList.innerHTML = '<p class="empty-msg">No results found for this mission.</p>';
    }
}

function renderMissionPagination(totalPages) {
    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }
    let html = '';
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="page-btn ${i === missionCurrentPage ? 'active' : ''}" onclick="changeMissionPage(${i})">${i}</button>`;
    }
    paginationContainer.innerHTML = html;
}

function renderPagination() {
    if (!selectedBatchId) {
        // Mission pagination is handled by renderMissions() -> renderMissionPagination()
        return;
    }
    const filtered = allResults.filter(r => (r.batchId || 'legacy') === selectedBatchId);
    const totalItems = filtered.length;

    if (totalItems <= itemsPerPage) {
        paginationContainer.innerHTML = '';
        return;
    }

    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }

    let html = '';
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
    }
    paginationContainer.innerHTML = html;
}


window.changeMissionPage = (page) => {
    missionCurrentPage = page;
    renderAll();
};

window.changePage = (page) => {
    currentPage = page;
    renderAll();
};


window.view = async (domain, name) => {
    try {
        const dEnc = encodeURIComponent(domain);
        const nEnc = encodeURIComponent(name);
        let res = await fetch(`/api/view?domain=${dEnc}&name=${nEnc}&type=md`);
        if (!res.ok) {
            res = await fetch(`/api/view?domain=${dEnc}&name=${nEnc}&type=txt`);
        }

        if (res.ok) {
            const text = await res.text();
            const previewText = document.getElementById('preview-text');
            if (previewText) {
                previewText.textContent = text;
                document.getElementById('preview-title').textContent = name;
                previewModal.style.display = "block";
                // Reset scroll position
                previewText.parentElement.scrollTop = 0;
            }
        } else {
            const previewText = document.getElementById('preview-text');
            if (previewText) {
                previewText.textContent = "Content not found in MD or TXT format.";
                document.getElementById('preview-title').textContent = "Missing File";
                previewModal.style.display = "block";
            }
        }
    } catch (e) {
        console.error('Preview error:', e);
        alert("Error loading preview");
    }
};

// 🏴‍☠️ Sailor Mode: View scored link list for a single result
window.viewSailorLinks = async (domain, name) => {
    try {
        const res = await fetch(`/api/sailor-links?domain=${encodeURIComponent(domain)}&name=${encodeURIComponent(name)}`);
        if (!res.ok) throw new Error('Failed to fetch links');
        const links = await res.json();

        const container = document.getElementById('link-report-list');
        
        const active = links.filter(l => l.status === 'active');
        const excluded = links.filter(l => l.status === 'excluded');

        if (!links || links.length === 0) {
            container.innerHTML = `<p style="color:var(--text-light); text-align:center; padding:2rem;">No scored links found for this page.</p>`;
        } else {
            let html = '';
            
            // 🟢 Active Links
            if (active.length > 0) {
                html += `<div style="padding: 10px; background: #064e3b; color: #34d399; font-size: 0.7rem; font-weight: 700; border-radius: 4px; margin-bottom: 10px;">✅ ACTIVE LINKS (${active.length})</div>`;
                html += active.map(link => {
                    const score = typeof link._score === 'number' ? link._score : 0;
                    const badgeClass = score >= 7 ? 'score-high' : score >= 3 ? 'score-med' : 'score-low';
                    const displayText = (link.text || '').substring(0, 60) || '—';
                    return `
                    <div class="sailor-link-row">
                        <span class="score-badge ${badgeClass}">${score.toFixed(1)}</span>
                        <div style="flex: 1; min-width: 0;">
                            <span class="sailor-link-text" title="${(link.text || '').replace(/"/g, '&quot;')}">${displayText}</span>
                            <div style="font-size: 0.65rem; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${link.href}</div>
                            ${link.reason ? `<div style="font-size: 0.65rem; color: #34d399; margin-top: 2px;">⚡ ${link.reason}</div>` : ''}
                        </div>
                        <a href="${link.href}" target="_blank" rel="noopener" class="secondary-btn" style="padding: 2px 6px; font-size: 10px;">Go</a>
                    </div>`;
                }).join('');
            }

            // 🔴 Excluded Links (Aesthetics of Transparency)
            if (excluded.length > 0) {
                html += `<div style="padding: 10px; background: #450a0a; color: #f87171; font-size: 0.7rem; font-weight: 700; border-radius: 4px; margin: 20px 0 10px 0;">🚫 EXCLUDED NOISE (${excluded.length})</div>`;
                html += excluded.slice(0, 100).map(link => {
                    const displayText = (link.text || '').substring(0, 40) || '—';
                    return `
                    <div class="sailor-link-row" style="opacity: 0.6; filter: grayscale(0.8);">
                        <span class="score-badge" style="background: #7f1d1d; color: #fecaca;">${(link._score || 0).toFixed(1)}</span>
                        <div style="flex: 1; min-width: 0;">
                            <span class="sailor-link-text" title="${(link.text || '').replace(/"/g, '&quot;')}">${displayText}</span>
                            <div style="font-size: 0.6rem; color: #f87171; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${link.href}</div>
                            <div style="font-size: 0.6rem; color: #fca5a5; margin-top: 2px;">⚠️ ${link.reason || 'Baja relevancia'}</div>
                        </div>
                        <a href="${link.href}" target="_blank" rel="noopener" class="secondary-btn" style="padding: 2px 6px; font-size: 10px; opacity: 0.8;">Go</a>
                    </div>`;
                }).join('');
                if (excluded.length > 100) {
                    html += `<p style="font-size: 0.7rem; opacity: 0.5; text-align: center; margin-top: 10px;">... and ${excluded.length - 100} more items hidden for performance.</p>`;
                }
            }
            
            container.innerHTML = html;
        }

        const modal = document.getElementById('link-report-modal');
        const header = modal.querySelector('.modal-header h3');
        if (header) header.textContent = `🏴‍☠️ Smart Sailor Audit: ${active.length} active / ${excluded.length} excluded`;
        modal.style.display = 'block';
    } catch (e) {
        alert('Could not load sailor links: ' + e.message);
    }
};

// 🧼 Modal Cleanup & Navigation
const closeSelectors = ['.close-modal', '.close-preview', '.close-report', '.close-duplicate-review'];
closeSelectors.forEach(sel => {
    const btn = document.querySelector(sel);
    if (btn) {
        btn.onclick = () => {
            batchModal.style.display = "none";
            previewModal.style.display = "none";
            linkReportModal.style.display = "none";
            duplicateReviewModal.style.display = "none";
        };
    }
});

window.onclick = (event) => {
    if (event.target === batchModal) batchModal.style.display = "none";
    if (event.target === previewModal) previewModal.style.display = "none";
    if (event.target === linkReportModal) linkReportModal.style.display = "none";
    if (event.target === duplicateReviewModal) duplicateReviewModal.style.display = "none";
};

// 🧭 Smart Navigator: always ON (enforced server-side). Depth input listener kept for UX only.
const depthInput = document.getElementById('depth');
depthInput.addEventListener('change', () => {
    // depth visual-only reactions can go here if needed
});

// 🏴‍☠️ Sailor Mode: toggle title between 'Scraper-ito' and 'Scraperito Sailor'
document.getElementById('sailorMode').addEventListener('change', function () {
    const title = document.getElementById('main-title');
    const tagline = document.getElementById('header-tagline');
    if (this.checked) {
        title.textContent = 'Scraperito Sailor';
        tagline.textContent = '🏴‍☠️ Sailor Mode · Link discovery · Scored & sorted by relevance';
    } else {
        title.textContent = 'Scraper-ito';
        tagline.textContent = 'Smart navigator · Harvests the best, skips the rest';
    }
});

// Initial Call
checkAuth();

function startAdaptivePolling() {
    if (!statusPollTimer) scheduleStatusPoll(2000);
    if (!resultsPollTimer) scheduleResultsPoll(10000);
}

function stopAdaptivePolling() {
    if (statusPollTimer) clearTimeout(statusPollTimer);
    if (resultsPollTimer) clearTimeout(resultsPollTimer);
    statusPollTimer = null;
    resultsPollTimer = null;
}

function scheduleStatusPoll(delayMs) {
    if (statusPollTimer) clearTimeout(statusPollTimer);
    statusPollTimer = setTimeout(async () => {
        const active = await updateStatus();
        const nextDelay = document.hidden ? 15000 : (active ? 2500 : 15000);
        scheduleStatusPoll(nextDelay);
    }, delayMs);
}

function scheduleResultsPoll(delayMs) {
    if (resultsPollTimer) clearTimeout(resultsPollTimer);
    resultsPollTimer = setTimeout(async () => {
        await updateResults();
        const nextDelay = document.hidden ? 120000 : (lastKnownActive ? 10000 : 60000);
        scheduleResultsPoll(nextDelay);
    }, delayMs);
}
