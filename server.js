const dotenv = require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright-extra');

// Import Modular Components
const auth = require('./lib/auth');
const missions = require('./lib/missions');
const results = require('./lib/results');
const pdf = require('./lib/pdf');
const { prepareStartUrls } = require('./lib/session');
const { startScraperWorker, stopScraperWorker, stopAllScraperWorkers } = require('./lib/session-runner');
const runtimeProfile = require('./lib/runtime-profile');
const { parseSubmittedUrlEntries, normalizeSubmittedUrlEntries } = require('./lib/url-input');
const { finalizeInterruptedMissionProgress } = require('./lib/interrupted-mission');
const { getSailorLinks, exportSailorIndex, exportSailorReport, exportSailorBatchExcel, exportSailorSingleExcel } = require('./lib/results');

console.log('\n\x1b[32m🚀 [SCRAPER-ITO MODULAR BOOT]\x1b[0m');
console.log('\x1b[2m- Loading Auth...\x1b[0m');
console.log('\x1b[2m- Loading Missions...\x1b[0m');
console.log('\x1b[2m- Loading Results...\x1b[0m');
console.log('\x1b[2m- Loading PDF Engine...\x1b[0m');
console.log('\x1b[2m- Initializing SWARM session worker...\x1b[0m');

process.on('unhandledRejection', (reason) => {
    const message = reason && reason.stack ? reason.stack : String(reason);
    console.error(`[SYSTEM] Unhandled promise rejection captured without crashing process: ${message}`);
});

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHUTDOWN_GRACE_MS = Math.max(
    3000,
    parseInt(process.env.SCRAPERITO_SHUTDOWN_GRACE_MS || '9000', 10) || 9000
);
const routeCache = new Map();
const { installManagedAgent, checkExpectedMission } = require('./lib/managed-agent');
const managedAgent = installManagedAgent(app, {
    dataDir: DATA_DIR, port: PORT, root: __dirname,
    getContext: missions.getUserContext, stopWorker: stopScraperWorker,
    shutdown: signal => gracefulShutdown(signal)
});

function compactProgress(progress = {}) {
    const details = Array.isArray(progress.details) ? progress.details : [];
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    for (const detail of details) {
        if (!detail || detail.status === 'pending') continue;
        completed++;
        if (detail.status === 'failed') failed++;
        if (detail.status === 'skipped') skipped++;
    }
    return {
        total: Number(progress.total || 0),
        successful: Number(progress.successful || 0),
        deduplicated: Number(progress.deduplicated || 0),
        completed,
        failed,
        skipped,
        detailsCount: details.length
    };
}

function getCacheKey(userId, name) {
    return `${userId}:${name}`;
}

function invalidateUserCache(userId) {
    for (const key of routeCache.keys()) {
        if (key.startsWith(`${userId}:`)) routeCache.delete(key);
    }
}

async function getCachedUserPayload(userId, name, ttlMs, loader, revision = null) {
    const key = getCacheKey(userId, name);
    const now = Date.now();
    const cached = routeCache.get(key);
    if (cached && cached.expiresAt > now && cached.revision === revision) return cached.payload;

    const payload = await loader();
    routeCache.set(key, {
        expiresAt: now + ttlMs,
        payload,
        revision
    });
    return payload;
}

// 🛡️ v16.12: Security & Deployment Resiliency
const isConfigured = !!process.env.SCRAPER_PASSWORD || process.env.NODE_ENV !== 'production';
const LOCAL_AUTH_BYPASS = process.env.NODE_ENV !== 'production' && process.env.SCRAPERITO_LOCAL_AUTH_BYPASS !== 'false';
let localAuthBypassLogged = false;

// Healthcheck (Top-level to pass Railway deploy logs)
app.get('/health', (req, res) => res.status(200).send('OK'));

// ⚡ v16.13: Fast Boot Pattern — Bind port IMMEDIATELY before heavy requires
const server = app.listen(PORT, managedAgent.enabled ? '127.0.0.1' : undefined, () => {
    console.log(`\n⛵ [SCRAPERITO SAILOR] Server successfully bound to port ${PORT}`);
    console.log(`🧭 Deployment Healthcheck: ACTIVE`);
});

