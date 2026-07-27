/**
 * ClipForge Seedance (fal) video integration.
 *
 * Thin client over fal's async queue API for ByteDance Seedance 2.0:
 *   - text-to-video       (hero / no source image)
 *   - image-to-video      (animate a single start image)
 *   - reference-to-video  (up to 9 reference images → the product-ad path)
 * All variants support native audio (generate_audio) and 9:16 vertical output.
 *
 * Auth: header  Authorization: Key {FAL_KEY}   (the same key used for ASR).
 * Degrades gracefully: hasFal() lets callers skip instead of throwing.
 *
 * API shape (verified against fal.ai, July 2026):
 *   Submit : POST  https://queue.fal.run/{model}/{mode}-to-video
 *            body { prompt, image_urls?, aspect_ratio, resolution, generate_audio, duration? }
 *            -> { status_url, response_url, request_id }
 *   Poll   : GET   {status_url}                       -> { status: IN_QUEUE|IN_PROGRESS|COMPLETED|... }
 *   Result : GET   {response_url}                     -> { video: { url }, seed }
 */

const { createWriteStream } = require('fs');
const { Readable } = require('stream');
const { pipeline: streamPipeline } = require('stream/promises');

const FAL_QUEUE = process.env.FAL_QUEUE_BASE || 'https://queue.fal.run';
// Base model id WITHOUT the trailing "{mode}-to-video". Swap to the non-"fast"
// tier for higher quality, or point at Veo later — the seam is env-driven.
const DEFAULT_MODEL = process.env.SEEDANCE_MODEL || 'bytedance/seedance-2.0/fast';

/** @returns {boolean} whether a fal key is configured. */
function hasFal() {
    return !!process.env.FAL_KEY;
}

function authHeader() {
    const k = process.env.FAL_KEY;
    return k ? `Key ${k}` : null;
}

async function submit(endpoint, body) {
    const res = await fetch(`${FAL_QUEUE}/${endpoint}`, {
        method: 'POST',
        headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fal submit failed (${res.status}) for "${endpoint}": ${text.slice(0, 300)}`);
    let data; try { data = JSON.parse(text); } catch { data = {}; }
    if (!data.status_url || !data.response_url) {
        throw new Error(`fal submit returned no status/response url: ${text.slice(0, 200)}`);
    }
    return { statusUrl: data.status_url, responseUrl: data.response_url };
}

async function poll(statusUrl, { intervalMs, timeoutMs } = {}) {
    const iv = intervalMs || Number(process.env.FAL_POLL_INTERVAL_MS) || 6000;
    const deadline = Date.now() + (timeoutMs || Number(process.env.FAL_POLL_TIMEOUT_MS) || 10 * 60 * 1000);
    for (;;) {
        const res = await fetch(statusUrl, { headers: { 'Authorization': authHeader() } });
        const text = await res.text();
        if (!res.ok) throw new Error(`fal status check failed (${res.status}): ${text.slice(0, 200)}`);
        let data; try { data = JSON.parse(text); } catch { data = {}; }
        const status = String(data.status || '').toUpperCase();
        if (status === 'COMPLETED') return;
        if (status === 'FAILED' || status === 'ERROR') throw new Error(`fal job ${status}: ${text.slice(0, 200)}`);
        if (Date.now() >= deadline) throw new Error(`fal job timed out (last status "${status}")`);
        await new Promise(r => setTimeout(r, iv));
    }
}

async function fetchResult(responseUrl) {
    const res = await fetch(responseUrl, { headers: { 'Authorization': authHeader() } });
    const text = await res.text();
    if (!res.ok) throw new Error(`fal result fetch failed (${res.status}): ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const url = (data.video && data.video.url)
        || (typeof data.video === 'string' ? data.video : null)
        || (Array.isArray(data.videos) && data.videos[0] && (data.videos[0].url || data.videos[0]));
    if (!url) throw new Error(`fal result had no video url: ${text.slice(0, 200)}`);
    return { videoUrl: url, seed: data.seed };
}

/**
 * Generate a Seedance video and return the hosted mp4 URL.
 * @param {Object} p
 * @param {'text'|'image'|'reference'} [p.mode]
 * @param {string} p.prompt
 * @param {string[]} [p.imageUrls] - reference/start images (reference|image modes)
 * @param {string} [p.aspectRatio='9:16']
 * @param {string} [p.resolution='720p']
 * @param {number|string} [p.duration]
 * @param {boolean} [p.generateAudio=true]
 * @param {string} [p.model] - base model id override
 * @returns {Promise<{videoUrl:string, seed:number, endpoint:string}>}
 */
async function generateVideo(p = {}) {
    if (!hasFal()) throw new Error('no FAL_KEY');
    const modelBase = (p.model || DEFAULT_MODEL).replace(/\/+$/, '');
    const mode = p.mode || (p.imageUrls && p.imageUrls.length ? 'reference' : 'text');
    const endpoint = `${modelBase}/${mode}-to-video`;

    const body = {
        prompt: p.prompt || '',
        aspect_ratio: p.aspectRatio || '9:16',
        resolution: p.resolution || '720p',
        generate_audio: p.generateAudio !== false
    };
    if (p.duration) body.duration = p.duration;
    if (p.imageUrls && p.imageUrls.length) body.image_urls = p.imageUrls;

    const { statusUrl, responseUrl } = await submit(endpoint, body);
    await poll(statusUrl);
    const r = await fetchResult(responseUrl);
    return { ...r, endpoint };
}

/** Stream a remote mp4 to disk. */
async function download(url, outPath) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fal download failed (${res.status}) for ${url}`);
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
    return outPath;
}

module.exports = { hasFal, generateVideo, download };
