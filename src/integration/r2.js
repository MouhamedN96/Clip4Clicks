/**
 * Cloudflare R2 storage (S3-compatible).
 *
 * Produced media lives here instead of on the box: R2 charges NOTHING for
 * egress, and the dominant traffic pattern is the desktop downloading every
 * produced clip to post it. It also means a dead VPS doesn't take the videos
 * with it.
 *
 * SigV4 is hand-rolled over `fetch` + node:crypto rather than pulling in the AWS
 * SDK (~15MB) for two operations — matching the other integrations here, which
 * are all dependency-free clients.
 *
 * Degrades gracefully: with no R2 credentials `isConfigured()` is false and every
 * caller falls back to local files, exactly as before.
 *
 * Env:
 *   R2_ACCOUNT_ID         Cloudflare account id
 *   R2_ACCESS_KEY_ID      R2 API token (S3-compatible access key)
 *   R2_SECRET_ACCESS_KEY  its secret
 *   R2_BUCKET             bucket name
 *   R2_PRESIGN_TTL        seconds a download link stays valid (default 3600)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REGION = 'auto';           // R2 always uses "auto"
const SERVICE = 's3';
const ALGO = 'AWS4-HMAC-SHA256';

function cfg() {
    return {
        accountId: process.env.R2_ACCOUNT_ID || '',
        accessKey: process.env.R2_ACCESS_KEY_ID || '',
        secretKey: process.env.R2_SECRET_ACCESS_KEY || '',
        bucket: process.env.R2_BUCKET || '',
        ttl: Number(process.env.R2_PRESIGN_TTL) || 3600
    };
}

/** @returns {boolean} whether R2 is fully configured. */
function isConfigured() {
    const c = cfg();
    return !!(c.accountId && c.accessKey && c.secretKey && c.bucket);
}

function endpoint() {
    return `https://${cfg().accountId}.r2.cloudflarestorage.com`;
}

const hmac = (key, str) => crypto.createHmac('sha256', key).update(str, 'utf8').digest();
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Percent-encode per RFC3986, preserving "/" so key paths stay readable.
function encodeKey(key) {
    return String(key).split('/').map(seg =>
        encodeURIComponent(seg).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
    ).join('/');
}

function stamps(now = new Date()) {
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');  // YYYYMMDDTHHMMSSZ
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(secret, dateStamp) {
    return hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), REGION), SERVICE), 'aws4_request');
}

/**
 * Upload a local file to R2 under `key`.
 * @returns {Promise<string>} the key
 */
async function putObject(localPath, key, contentType) {
    const c = cfg();
    if (!isConfigured()) throw new Error('R2 not configured');

    const body = await fs.promises.readFile(localPath);
    const { amzDate, dateStamp } = stamps();
    const host = `${c.accountId}.r2.cloudflarestorage.com`;
    const canonicalUri = `/${c.bucket}/${encodeKey(key)}`;
    const payloadHash = sha256hex(body);

    const canonicalHeaders =
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const toSign = [ALGO, amzDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
    const signature = hmac(signingKey(c.secretKey, dateStamp), toSign).toString('hex');

    const res = await fetch(`${endpoint()}${canonicalUri}`, {
        method: 'PUT',
        headers: {
            'Authorization': `${ALGO} Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': String(body.length)
        },
        body
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`R2 PUT failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return key;
}

/**
 * Build a presigned GET URL. Query-signed, so the desktop can fetch the object
 * directly from R2 (free egress, no bytes through the VPS).
 * @returns {string} url
 */
function presignGet(key, expiresSecs) {
    const c = cfg();
    if (!isConfigured()) throw new Error('R2 not configured');

    const { amzDate, dateStamp } = stamps();
    const host = `${c.accountId}.r2.cloudflarestorage.com`;
    const canonicalUri = `/${c.bucket}/${encodeKey(key)}`;
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    // Query params must be sorted for the canonical request.
    const params = {
        'X-Amz-Algorithm': ALGO,
        'X-Amz-Credential': `${c.accessKey}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expiresSecs || c.ttl),
        'X-Amz-SignedHeaders': 'host'
    };
    const canonicalQuery = Object.keys(params).sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

    const canonicalRequest = [
        'GET', canonicalUri, canonicalQuery,
        `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'
    ].join('\n');
    const toSign = [ALGO, amzDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
    const signature = hmac(signingKey(c.secretKey, dateStamp), toSign).toString('hex');

    return `${endpoint()}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Best-effort upload of a produced asset. Returns the key, or null on any
 * failure — media staying local is a degraded state, never a failed clip.
 */
async function uploadAsset(localPath, keyPrefix) {
    if (!isConfigured() || !localPath) return null;
    try {
        const base = path.basename(localPath);
        const ext = path.extname(base).toLowerCase();
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
        return await putObject(localPath, `${keyPrefix}/${base}`, type);
    } catch (error) {
        console.warn(`R2 upload skipped (${localPath}): ${error.message}`);
        return null;
    }
}

module.exports = { isConfigured, putObject, presignGet, uploadAsset };
