/**
 * ClipForge engagement producer.
 *
 * Scans comments on posted clips via Mobile-Use, extracts comment text + usernames,
 * keyword-matches for buying-intent, proposes replies + DMs, and routes them through
 * the human review gate (Telegram). On approval, Mobile-Use executes the reply/DM.
 *
 * Golden rules:
 *   #1 — nothing replies or DMs without human approval
 *   #3 — rate-limited: MAX_DMS_PER_ACCOUNT_PER_DAY (default 5), MIN_DELAY_BETWEEN_DMS (300s)
 *   #4 — degrades gracefully: no Mobile-Use = skip, never crash
 *   #2 — AI content disclosed in the reply text
 *
 * Flow:
 *   scanComments(deviceId, platform) → [{ username, text, commentId }]
 *   → matchKeywords(comments, keywords) → [{ username, text, commentId, matchedKeyword }]
 *   → proposeReply(comment) → { replyText }
 *   → proposeDM(comment) → { dmText, link }
 *   → human gate (stored as pending engagement action)
 *   → on approve: executeReply / executeDM via Mobile-Use
 */

const mu = require('../integration/mobileuse');

const KEYWORDS = (process.env.ENGAGEMENT_KEYWORDS || 'link,price,order,buy,how much,where,store,shop,deal,discount,coupon')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const MAX_DMS_PER_DAY = parseInt(process.env.ENGAGEMENT_MAX_DMS_PER_DAY) || 5;
const MIN_DELAY_BETWEEN_DMS_MS = (parseInt(process.env.MIN_DELAY_BETWEEN_DMS_SECONDS) || 300) * 1000;

// In-memory DM rate tracking: { [deviceId]: { count: n, windowStart: ts, lastDM: ts } }
const _dmTracker = {};

/**
 * Check and enforce DM rate limits per device.
 * @param {string} deviceId
 * @returns {{allowed:boolean, reason?:string}}
 */
function _checkDmRate(deviceId) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    if (!_dmTracker[deviceId]) {
        _dmTracker[deviceId] = { count: 0, windowStart: now, lastDM: 0 };
    }
    const tracker = _dmTracker[deviceId];

    // Reset daily window
    if (now - tracker.windowStart > dayMs) {
        tracker.count = 0;
        tracker.windowStart = now;
    }

    // Check daily cap
    if (tracker.count >= MAX_DMS_PER_DAY) {
        return { allowed: false, reason: `daily_limit_${MAX_DMS_PER_DAY}` };
    }

    // Check minimum delay
    if (now - tracker.lastDM < MIN_DELAY_BETWEEN_DMS_MS) {
        return { allowed: false, reason: 'cooldown' };
    }

    return { allowed: true };
}

/**
 * Record a DM send for rate-limit tracking.
 * @param {string} deviceId
 */
function _recordDm(deviceId) {
    const now = Date.now();
    if (!_dmTracker[deviceId]) {
        _dmTracker[deviceId] = { count: 0, windowStart: now, lastDM: 0 };
    }
    _dmTracker[deviceId].count++;
    _dmTracker[deviceId].lastDM = now;
}

/**
 * Scan comments on a posted clip. Uses Mobile-Use's AI agent to read the comment
 * section and extract structured comment data.
 *
 * @param {Object} p
 * @param {string} p.deviceId - ADB device id
 * @param {string} p.platform - tiktok | instagram | youtube
 * @param {string} [p.clipUrl] - URL to the posted clip (to navigate to)
 * @param {Object} [p.mobileuse] - injected module for testing
 * @returns {Promise<Array<{username:string, text:string, commentId:string}>|null>}
 */