let shutdownInProgress = false;
async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    console.warn(`[SYSTEM] ${signal} received. Closing active browser sessions before shutdown...`);
    const forceExitTimer = setTimeout(() => {
        console.warn('[SYSTEM] Graceful shutdown timeout reached. Exiting now.');
        process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    try {
        stopAllScraperWorkers(signal);
        await missions.shutdownAllActiveContexts(signal);
    } catch (err) {
        console.error(`[SYSTEM] Shutdown cleanup failed: ${err.message}`);
    }

    server.close(() => {
        console.log('[SYSTEM] HTTP server closed cleanly.');
        process.exit(0);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Lockdown Middleware (Blocks everything if SCRAPER_PASSWORD is missing in production)
app.use((req, res, next) => {
    if (!isConfigured && req.path !== '/health') {
        return res.status(503).send(`
            <body style="background:#0f172a; color:#f8fafc; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center;">
                <div style="background: #1e293b; padding:2rem; border-radius:1rem; border:1px solid #ef4444; max-width:400px;">
                    <h1 style="color:#ef4444;">🔒 Setup Required</h1>
                    <p>SCRAPER_PASSWORD environment variable is missing in production.</p>
                    <p style="font-size:0.8rem; opacity:0.6;">Please set it in your Railway dashboard to unlock the system.</p>
                </div>
            </body>
        `);
    }
    next();
});

// 🕵️ High-Visibility Terminal Messenger (v16.34 - Top of Stack)
app.use((req, res, next) => {
    const noisyPolling = ['/api/session', '/api/status', '/api/heartbeat', '/api/missions', '/api/results', '/api/admin/active-users', '/api/view'];
    const path = req.url.split('?')[0];

    if (req.url.startsWith('/api/') && !noisyPolling.includes(path)) {
        const time = new Date().toLocaleTimeString();
        console.log(`\n\x1b[35m[API]\x1b[0m ${req.method} ${req.url} (${time})`);
        if (req.method === 'POST') console.log(' \x1b[2m> Executing User Action...\x1b[0m');
    }
    next();
});

// Fast public assets: keep JS/CSS/images off session-file-store and Railway session I/O.
// Pages and APIs still go through the normal middleware below.
const FAST_PUBLIC_ASSETS = new Set([
    'app.js',
    'style.css',
    'favicon.png',
    'elmo-logo.png',
    'elmo-logo.jpg',
    'success-elmo.gif',
    'pdf.min.js',
    'pdf.worker.min.js'
]);

app.get('/:assetName', (req, res, next) => {
    const { assetName } = req.params;
    if (!FAST_PUBLIC_ASSETS.has(assetName)) return next();

    const headers = {};
    if (/\.(js|css)$/i.test(assetName)) {
        headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else {
        headers['Cache-Control'] = 'public, max-age=14400';
    }

    res.sendFile(path.join(PUBLIC_DIR, assetName), { headers }, (err) => {
        if (err) next(err);
    });
});

// Middleware & Configuration
// A batch submits its original URL text once. This remains bounded so malformed
// requests cannot consume unbounded memory before authentication/validation.
app.use(express.json({ limit: runtimeProfile.requestBodyLimitBytes }));
app.use(cookieParser());

// Ensure data folders exist (Fixes global ENOENT)
fs.ensureDirSync(path.join(DATA_DIR, 'scrapes'));
fs.ensureDirSync(path.join(DATA_DIR, 'missions'));
fs.ensureDirSync(path.join(DATA_DIR, 'sessions'));

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// 🔄 Auto-Migration: 'admin' -> 'Edcl87' (v16.42)
(async () => {
    const oldScrapes = path.join(DATA_DIR, 'scrapes', 'admin');
    const newScrapes = path.join(DATA_DIR, 'scrapes', 'Edcl87');
    const oldMissions = path.join(DATA_DIR, 'missions', 'admin');
    const newMissions = path.join(DATA_DIR, 'missions', 'Edcl87');

    try {
        if (await fs.pathExists(oldScrapes) && !(await fs.pathExists(newScrapes))) {
            await fs.move(oldScrapes, newScrapes);
            console.log('📦 Migrated admin scrapes to Edcl87');
        }
        if (await fs.pathExists(oldMissions) && !(await fs.pathExists(newMissions))) {
            await fs.move(oldMissions, newMissions);
            console.log('📦 Migrated admin missions to Edcl87');
        }
    } catch (e) { console.error('Migration failed:', e); }
})();

app.use(session({
    store: new FileStore({
        path: SESSIONS_DIR,
        retries: 1,
        factor: 1,
        minTimeout: 50,
        maxTimeout: 150,
        reapInterval: 3600,
        logFn: () => { }      // ⛵ Sailor: suppress session-file-store retry noise
    }),
    secret: process.env.SESSION_SECRET || 'scraperito-sailor-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
    if (LOCAL_AUTH_BYPASS && !req.session?.user) {
        req.session.user = { id: 'Edcl87', username: 'Edcl87', localBypass: true };
        if (!localAuthBypassLogged) {
            localAuthBypassLogged = true;
            console.log('[AUTH] Local auth bypass active: auto-login as Edcl87');
        }
    }
    next();
});

app.get('/admin.html', (req, res, next) => {
    if (req.session?.user?.id === 'Edcl87') {
        return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
    }
    return res.redirect('/');
});

app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
        if (/\.(html|js|css)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// Auth Logic routes proceed...

// ──────────────────────────────────────────────────────────
// API Routes: Authentication
// ──────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (!auth.checkLoginRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
    }

    // 👑 Admin Fallback (v16.36 - Identity Update)
    const adminPass = process.env.SCRAPER_PASSWORD || 'admin123';
    if (username === 'Edcl87' && password === adminPass) {
        req.session.user = { id: 'Edcl87', username: 'Edcl87' };
        console.log(`\x1b[32m[AUTH] Admin access granted (Edcl87)\x1b[0m`);
        return res.json({ success: true, user: req.session.user });
    }

    const users = await auth.loadUsers();
    const user = users.find(u => u.username === username);

    if (user && await bcrypt.compare(password, user.passwordHash)) {
        req.session.user = { id: user.id, username: user.username };
        console.log(`[AUTH] User logged in: ${username}`);
        res.json({ success: true, user: req.session.user });
    } else {
        console.warn(`\x1b[31m[AUTH] Failed login attempt for: ${username}\x1b[0m`);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/session', (req, res) => {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Auth required' });

    const ctx = missions.getUserContext(user.id);
    res.json({
        user,
        active: ctx.sessionActive,
        missionId: ctx.currentMissionId || null
    });
});

app.post('/api/heartbeat', auth.authMiddleware, (req, res) => {
    const { scraping } = req.body;
    const userId = req.session.user.id;
    auth.trackHeartbeat(userId, req.session.user.username, scraping);
    res.json({ ok: true });
});

// v16.74 (M3): Debounced heartbeat persistence — flush lastSeen to disk every 5 min instead of every 30s
setInterval(async () => {
    try {
        const activeUsers = auth.getActiveUsers();
        if (activeUsers.length === 0) return;
        const users = await auth.loadUsers();
        let dirty = false;
        for (const active of activeUsers) {
            const user = users.find(u => u.id === active.id);
            if (user) { user.lastSeen = new Date().toISOString(); dirty = true; }
        }
        if (dirty) await auth.saveUsers(users);
    } catch (e) {
        console.error('[AUTH] Heartbeat flush failed:', e);
    }
}, 5 * 60 * 1000);

// ──────────────────────────────────────────────────────────
// API Routes: Admin (Protected)
// ──────────────────────────────────────────────────────────

app.get('/api/admin/users', auth.authMiddleware, auth.adminOnly, async (req, res) => {
    const users = await auth.loadUsers();
    res.json(users.map(u => ({ id: u.id, username: u.username, createdAt: u.createdAt, lastSeen: u.lastSeen })));
});

app.post('/api/admin/users', auth.authMiddleware, auth.adminOnly, async (req, res) => {
    const { username, password } = req.body;
    const users = await auth.loadUsers();
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'User already exists' });

    const newUser = {
        id: Date.now().toString(),
        username,
        passwordHash: await bcrypt.hash(password, 10),
        createdAt: new Date().toISOString()
    };
    users.push(newUser);
    await auth.saveUsers(users);
    res.json({ success: true, user: { id: newUser.id, username: newUser.username } });
});

app.delete('/api/admin/users/:id', auth.authMiddleware, auth.adminOnly, async (req, res) => {
    let users = await auth.loadUsers();
    users = users.filter(u => u.id !== req.params.id);
    await auth.saveUsers(users);
    res.json({ success: true });
});

app.get('/api/admin/active-users', auth.authMiddleware, auth.adminOnly, (req, res) => {
    res.json(auth.getActiveUsers());
});

// ──────────────────────────────────────────────────────────
// API Routes: Scraper Control
// ──────────────────────────────────────────────────────────

app.use('/api', auth.authMiddleware);

app.post('/api/scrape', managedAgent.beforeScrape, async (req, res) => {
    const userId = req.session.user.id;
    const ctx = missions.getUserContext(userId);
    if (ctx.sessionActive) return res.status(400).json({ error: 'Session already active' });

    const { urls = [], rawUrls = null, depth = 0, maxPages = 10, stayOnDomain = true, delayMs = 0, concurrency = runtimeProfile.swarmDefaultConcurrency, bodyOnly = false, excludeNoise = true, smartNav = true, sailorMode = false, pdfMetadata = true } = req.body;
    const submittedEntries = typeof rawUrls === 'string'
        ? parseSubmittedUrlEntries(rawUrls)
        : normalizeSubmittedUrlEntries(urls);
    const submittedUrls = submittedEntries.map(entry => entry.url).filter(Boolean);
    const inputAudit = {
        submitted: submittedEntries.length,
        navigable: submittedUrls.length,
        invalid: submittedEntries.length - submittedUrls.length
    };

    // 🧭 Smart Navigator is mandatory when crawling beyond the seed page (depth ≥ 1).
    // Without it, the queue fills with noise pages first and wastes the page budget.
    const effectiveSmartNav = parseInt(depth) >= 1 ? true : smartNav !== false;

    if (submittedUrls.length === 0) {
        return res.status(400).json({
            error: `No navigable HTTP URL was found. ${inputAudit.submitted} submitted row(s) were retained for audit but are invalid.`,
            inputAudit
        });
    }

    ctx.sessionActive = true;
    ctx.stopRequested = false;
    ctx.currentMissionId = `mission_${Date.now()}`;
    ctx.pdfMetadataEnabled = pdfMetadata !== false;
    ctx.missionLogs = [];
    const initialInput = prepareStartUrls(submittedEntries);
    ctx.linkProgress = {
        total: initialInput.submittedUrls.length,
        successful: 0,
        deduplicated: 0,
        details: initialInput.details,
        timestamp: new Date().toISOString(),
        missionId: ctx.currentMissionId
    };
    invalidateUserCache(userId);

    missions.addMissionLog(userId, `Starting new mission: ${ctx.currentMissionId}`, 'system');
    missions.addMissionLog(
        userId,
        `Input audit: ${inputAudit.submitted} submitted row(s) retained; ${inputAudit.navigable} navigable; ${inputAudit.invalid} invalid or unrecognised.`,
        inputAudit.invalid > 0 ? 'warn' : 'info'
    );

    // v16.81: Depth Lock — hard cap at 1 to prevent runaway crawls
    const clampedDepth = Math.min(parseInt(depth) || 0, 1);

    const applyWorkerProgress = progress => {
        if (!progress || progress.missionId !== ctx.currentMissionId) return;
        if (progress.progress && ['snapshot', 'complete'].includes(progress.kind)) {
            ctx.linkProgress = progress.progress;
            return;
        }

        const detail = progress.detail;
        if (!detail) return;
        const current = ctx.linkProgress || { details: [] };
        current.total = Number(progress.total || current.total || 0);
        current.successful = Number(progress.successful || 0);
        current.deduplicated = Number(progress.deduplicated || 0);
        if (!Array.isArray(current.details)) current.details = [];
        const index = Number.isInteger(detail.inputIndex)
            ? current.details.findIndex(item => item.inputIndex === detail.inputIndex)
            : current.details.findIndex(item => String(item.url || '').trim() === String(detail.url || '').trim());
        if (index >= 0) current.details[index] = detail;
        else current.details.push(detail);
        ctx.linkProgress = current;
    };

    const persistInterruptedMission = async (missionId, progress, reason) => {
        const snapshot = progress?.missionId === missionId
            ? progress
            : ctx.linkProgress?.missionId === missionId
                ? ctx.linkProgress
                : null;
        if (!snapshot) {
            missions.addMissionLog(userId, `Could not persist an interrupted mission snapshot for ${missionId}; no matching progress snapshot was available.`, 'error');
            return;
        }

        const { finalized } = finalizeInterruptedMissionProgress(snapshot, reason);
        ctx.linkProgress = snapshot;
        await missions.saveMissionManifest(userId, missionId, snapshot);
        invalidateUserCache(userId);
        missions.addMissionLog(userId, `Interrupted mission snapshot saved: ${snapshot.details?.length || 0}/${snapshot.total || 0} input row(s) retained; ${finalized} unfinished row(s) marked as interrupted.`, 'warn');
    };

    try {
        startScraperWorker({
            userId,
            startUrls: submittedEntries,
            maxDepth: clampedDepth,
            globalMaxPages: parseInt(maxPages) || 10,
            stayOnDomain,
            missionId: ctx.currentMissionId,
            delayMs: parseInt(delayMs) || 0,
            concurrency: parseInt(concurrency) || runtimeProfile.swarmDefaultConcurrency,
            bodyOnly,
            excludeNoise,
            smartNav: effectiveSmartNav,
            sailorMode: sailorMode === true,
            pdfMetadata: ctx.pdfMetadataEnabled
        }, {
            onMissionEvent(event) {
                if (!event || event.userId !== userId) return;
                if (event.type === 'log') missions.addRemoteMissionLog(userId, event.log);
                if (event.type === 'results-changed') missions.markResultsChanged(userId);
            },
            onProgress: applyWorkerProgress,
            onComplete(progress) {
                if (progress) ctx.linkProgress = progress;
                ctx.sessionActive = false;
                invalidateUserCache(userId);
            },
            onFatal(error, failedMissionId, progress) {
                missions.addMissionLog(userId, `Fatal worker error: ${error}`, 'error');
                ctx.sessionActive = false;
                const missionId = failedMissionId || ctx.currentMissionId;
                if (missionId) {
                    const reason = 'Worker process failed before this URL was processed.';
                    persistInterruptedMission(missionId, progress, reason).catch(err => {
                        missions.addMissionLog(userId, `Failed to persist interrupted mission ${missionId}: ${err.message}`, 'error');
                    });
                }
                invalidateUserCache(userId);
            },
            onUnexpectedExit(code, signal, wasStopped, failedMissionId) {
                if (!ctx.sessionActive) return;
                const outcome = wasStopped ? 'after the stop request' : 'unexpectedly';
                missions.addMissionLog(userId, `Scraper worker exited ${outcome} (code ${code ?? 'none'}, signal ${signal || 'none'}).`, 'error');
                ctx.sessionActive = false;
                const missionId = failedMissionId || ctx.currentMissionId;
                if (missionId) {
                    const reason = wasStopped
                        ? 'Mission stopped before this URL was processed.'
                        : 'Worker process exited unexpectedly before this URL was processed.';
                    persistInterruptedMission(missionId, null, reason).catch(err => {
                        missions.addMissionLog(userId, `Failed to persist interrupted mission ${missionId}: ${err.message}`, 'error');
                    });
                }
                invalidateUserCache(userId);
            }
        });
    } catch (err) {
        ctx.sessionActive = false;
        return res.status(500).json({ error: `Could not start scraper worker: ${err.message}` });
    }

    // Return the initial logs so the UI can render the launch immediately.
    res.json({
        message: 'Started',
        missionId: ctx.currentMissionId,
        logs: ctx.missionLogs,
        progress: ctx.linkProgress,
        resultsRevision: ctx.resultsRevision,
        inputAudit
    });
});

app.post('/api/stop', (req, res) => {
    const userId = req.session.user.id;
    const ctx = missions.getUserContext(userId);
    if (!checkExpectedMission(req, res, ctx)) return;
    ctx.stopRequested = true;
    missions.addMissionLog(userId, 'Stop signal received. Aborting...', 'error');
    stopScraperWorker(userId, 'stop request from the user');
    res.json({ message: 'Stop requested' });
});

app.get('/api/status', (req, res) => {
    // 🛡️ Safety: Verify user session exists before accessing context
    const userId = req.session?.user?.id;
    if (!userId) {
        console.warn('[STATUS] Unauthenticated status request');
        return res.status(401).json({ error: 'Auth required' });
    }

    const ctx = missions.getUserContext(userId);
    if (req.query.clear === 'true' && !ctx.sessionActive) {
        ctx.missionLogs = [];
    }
    res.json({
        active: ctx.sessionActive,
        logs: ctx.missionLogs,
        missionId: ctx.currentMissionId,
        user: req.session.user,
        // The normal live feed does not need every per-link record every 2.5s.
        // Full detail remains available to explicit API consumers.
        progress: req.query.compact === 'true' ? compactProgress(ctx.linkProgress) : ctx.linkProgress,
        resultsRevision: ctx.resultsRevision
    });
});

app.get('/api/missions', async (req, res) => {
    const userId = req.session.user.id;
    const ctx = missions.getUserContext(userId);
    const ttlMs = ctx.sessionActive ? 10000 : 30000;
    res.json(await getCachedUserPayload(userId, 'missions', ttlMs, () => missions.listMissions(userId)));
});

app.get('/api/missions/:id', async (req, res) => {
    const manifest = await missions.getMissionManifest(req.session.user.id, req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Mission not found' });
    res.json(manifest);
});

// 🏴‍☠️ Sailor Mode: Return scored link list for a single result
app.get('/api/sailor-links', async (req, res) => {
    const userId = req.session.user.id;
    const { domain, name } = req.query;
    if (!domain || !name || /(\.\.|[\/\\])/.test(domain) || /(\.\.|[\/\\])/.test(name)) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }
    const links = await getSailorLinks(userId, domain, name);
    res.json(links);
});

// 🏴‍☠️ Sailor Mode: Export full aggregated link index for a whole mission batch
app.get('/api/export-sailor-index', async (req, res) => {
    const userId = req.session.user.id;
    const { batchId } = req.query;
    if (!batchId) return res.status(400).json({ error: 'batchId required' });
    const output = await exportSailorIndex(userId, batchId);
    if (!output) return res.status(404).send('No sailor links found for this mission');
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="sailor_index_${batchId}.txt"`);
    res.send(output);
});

// 🏴‍☠️ Sailor Mode: Full grouped report per source page (lvl 0 + lvl 1 separate)
app.get('/api/export-sailor-report', async (req, res) => {
    const userId = req.session.user.id;
    const { batchId } = req.query;
    if (!batchId) return res.status(400).json({ error: 'batchId required' });
    const output = await exportSailorReport(userId, batchId);
    if (!output) return res.status(404).send('No sailor report data found for this mission');
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="sailor_report_${batchId}.txt"`);
    res.send(output);
});

