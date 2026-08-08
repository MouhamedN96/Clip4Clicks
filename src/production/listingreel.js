/**
 * ClipForge Listing-Reel Producer (outreach / local-business path).
 *
 * Turns a local business's OWN listing photos into a vertical reel. The pitch
 * this feeds is "you posted 24 photos of that job — here's what they look like
 * as a 50-second reel", so the source material has to be theirs: a rendered
 * approximation of their trade is a weaker artifact and can be factually wrong
 * about their premises, their vehicle, their work.
 *
 * That makes this the cheapest producer here — no fal, no Veo, no per-second
 * generation billing. Just ffmpeg over images they already published.
 *
 * Why Ken Burns rather than a static slideshow: listing photos are landscape,
 * the target is 9:16, and a straight crop discards most of the frame. A slow
 * pan/zoom reveals over time what any single cropped frame hides — so the
 * motion is load-bearing, not decoration.
 *
 * Length is deliberate. Video prospecting lands best at 45-75s: under 45 reads
 * as too thin to be credible, over 90 and completion falls off a cliff. So the
 * per-image duration is derived from the image count to land inside that band
 * rather than being a fixed constant.
 *
 * Degrades gracefully: no images → skip marker, never throws. Matches the seam
 * convention of stockreel.js / productad.js.
 *
 * Job shape:
 *   { clipId, clientId?, images: [absolute paths], clips?: [paths to real video],
 *     title?, captions?: [string], targetSeconds?, secondsPerImage? }
 */

const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

// Middle of the 45-75s band that video prospecting converts best in.
const TARGET_SECONDS = 60;
// A still held under ~2.5s reads as a flicker; over ~5s the pan runs out of
// anywhere to go and it starts to feel like a screensaver.
const MIN_PER_IMAGE = 2.5;
const MAX_PER_IMAGE = 5.0;
const FPS = 30;

// zoompan works in whole input pixels, so at 1:1 the motion visibly steps.
// Rendering the pan over a 2x canvas and letting the downscale to 1080x1920
// absorb the remainder buys sub-pixel smoothness for ~4x the pixels, where
// the usual 8000px-wide trick costs far more for a difference nobody sees.
const OVERSAMPLE = 2;
const OUT_W = 1080;
const OUT_H = 1920;

/**
 * Four moves, cycled by index. Twenty stills that all push in at the same rate
 * feel mechanical; alternating direction is what makes it read as edited.
 *
 * `on` is the output frame number and `duration` the frame count for the current
 * input frame. Note it is `duration`, NOT `d` - `d` is the zoompan *option*, and
 * using it in an expression fails the whole filter with a bare "Invalid
 * argument", which looks like a broken image rather than a typo.
 *
 * `progress` is clamped because with -loop 1 the input never ends; if the output
 * ever ran past one input frame's allocation the pan would sail off the edge.
 */
const PROGRESS = `min(on/duration,1)`;

const MOVES = [
    { // slow push in, centred
        z: `min(zoom+0.0012,1.28)`,
        x: `iw/2-(iw/zoom/2)`,
        y: `ih/2-(ih/zoom/2)`
    },
    { // pull out, centred
        z: `if(lte(zoom,1.0),1.28,max(1.001,zoom-0.0012))`,
        x: `iw/2-(iw/zoom/2)`,
        y: `ih/2-(ih/zoom/2)`
    },
    { // push in while drifting right
        z: `min(zoom+0.0010,1.25)`,
        x: `(iw-iw/zoom)*${PROGRESS}`,
        y: `ih/2-(ih/zoom/2)`
    },
    { // push in while drifting down
        z: `min(zoom+0.0010,1.25)`,
        x: `iw/2-(iw/zoom/2)`,
        y: `(ih-ih/zoom)*${PROGRESS}`
    }
];

class ListingReelProducer {
    constructor(config = {}) {
        this.dataDir = config.dataDir || process.env.CLIP_DATA_DIR || '/app/data';
        this.clipsDir = path.join(this.dataDir, 'clips');
        this.workDir = path.join(this.dataDir, 'listing');
        this.ffmpegPath = config.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    }

