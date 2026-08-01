/**
 * Poster frames.
 *
 * Shared by the worker (extracts one when a clip enters the review gate) and the
 * API (generates one on demand for clips produced before posters existed), so
 * there's a single implementation of the ffmpeg incantation rather than two that
 * can drift.
 */

const { spawn } = require('child_process');

/**
 * Grab a single frame at `seekSecs` into `clipPath`, writing `out`.
 * @returns {Promise<boolean>} whether ffmpeg exited cleanly
 */
function grabFrame(clipPath, out, seekSecs) {
    return new Promise((resolve) => {
        // -ss before -i seeks fast. `-update 1` is REQUIRED for a single image:
        // without it the image2 muxer still writes the file but exits non-zero,
        // which silently looks like failure.
        const proc = spawn('ffmpeg', ['-y', '-ss', String(seekSecs), '-i', clipPath,
            '-frames:v', '1', '-update', '1', '-vf', 'scale=216:-1', '-q:v', '5', out],
            { shell: false });
        const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(false); }, 20000);
        proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
        proc.on('error', () => { clearTimeout(timer); resolve(false); });
    });
}

/**
 * Extract a poster next to the clip. Best-effort: any failure returns null so a
 * missing poster never turns into a failed clip.
 * @param {string} clipPath
 * @returns {Promise<string|null>} path to the jpg, or null
 */
async function extractPoster(clipPath) {
    if (!clipPath) return null;
    const out = String(clipPath).replace(/\.[^.]+$/, '') + '_poster.jpg';
    // 1s in dodges a black first frame; fall back to frame 0 for very short clips.
    if (await grabFrame(clipPath, out, 1)) return out;
    if (await grabFrame(clipPath, out, 0)) return out;
    console.warn(`poster extraction failed for ${clipPath}`);
    return null;
}

module.exports = { extractPoster };
