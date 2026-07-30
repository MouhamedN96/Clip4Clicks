/**
 * ClipForge Mobile-Use integration.
 *
 * Thin HTTP client over the Mobile-Use (github.com/minitap-ai/mobile-use) local API.
 * Mobile-Use runs on the operator's desktop/laptop where real Android phones are
 * connected via USB ADB. It reads the UI hierarchy, takes screenshots, taps,
 * swipes, types — full agent-level device control with real device fingerprints.
 *
 * The Tauri desktop app is the bridge: it runs Mobile-Use locally (localhost:8000)
 * and polls the VPS API for pending post/engagement jobs. This client talks to
 * Mobile-Use on the host where the phones are.
 *
 * Degrades gracefully: no Mobile-Use server = skip (return null), never throw.
 * Same seam pattern as seedance.js / higgsfield.js.
 *
 * Mobile-Use API shape (localhost:8000):
 *   GET    /devices            → { devices: [{ id, model, status }] }
 *   GET    /devices/:id/screenshot → { screenshot: "<base64 png>" }
 *   POST   /devices/:id/tap    → { ok: true }
 *   POST   /devices/:id/type   → { ok: true }
 *   POST   /devices/:id/swipe  → { ok: true }
 *   GET    /devices/:id/uitree → { ui: { nodes: [...] } }
 *   POST   /devices/:id/open   → { ok: true }
 *   POST   /devices/:id/agent  → { result: "...", steps: n }  (AI agent task)
 */

const MOBILEUSE_HOST = process.env.MOBILEUSE_HOST || '127.0.0.1';
const MOBILEUSE_PORT = process.env.MOBILEUSE_PORT || '8000';
const MOBILEUSE_MODEL = process.env.MOBILEUSE_MODEL || 'gpt-4o';
const MOBILEUSE_MAX_STEPS = parseInt(process.env.MOBILEUSE_MAX_STEPS) || 50;
const MOBILEUSE_TIMEOUT_MS = parseInt(process.env.MOBILEUSE_TIMEOUT_MS) || 120000;

/**
 * Whether Mobile-Use is configured (host is set). The actual server may or may
 * not be running — callers should use isAlive() to check at runtime.
 */
function isConfigured() {
    return !!MOBILEUSE_HOST;
}

/** Base URL for the Mobile-Use local API. */
function baseUrl() {
    return `http://${MOBILEUSE_HOST}:${MOBILEUSE_PORT}`;
}

/**
 * Check whether Mobile-Use is actually reachable. 200ms timeout — we only want
 * to know if the local server is up right now.
 * @returns {Promise<boolean>}
 */