// 🏴‍☠️ Sailor Mode: Export everything to Excel (Macro)
app.get('/api/export-sailor-batch-excel', async (req, res) => {
    const userId = req.session.user.id;
    const { batchId } = req.query;
    if (!batchId) return res.status(400).json({ error: 'batchId required' });
    const buffer = await exportSailorBatchExcel(userId, batchId);
    if (!buffer) return res.status(404).send('No data found for this mission');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sailor_batch_${batchId}.xlsx"`);
    res.send(buffer);
});

// 🏴‍☠️ Sailor Mode: Export single page to Excel (Micro)
app.get('/api/export-sailor-single-excel', async (req, res) => {
    const userId = req.session.user.id;
    const { domain, name } = req.query;
    if (!domain || !name) return res.status(400).json({ error: 'domain and name required' });
    const buffer = await exportSailorSingleExcel(userId, domain, name);
    if (!buffer) return res.status(404).send('No links found for this page');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sailor_links_${name}.xlsx"`);
    res.send(buffer);
});

app.delete('/api/missions/:id', async (req, res) => {
    try {
        await missions.deleteMission(req.session.user.id, req.params.id);
        invalidateUserCache(req.session.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Deletion failed' });
    }
});

// ──────────────────────────────────────────────────────────
// API Routes: Results & Export
// ──────────────────────────────────────────────────────────

app.get('/api/results', async (req, res) => {
    const userId = req.session.user.id;
    const ctx = missions.getUserContext(userId);
    const ttlMs = ctx.sessionActive ? 10000 : 30000;
    res.json(await getCachedUserPayload(userId, 'results', ttlMs, () => results.getResults(userId), ctx.resultsRevision));
});

app.get('/api/view', async (req, res) => {
    const userId = req.session.user.id;
    const { domain, name, type } = req.query;
    if (!domain || !name || !['md', 'txt', 'pdf', 'json'].includes(type) || /(\.\.|[/\\])/.test(domain) || /(\.\.|[/\\])/.test(name)) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }
    const filePath = path.join(results.SCRAPES_DIR, userId, domain, `${name}.${type}`);

    // Security: Ensure the resolved path is still within SCRAPES_DIR
    const normalizedScrapes = path.resolve(results.SCRAPES_DIR);
    const normalizedTarget = path.resolve(filePath);

    if (!normalizedTarget.startsWith(normalizedScrapes)) {
        console.warn(`[VIEW] Blocked path traversal attempt: ${normalizedTarget}`);
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        if (await fs.pathExists(filePath)) {
            if (type === 'pdf') res.setHeader('Content-Type', 'application/pdf');
            else res.setHeader('Content-Type', `text/${type === 'md' ? 'markdown' : type === 'json' ? 'json' : 'plain'}; charset=UTF-8`);

            if (req.headers['accept'] && req.headers['accept'].includes('text/html')) {
                res.download(filePath, `${name}.${type}`);
            } else {
                res.sendFile(filePath);
            }
        } else {
            console.error(`[VIEW] File not found: ${filePath}`);
            res.status(404).json({ error: 'Not found' });
        }
    } catch (e) {
        console.error(`[VIEW] Server error for ${filePath}:`, e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/export', async (req, res) => {
    const { batchId, type } = req.query;
    const { output, count, contentType, extension } = await results.exportToText(req.session.user.id, batchId, type);
    if (count === 0) return res.status(404).send('No files found');
    res.setHeader('Content-Type', contentType || 'text/plain; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="mission_${batchId}_${type === 'index' ? 'index' : 'export'}.${extension || (type === 'index' ? 'txt' : type)}"`);
    res.send(output);
});

app.get('/api/export-zip', async (req, res) => {
    const { batchId, type = 'pdf', layout = 'domain' } = req.query;
    const safeLayout = layout === 'flat' ? 'flat' : 'domain';
    const { zip, filesAdded, filesSkipped, missingFiles = [] } = await results.exportToZip(req.session.user.id, batchId, type, { layout: safeLayout });
    if (filesAdded === 0) return res.status(404).send('No files found');
    if (type === 'pdf' && filesSkipped > 0) {
        return res.status(409).json({
            error: 'PDF batch is incomplete',
            message: 'Refusing to download a partial PDF ZIP. Review the batch Index or Detailed Link Report for the missing artifacts.',
            filesAdded,
            filesSkipped,
            missingFiles
        });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="mission_${batchId}_${type}${safeLayout === 'flat' ? '_flat' : ''}.zip"`);
    res.send(zip.toBuffer());
});

// Curated output is a separate ZIP. It applies explicit review decisions only and
// never changes the original mission artifacts or its regular batch downloads.
app.get('/api/export-curated-zip', async (req, res) => {
    const { batchId, type = 'pdf', layout = 'flat' } = req.query;
    if (!batchId || !['pdf', 'md', 'txt'].includes(type)) return res.status(400).json({ error: 'Invalid export request' });
    const safeLayout = layout === 'domain' ? 'domain' : 'flat';
    try {
        const { zip, filesAdded, filesSkipped, missingFiles = [], excludedByReview } = await results.exportCuratedZip(
            req.session.user.id,
            batchId,
            type,
            { layout: safeLayout }
        );
        if (filesAdded === 0) return res.status(404).send('No curated files found');
        if (type === 'pdf' && filesSkipped > 0) {
            return res.status(409).json({
                error: 'Curated PDF ZIP is incomplete',
                filesAdded,
                filesSkipped,
                missingFiles
            });
        }
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="mission_${batchId}_curated_${type}${safeLayout === 'flat' ? '_flat' : ''}.zip"`);
        res.setHeader('X-Scraperito-Excluded-By-Review', String(excludedByReview));
        res.send(zip.toBuffer());
    } catch (err) {
        res.status(400).json({ error: err.message || 'Curated ZIP creation failed' });
    }
});

function selectedMissionIds(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    return values.map(item => String(item || '').trim()).filter(Boolean);
}

app.get('/api/export-combined-index', async (req, res) => {
    try {
        const exported = await results.exportCombinedExcelIndex(
            req.session.user.id,
            selectedMissionIds(req.query.missionIds)
        );
        if (!exported || exported.count === 0) return res.status(404).send('No combined mission rows found');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="combined_${exported.reviewId}_index.xlsx"`);
        res.send(exported.output);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Combined Excel creation failed' });
    }
});

app.get('/api/export-combined-curated-zip', async (req, res) => {
    try {
        const exported = await results.exportCombinedCuratedZip(
            req.session.user.id,
            selectedMissionIds(req.query.missionIds)
        );
        if (exported.filesSkipped > 0) {
            return res.status(409).json({
                error: 'Combined curated PDF ZIP is incomplete',
                message: 'Refusing to download a partial combined ZIP. The combined Excel identifies every missing PDF artifact.',
                filesAdded: exported.filesAdded,
                filesSkipped: exported.filesSkipped,
                missingFiles: exported.missingFiles
            });
        }
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="combined_${exported.reviewId}_curated_pdfs_flat.zip"`);
        res.setHeader('X-Scraperito-Excluded-By-Review', String(exported.excludedByReview));
        res.setHeader('X-Scraperito-Combined-Index', exported.indexName);
        res.send(exported.zip.toBuffer());
    } catch (err) {
        res.status(400).json({ error: err.message || 'Combined curated ZIP creation failed' });
    }
});

app.get('/api/curation/duplicates', async (req, res) => {
    const { batchId } = req.query;
    const review = await results.getDuplicateReviewCandidates(req.session.user.id, batchId);
    if (!review) return res.status(400).json({ error: 'Invalid mission id' });
    res.json(review);
});

app.get('/api/curation/combined', async (req, res) => {
    try {
        const review = await results.getCombinedReviewCandidates(
            req.session.user.id,
            selectedMissionIds(req.query.missionIds)
        );
        res.json(review);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Unable to load combined review' });
    }
});

app.post('/api/curation/duplicates/decision', async (req, res) => {
    const { batchId, groupId, action, url, sourceId } = req.body || {};
    try {
        const review = await results.saveDuplicateReviewDecision(req.session.user.id, batchId, groupId, action, url, sourceId);
        res.json(review);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Unable to save review decision' });
    }
});

app.post('/api/curation/duplicates/decisions', async (req, res) => {
    const { batchId, changes } = req.body || {};
    try {
        const review = await results.saveDuplicateReviewDecisions(req.session.user.id, batchId, changes);
        res.json(review);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Unable to apply review changes' });
    }
});

app.post('/api/curation/combined/decisions', async (req, res) => {
    const { missionIds, changes } = req.body || {};
    try {
        const review = await results.saveCombinedReviewDecisions(
            req.session.user.id,
            selectedMissionIds(missionIds),
            changes
        );
        res.json(review);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Unable to apply combined review changes' });
    }
});

// Server already listening via Fast Boot (line 37)
console.log(`🧭 Smart Navigator: Tier 1 Heuristic Scorer — ACTIVE`);
console.log(`📂 Data directory: ${DATA_DIR}\n`);
