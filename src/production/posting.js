/**
 * ClipForge posting producer.
 *
 * Takes an approved clip + caption + optional link → drives Mobile-Use to post
 * on a real Android device. Device selection per platform, rate-limited per
 * device for account durability.
 *
 * Golden rules enforced:
 *   #1 — only called after human approval (the approve endpoint enqueues the job)
 *   #3 — rate-limited per device, spaces out posting
 *   #4 — degrades gracefully: no Mobile-Use = dry-run, no device = skip
 *
 * The producer uses Mobile-Use's AI agent endpoint for high-level instructions
 * ("open TikTok, navigate to upload, select the video, type caption, post")
 * rather than brittle coordinate tapping. This adapts to UI changes.
 *
 * Rate limiting is in-memory per device id (min 15 min between posts per device).
 * In a multi-worker setup this should move to Redis; for the single-worker
 * default it's sufficient.
 */

const mu = require('../integration/mobileuse');

const MIN_POST_INTERVAL_MS = parseInt(process.env.POSTING_MIN_INTERVAL_MS) || 15 * 60 * 1000;

// In-memory rate-limit tracker: { deviceId: lastPostTimestamp }
const _lastPost = new Map();

/**
 * Check and update rate limit for a device. Returns true if the device is
 * allowed to post now, false if it's too soon.
 * @param {string} deviceId
 * @returns {boolean}
 */
function _checkRate(deviceId) {
    const now = Date.now();
    const last = _lastPost.get(deviceId) || 0;
    if (now - last < MIN_POST_INTERVAL_MS) return false;
    _lastPost.set(deviceId, now);
    return true;
}

/**
 * Build the AI agent instruction for posting a video to a platform.
 * Uses natural language — Mobile-Use figures out the taps.
 *
 * @param {string} platform - tiktok | instagram | youtube
 * @param {string} videoPath - local file path on the desktop (where Mobile-Use runs)
 * @param {string} caption - full caption text (may include link + UTM)
 * @returns {string} instruction
 */
function buildPostInstruction(platform, videoPath, caption) {
    const plat = String(platform).toLowerCase();
    const appPackages = {
        tiktok: 'com.zhiliaoapp.musically',
        instagram: 'com.instagram.android',
        youtube: 'com.google.android.youtube'
    };
    const pkg = appPackages[plat] || appPackages.tiktok;
    const appNames = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
    const appName = appNames[plat] || appName.tiktok;

    return [
        `Open the ${appName} app (package: ${pkg}).`,
        `If the app is not installed or not logged in, report "APP_NOT_READY".`,
        plat === 'tiktok'
            ? `Tap the "+" button at the bottom center to open the upload screen.`
            : plat === 'instagram'
            ? `Tap the "+" button at the bottom to create a new post, select "Reel" or "Post".`
            : `Tap the "+" at the bottom to create a Short, select "Upload a video".`,
        `Select the video file from the gallery at path "${videoPath}".`,
        `If the file picker opens, navigate to find the video and tap it.`,
        `On the caption screen, type exactly this caption:\n"""${caption}"""`,
        plat === 'tiktok'
            ? `Make sure "#AI" or the AI content label toggle is ON if present.`
            : '',
        plat === 'instagram'
            ? `If there's an "AI content" label toggle, turn it ON.`
            : '',
        `Do NOT tap any buttons related to "Sponsored" or "Promote".`,
        `Tap the "Post" button to publish the video.`,
        `Wait for the post to complete and confirm the video is posted.`,
        `Report "POST_OK" if successful, or describe what went wrong.`
    ].filter(Boolean).join('\n');
}

/**
 * Post a clip to a platform via Mobile-Use.
 *
 * @param {Object} p
 * @param {string} p.clipId - clip id (for logging/metadata)
 * @param {string} p.clipPath - video file path (local to the Mobile-Use desktop)
 * @param {string} p.caption - caption text
 * @param {string} p.platform - tiktok | instagram | youtube
 * @param {string} [p.deviceId] - explicit device override
 * @param {Object} [p.mobileuse] - injected Mobile-Use module (for testing)
 * @returns {Promise<{success:boolean, dryRun?:boolean, deviceId?:string, result?:Object, error?:string}>}
 */
async function postClip(p = {}) {
    const mobileuse = p.mobileuse || mu;
    const platform = String(p.platform || 'tiktok').toLowerCase();
    const clipPath = p.clipPath;
    const caption = p.caption || '';

    if (!clipPath) return { success: false, error: 'no clipPath provided' };

    // Check if Mobile-Use is alive
    const alive = await mobileuse.isAlive();
    if (!alive) {
        console.log(`[dry-run] Mobile-Use not reachable, would post ${clipPath} to ${platform}`);
        return { success: true, dryRun: true, platform, reason: 'mobileuse_not_alive' };
    }

    // Pick a device
    let deviceId = p.deviceId;
    if (!deviceId) {
        deviceId = await mobileuse.pickDevice(platform);
    }
    if (!deviceId) {
        console.log(`[skip] no device available for ${platform}`);
        return { success: false, dryRun: false, error: 'no_device_available', platform };
    }

    // Rate limit per device
    if (!_checkRate(deviceId)) {
        console.log(`[rate-limited] device ${deviceId} posted too recently, skipping ${platform}`);
        return { success: false, dryRun: false, error: 'rate_limited', deviceId, platform };
    }

    // Build instruction and run agent
    const instruction = buildPostInstruction(platform, clipPath, caption);
    console.log(`Posting clip ${p.clipId || '?'} to ${platform} on device ${deviceId}`);

    const result = await mobileuse.runAgent(deviceId, instruction, {
        maxSteps: parseInt(process.env.MOBILEUSE_MAX_STEPS) || 50
    });

    if (!result) {
        return { success: false, error: 'agent_failed_no_response', deviceId, platform };
    }

    const resultText = String(result.result || result.ok || '').toLowerCase();
    const ok = resultText.includes('post_ok') || result.success === true || result.ok === true;

    return {
        success: ok,
        deviceId,
        platform,
        result,
        steps: result.steps
    };
}

/**
 * Post a clip to multiple platforms. Iterates with per-device rate limiting.
 *
 * @param {Object} p - same as postClip but with `platforms` array
 * @param {string[]} p.platforms - ['tiktok', 'instagram', ...]
 * @returns {Promise<{results:Array, anyPosted:boolean}>}
 */
async function postToAll(p = {}) {
    const platforms = p.platforms && p.platforms.length ? p.platforms : ['tiktok'];
    const results = [];

    for (const platform of platforms) {
        // Space out posts across platforms too (account durability)
        if (results.length > 0) {
            const delay = parseInt(process.env.POSTING_PLATFORM_DELAY_MS) || 30000;
            await new Promise(r => setTimeout(r, delay));
        }

        const r = await postClip({ ...p, platform });
        results.push({ platform, ...r });
    }

    return {
        results,
        anyPosted: results.some(r => r.success)
    };
}

module.exports = {
    postClip,
    postToAll,
    buildPostInstruction,
    _checkRate
};