async function isAlive() {
    if (!isConfigured()) return false;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${baseUrl()}/devices`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return false;
        const text = await res.text();
        const data = JSON.parse(text);
        // Verify it looks like Mobile-Use (has devices key or is an array)
        return Array.isArray(data.devices) || Array.isArray(data);
    } catch {
        return false;
    }
}

/**
 * Low-level request wrapper. Returns null on any failure (degrade never crash).
 * Callers check for null and dry-run/skip.
 */
async function api(method, path, body = null) {
    if (!isConfigured()) return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MOBILEUSE_TIMEOUT_MS);
        const res = await fetch(`${baseUrl()}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`Mobile-Use ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
            return null;
        }
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { raw: text }; }
    } catch (err) {
        console.error(`Mobile-Use ${method} ${path} error: ${err.message}`);
        return null;
    }
}

/**
 * List connected ADB devices.
 * @returns {Promise<Array<{id:string, model:string, status:string}>|null>}
 */
async function listDevices() {
    const data = await api('GET', '/devices');
    if (!data) return null;
    // Defend against non-JSON responses (e.g. another server on the port)
    if (data.raw) return null;
    const devices = data.devices || (Array.isArray(data) ? data : null);
    return Array.isArray(devices) ? devices : null;
}

/**
 * Get device status for a specific device.
 * @returns {Promise<Object|null>}
 */
async function deviceStatus(deviceId) {
    return api('GET', `/devices/${encodeURIComponent(deviceId)}/status`);
}

/**
 * Take a screenshot on a device.
 * @returns {Promise<{screenshot:string}|null>} base64-encoded PNG
 */
async function screenshot(deviceId) {
    return api('GET', `/devices/${encodeURIComponent(deviceId)}/screenshot`);
}

/**
 * Read the UI tree (accessibility hierarchy) from a device.
 * @returns {Promise<{ui:Object}|null>}
 */
async function readUiTree(deviceId) {
    return api('GET', `/devices/${encodeURIComponent(deviceId)}/uitree`);
}

/**
 * Tap on screen at coordinates.
 * @returns {Promise<{ok:boolean}|null>}
 */
async function tap(deviceId, x, y) {
    return api('POST', `/devices/${encodeURIComponent(deviceId)}/tap`, { x, y });
}

/**
 * Type text on a device (needs a text field focused first).
 * @returns {Promise<{ok:boolean}|null>}
 */
async function type(deviceId, text) {
    return api('POST', `/devices/${encodeURIComponent(deviceId)}/type`, { text });
}

/**
 * Swipe on screen.
 * @returns {Promise<{ok:boolean}|null>}
 */
async function swipe(deviceId, startX, startY, endX, endY, duration) {
    return api('POST', `/devices/${encodeURIComponent(deviceId)}/swipe`, {
        start_x: startX, start_y: startY, end_x: endX, end_y: endY, duration: duration || 300
    });
}

/**
 * Open an app by package name on a device.
 * @returns {Promise<{ok:boolean}|null>}
 */
async function openApp(deviceId, packageName) {
    return api('POST', `/devices/${encodeURIComponent(deviceId)}/open`, { package: packageName });
}

/**
 * Scroll the screen in a direction.
 * @returns {Promise<{ok:boolean}|null>}
 */
async function scroll(deviceId, direction = 'down') {
    // Swipe from center-down to center-up for a scroll-down, etc.
    const cx = 540; // typical 1080px wide → center
    if (direction === 'down') {
        return swipe(deviceId, cx, 1500, cx, 400);
    } else if (direction === 'up') {
        return swipe(deviceId, cx, 400, cx, 1500);
    } else if (direction === 'left') {
        return swipe(deviceId, 900, 960, 200, 960);
    } else if (direction === 'right') {
        return swipe(deviceId, 200, 960, 900, 960);
    }
    return null;
}

/**
 * Run an AI agent task on a device. This is the high-level Mobile-Use endpoint:
 * give it a natural-language instruction and the agent figures out taps/swipes.
 *
 * @param {string} deviceId - ADB device id
 * @param {string} instruction - Natural language task ("Open TikTok, go to profile, ...")
 * @param {Object} [opts] - { model, max_steps }
 * @returns {Promise<{result:string, steps:number}|null>}
 */
async function runAgent(deviceId, instruction, opts = {}) {
    return api('POST', `/devices/${encodeURIComponent(deviceId)}/agent`, {
        instruction,
        model: opts.model || MOBILEUSE_MODEL,
        max_steps: opts.maxSteps || opts.max_steps || MOBILEUSE_MAX_STEPS
    });
}

/**
 * Pick a device for a platform. Uses MOBILEUSE_ADB_DEVICES env (comma-separated)
 * which maps platform→device_id (e.g. "tiktok:device1,instagram:device2,youtube:device3").
 * Falls back to the first available device.
 *
 * @param {string} platform - tiktok | instagram | youtube
 * @param {Array} [devices] - pre-fetched device list (avoids extra call)
 * @returns {Promise<string|null>} device id or null if no devices
 */
async function pickDevice(platform, devices) {
    if (!devices) {
        devices = await listDevices();
    }
    if (!devices || !devices.length) return null;

    // Check explicit mapping
    const mapping = process.env.MOBILEUSE_ADB_DEVICES || '';
    if (mapping) {
        const entries = mapping.split(',').map(s => s.trim()).filter(Boolean);
        for (const entry of entries) {
            const [plat, devId] = entry.split(':').map(s => s.trim());
            if (plat && devId && plat === platform) {
                const found = devices.find(d => (d.id || d.serial) === devId);
                if (found) return found.id || found.serial;
            }
        }
    }

    // Fallback: first available device
    return devices[0].id || devices[0].serial || null;
}

module.exports = {
    isConfigured,
    isAlive,
    listDevices,
    deviceStatus,
    screenshot,
    readUiTree,
    tap,
    type,
    swipe,
    scroll,
    openApp,
    runAgent,
    pickDevice,
    baseUrl
};