    async ensureDirs() {
        await fs.mkdir(this.clipsDir, { recursive: true });
        await fs.mkdir(this.workDir, { recursive: true });
    }

    /**
     * Build one reel and return a pipeline-shaped segment, or a skip marker
     * { status:'skipped', reason } (never throws on missing/unreadable input).
     */
    async generateReel(job = {}) {
        const images = await this.usableImages(job.images || []);
        const clips = await this.usableImages(job.clips || []);

        if (!images.length && !clips.length) {
            return { status: 'skipped', reason: 'no usable images or clips' };
        }

        await this.ensureDirs();

        const stamp = Date.now();
        const perImage = this.perImageSeconds(images.length + clips.length, job);
        const parts = [];

        try {
            for (const [i, img] of images.entries()) {
                const out = path.join(this.workDir, `kb_${stamp}_${i}.mp4`);
                await this.kenBurns(img, perImage, MOVES[i % MOVES.length], out);
                parts.push(out);
            }

            // Real footage (a dealer walkaround, a job clip) drops into the same
            // sequence - it just needs the identical encode params or the concat
            // demuxer's stream copy refuses it.
            for (const [i, src] of clips.entries()) {
                const out = path.join(this.workDir, `vid_${stamp}_${i}.mp4`);
                await this.normalizeClip(src, perImage, out);
                parts.push(out);
            }

            const outName = `${job.clipId || 'listing'}_reel_${stamp}.mp4`;
            const outPath = path.join(this.clipsDir, outName);
            const concatOut = job.captions && job.captions.length
                ? path.join(this.workDir, `concat_${stamp}.mp4`)
                : outPath;

            await this.concat(parts, concatOut);

            if (concatOut !== outPath) {
                try {
                    await this.burnCaptions(concatOut, job.captions, perImage, outPath);
                } catch (error) {
                    // Captions are best-effort; ship the reel regardless.
                    console.error(`Listing-reel captions failed, shipping uncaptioned: ${error.message}`);
                    await fs.rename(concatOut, outPath).catch(() => {});
                }
            }

            const seconds = Number((parts.length * perImage).toFixed(1));

            return {
                index: 0,
                provider: 'listing',
                path: outPath,
                seconds,
                sourceCount: parts.length,
                // Surfaced so the operator can see a reel landed outside the band
                // that converts, rather than finding out from a flat reply rate.
                shortOfTarget: seconds < 45,
                title: job.title
                    ? `Reel: ${String(job.title).slice(0, 60)}`
                    : `Listing reel ${job.clientId || job.clipId || ''}`.trim(),
                // Cut from stills the business already published - there is no
                // speech to transcribe.
                captions: { status: 'n/a' }
            };
        } finally {
            await Promise.all(parts.map(p => fs.unlink(p).catch(() => {})));
        }
    }

    /** Drop anything unreadable rather than failing the whole reel for one bad file. */
    async usableImages(paths) {
        const checked = await Promise.all(
            paths.map(async (p) => {
                try {
                    const stat = await fs.stat(p);
                    return stat.isFile() && stat.size > 0 ? p : null;
                } catch {
                    return null;
                }
            })
        );
        return checked.filter(Boolean);
    }

    /**
     * Spread `count` sources across the target runtime, clamped to what a single
     * still can hold. An explicit secondsPerImage wins.
     */
    perImageSeconds(count, job = {}) {
        if (job.secondsPerImage) {
            return Math.min(MAX_PER_IMAGE, Math.max(MIN_PER_IMAGE, Number(job.secondsPerImage)));
        }
        const target = Number(job.targetSeconds) || TARGET_SECONDS;
        const even = count > 0 ? target / count : MAX_PER_IMAGE;
        return Number(Math.min(MAX_PER_IMAGE, Math.max(MIN_PER_IMAGE, even)).toFixed(2));
    }