async function scanComments(p = {}) {
    const mobileuse = p.mobileuse || mu;
    const platform = String(p.platform || 'tiktok').toLowerCase();
    const deviceId = p.deviceId;

    if (!deviceId) return null;

    const alive = await mobileuse.isAlive();
    if (!alive) {
        console.log(`[dry-run] Mobile-Use not reachable, cannot scan comments`);
        return null;
    }

    const appPackages = {
        tiktok: 'com.zhiliaoapp.musically',
        instagram: 'com.instagram.android',
        youtube: 'com.google.android.youtube'
    };
    const pkg = appPackages[platform] || appPackages.tiktok;
    const appNames = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
    const appName = appNames[platform] || appNames.tiktok;

    const navTo = p.clipUrl
        ? `Navigate to this video: ${p.clipUrl}`
        : `Go to your own profile, tap the most recent post, then open the comments.`;

    const instruction = [
        `Open the ${appName} app (package: ${pkg}).`,
        navTo,
        `Tap the comment icon to open the comment section.`,
        `Read ALL visible comments.`,
        `Scroll down to load more comments and read those too (scroll at most 5 times).`,
        `For each comment, extract: the username (without @), the comment text, and a short comment ID.`,
        `Return the results as a JSON array, each object with keys: "username", "text", "commentId".`,
        `Return ONLY the JSON array, nothing else. If no comments, return [].`
    ].join('\n');

    const result = await mobileuse.runAgent(deviceId, instruction, {
        maxSteps: parseInt(process.env.MOBILEUSE_MAX_STEPS) || 50
    });

    if (!result) return null;

    // Try to parse the AI agent's JSON response
    const raw = String(result.result || result.ok || '');
    let comments = [];
    try {
        // The agent might wrap JSON in text, try to extract it
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            comments = JSON.parse(jsonMatch[0]);
        } else if (raw.trim().startsWith('{')) {
            // Single comment as object
            comments = [JSON.parse(raw.trim())];
        }
    } catch (err) {
        console.error(`Engagement: failed to parse comments JSON: ${err.message}`);
        console.error(`Raw response: ${raw.slice(0, 200)}`);
        return [];
    }

    if (!Array.isArray(comments)) return [];

    // Normalize
    return comments.map((c, i) => ({
        username: String(c.username || c.user || ''),
        text: String(c.text || c.comment || c.content || ''),
        commentId: String(c.commentId || c.comment_id || c.id || `c${i}`)
    })).filter(c => c.username && c.text);
}

/**
 * Match comments against buying-intent keywords.
 *
 * @param {Array<{username:string, text:string, commentId:string}>} comments
 * @param {string[]} [keywords] - override from env default
 * @returns {Array<{username:string, text:string, commentId:string, matchedKeyword:string}>}
 */
function matchKeywords(comments, keywords) {
    const kws = keywords || KEYWORDS;
    if (!kws.length) return [];

    return comments
        .map(c => {
            const lower = c.text.toLowerCase();
            const match = kws.find(kw => lower.includes(kw));
            return match ? { ...c, matchedKeyword: match } : null;
        })
        .filter(Boolean);
}

/**
 * Propose a reply to a comment. This is the text the AI suggests posting as a
 * public reply — it includes AI disclosure.
 *
 * @param {Object} comment - { username, text, matchedKeyword }
 * @param {Object} [opts] - { link } optional tracked link to include
 * @returns {{ replyText:string }}
 */
function proposeReply(comment, opts = {}) {
    const link = opts.link;
    const username = comment.username || 'there';

    const templates = [
        `Hey @${username}! 👋 Thanks for your interest! We just sent you a DM with all the details. 📩`,
        `Hi @${username}! Great question 😊 Check your DMs — we've sent you the info you need!`,
        `Hey @${username}! 👆 Sent you a DM with everything. Let us know if you have more questions!`
    ];

    const reply = templates[Math.floor(Math.random() * templates.length)];

    // AI disclosure (golden rule #2)
    const disclosure = '\n\n_(This reply was generated by AI and reviewed by a human.)_';

    return { replyText: reply + disclosure };
}

/**
 * Propose a DM to a commenter. This is the text the AI suggests sending as a
 * private DM — it includes the tracked link and AI disclosure.
 *
 * @param {Object} comment - { username, text, matchedKeyword }
 * @param {Object} opts - { link } tracked/UTM link for the funnel
 * @returns {{ dmText:string, link:string }}
 */
function proposeDM(comment, opts = {}) {
    const link = opts.link || '';
    const username = comment.username || 'there';
    const keyword = comment.matchedKeyword || '';

    const dmBody = [
        `Hey ${username}! 👋`,
        '',
        keyword === 'price' || keyword === 'how much'
            ? `Thanks for asking about pricing! Here's everything you need:`
            : keyword === 'link' || keyword === 'where' || keyword === 'store' || keyword === 'shop'
            ? `Here's the link you asked for:`
            : `Thanks for your interest! Here's what you're looking for:`,
        '',
        link || '(link will be inserted)',
        '',
        'Let me know if you have any questions — happy to help! 😊',
        '',
        '_Sent via AI assistant (human-reviewed)._'
    ].join('\n');

    return { dmText: dmBody, link };
}

/**
 * Process a batch of comments: scan, keyword-match, propose replies + DMs.
 * Returns the proposed engagement actions (all pending human approval).
 *
 * @param {Object} p
 * @param {string} p.deviceId
 * @param {string} p.platform
 * @param {string} [p.clipUrl]
 * @param {string} [p.clipId]
 * @param {string} [p.link] - tracked link for DMs (Whop checkout / funnel)
 * @param {string[]} [p.keywords] - keyword override
 * @param {Object} [p.mobileuse]
 * @returns {Promise<{comments:Array, matched:Array, proposals:Array}|null>}
 */
async function scanAndPropose(p = {}) {
    const mobileuse = p.mobileuse || mu;

    const comments = await scanComments(p);
    if (!comments) {
        return null; // Mobile-Use not alive or error
    }

    const matched = matchKeywords(comments, p.keywords);
    const proposals = matched.map(comment => {
        const reply = proposeReply(comment);
        const dm = proposeDM(comment, { link: p.link });
        return {
            clipId: p.clipId,
            platform: p.platform,
            deviceId: p.deviceId,
            comment,
            replyText: reply.replyText,
            dmText: dm.dmText,
            link: dm.link,
            status: 'pending_review',
            createdAt: new Date().toISOString()
        };
    });

    return { comments, matched, proposals };
}

/**
 * Execute a reply to a comment via Mobile-Use (after human approval).
 *
 * @param {Object} p
 * @param {string} p.deviceId
 * @param {string} p.platform
 * @param {Object} p.comment - { username, text, commentId }
 * @param {string} p.replyText
 * @param {Object} [p.mobileuse]
 * @returns {Promise<{success:boolean, dryRun?:boolean, error?:string}>}
 */
async function executeReply(p = {}) {
    const mobileuse = p.mobileuse || mu;
    const platform = String(p.platform || 'tiktok').toLowerCase();

    const alive = await mobileuse.isAlive();
    if (!alive) {
        console.log(`[dry-run] Mobile-Use not reachable, would reply to comment`);
        return { success: true, dryRun: true };
    }

    const appPackages = {
        tiktok: 'com.zhiliaoapp.musically',
        instagram: 'com.instagram.android',
        youtube: 'com.google.android.youtube'
    };
    const pkg = appPackages[platform] || appPackages.tiktok;
    const appNames = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
    const appName = appNames[platform] || appNames.tiktok;

    const instruction = [
        `Open the ${appName} app (package: ${pkg}).`,
        `Navigate to the comment by @${p.comment.username} that says: "${p.comment.text.slice(0, 100)}"`,
        `Tap the "Reply" button on that comment.`,
        `Type exactly this text:\n"""${p.replyText}"""`,
        `Tap the send/post button to post the reply.`,
        `Report "REPLY_OK" if successful.`
    ].join('\n');

    const result = await mobileuse.runAgent(p.deviceId, instruction);
    if (!result) return { success: false, error: 'agent_failed' };

    const resultText = String(result.result || '').toLowerCase();
    return { success: resultText.includes('reply_ok') || result.ok === true };
}

/**
 * Execute a DM to a commenter via Mobile-Use (after human approval).
 * Enforces rate limiting per device.
 *
 * @param {Object} p
 * @param {string} p.deviceId
 * @param {string} p.platform
 * @param {string} p.targetUsername
 * @param {string} p.dmText
 * @param {Object} [p.mobileuse]
 * @returns {Promise<{success:boolean, dryRun?:boolean, error?:string, rateLimited?:boolean}>}
 */
async function executeDM(p = {}) {
    const mobileuse = p.mobileuse || mu;
    const platform = String(p.platform || 'tiktok').toLowerCase();
    const deviceId = p.deviceId;

    // Rate limit check
    const rateCheck = _checkDmRate(deviceId);
    if (!rateCheck.allowed) {
        console.log(`[rate-limited] DM blocked for ${deviceId}: ${rateCheck.reason}`);
        return { success: false, rateLimited: true, error: rateCheck.reason };
    }

    const alive = await mobileuse.isAlive();
    if (!alive) {
        console.log(`[dry-run] Mobile-Use not reachable, would DM ${p.targetUsername}`);
        return { success: true, dryRun: true };
    }

    const appPackages = {
        tiktok: 'com.zhiliaoapp.musically',
        instagram: 'com.instagram.android',
        youtube: 'com.google.android.youtube'
    };
    const pkg = appPackages[platform] || appPackages.tiktok;
    const appNames = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
    const appName = appNames[platform] || appNames.tiktok;

    const instruction = [
        `Open the ${appName} app (package: ${pkg}).`,
        `Go to the messages/inbox section.`,
        `Start a new message or search for user @${p.targetUsername}.`,
        `If you can't find the user or can't start a DM, report "DM_NOT_AVAILABLE".`,
        `Type exactly this message:\n"""${p.dmText}"""`,
        `Send the message.`,
        `Report "DM_OK" if successful, or describe what went wrong.`
    ].join('\n');

    const result = await mobileuse.runAgent(deviceId, instruction);
    if (!result) return { success: false, error: 'agent_failed' };

    const resultText = String(result.result || '').toLowerCase();
    const ok = resultText.includes('dm_ok') || result.ok === true;

    if (ok) {
        _recordDm(deviceId);
    }

    return { success: ok };
}

module.exports = {
    scanComments,
    matchKeywords,
    proposeReply,
    proposeDM,
    scanAndPropose,
    executeReply,
    executeDM,
    _checkDmRate,
    _recordDm
};