    /**
     * One still → one moving clip, framed 9:16.
     *
     * Order matters: cover-crop to the target aspect at oversampled size FIRST,
     * then pan within that. Panning before the crop would let the zoom window
     * wander outside the visible frame.
     */
    async kenBurns(src, seconds, move, outPath) {
        const frames = Math.max(1, Math.round(seconds * FPS));
        const w = OUT_W * OVERSAMPLE;
        const h = OUT_H * OVERSAMPLE;

        const vf = [
            `scale=${w}:${h}:force_original_aspect_ratio=increase`,
            `crop=${w}:${h}`,
            `zoompan=z='${move.z}':x='${move.x}':y='${move.y}':d=${frames}:s=${OUT_W}x${OUT_H}:fps=${FPS}`,
            'setsar=1'
        ].join(',');

        await this.run(this.ffmpegPath, [
            '-y', '-loop', '1', '-i', src,
            '-vf', vf,
            '-t', String(seconds),
            '-an',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', outPath
        ]);
        return outPath;
    }

    /** Same encode params as kenBurns, so the two can be concatenated by stream copy. */
    async normalizeClip(src, seconds, outPath) {
        await this.run(this.ffmpegPath, [
            '-y', '-i', src, '-t', String(seconds),
            '-vf', `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${FPS}`,
            '-an',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', outPath
        ]);
        return outPath;
    }

    async concat(paths, outPath) {
        const listFile = path.join(this.workDir, `list_${Date.now()}.txt`);
        await fs.writeFile(listFile, paths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
        try {
            await this.run(this.ffmpegPath, [
                '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
                '-c', 'copy', '-movflags', '+faststart', outPath
            ]);
        } finally {
            await fs.unlink(listFile).catch(() => {});
        }
        return outPath;
    }

    /** One caption line per source, timed to the same cadence as the cuts. */
    async burnCaptions(inPath, captions, perImage, outPath) {
        const assName = `caps_${Date.now()}.ass`;
        const assPath = path.join(this.workDir, assName);
        await fs.writeFile(assPath, this.buildAss(captions, perImage));
        try {
            // The subtitle path goes INSIDE a filter string, where ':' separates
            // options - so an absolute Windows path splits at the drive letter
            // and ffmpeg reads the remainder as 'original_size'. Escaping it does
            // not reliably survive filtergraph parsing, so run from the work dir
            // and pass a bare filename instead. Invisible on Linux, fatal on
            // Windows, which is why it hid in stockreel.js.
            await this.run(this.ffmpegPath, [
                '-y', '-i', inPath,
                '-vf', `ass=${assName}`,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', outPath
            ], { cwd: this.workDir });
        } finally {
            await fs.unlink(assPath).catch(() => {});
        }
        return outPath;
    }

    buildAss(captions, perImage) {
        const header =
            '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n' +
            '[V4+ Styles]\n' +
            'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n' +
            'Style: Cap, Arial, 72, &H00FFFFFF, &H00000000, &H64000000, 1, 4, 0, 2, 60, 60, 250\n\n' +
            '[Events]\nFormat: Layer, Start, End, Style, Text\n';
        const lines = captions.map((text, i) => {
            const start = this.assTime(i * perImage);
            const end = this.assTime((i + 1) * perImage);
            const clean = String(text || '').replace(/\n/g, ' ').replace(/[{}]/g, '');
            return `Dialogue: 0,${start},${end},Cap,,${clean}`;
        });
        return header + lines.join('\n') + '\n';
    }

    assTime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = (sec % 60).toFixed(2).padStart(5, '0');
        return `${h}:${String(m).padStart(2, '0')}:${s}`;
    }

    run(cmd, args, opts = {}) {
        return new Promise((resolve, reject) => {
            const proc = spawn(cmd, args, { shell: false, ...opts });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', d => { stdout += d.toString(); });
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('close', code => {
                if (code === 0) resolve(stdout);
                else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`));
            });
            proc.on('error', reject);
        });
    }
}

module.exports = ListingReelProducer;
