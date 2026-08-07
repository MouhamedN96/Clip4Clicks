/**
 * ClipForge Product-Ad Producer (dropship / commerce path).
 *
 * The dropship-arbitrage payload: turn a supplier product photo into a short
 * vertical ad. Uses Seedance reference-to-video (the product image seeds the
 * clip) with a localized hook written by DeepSeek, then drops the mp4 into the
 * SAME clips/ directory every other producer uses so it flows into the identical
 * human-review gate. Approved ads post with the store link (see the worker's
 * post payload + the approve endpoint).
 *
 * Degrades gracefully: no FAL_KEY (or no product image) → skip marker, never
 * throws. Matches the seam convention of higgsfield.js / stockreel.js.
 *
 * Job shape:
 *   { clipId, clientId?, productTitle, productImageUrls[] (or productImageUrl),
 *     price?, targetGeo?, targetLang?, angle?, storeUrl?, supplierUrl?, premium? }
 */

const path = require('path');
const fs = require('fs').promises;
const seedance = require('../integration/seedance');
const llm = require('../integration/llm');

// Appended to every generation prompt. Names what is free to change and what is
// not, then closes on natural detail so the result doesn't come back as a glossy
// render. The order matters: models weight the fence more when it follows the
// creative direction rather than preceding it.
const PRODUCT_FENCE =
    'Keep the product exactly as it appears in the reference image — identical shape, ' +
    'proportions, colour, materials, finish, labelling and branding. Do not redesign, ' +
    'restyle, upgrade or embellish the product itself. Change only the setting, lighting, ' +
    'camera movement and the action around it. ' +
    'Vertical 9:16, mobile-first, high energy, suitable for TikTok/Reels/Shorts. ' +
    'Keep textures and reflections natural and true to life, shot on a phone, ' +
    'not over-processed or advertising-glossy.';

class ProductAdProducer {
    constructor(config = {}) {
        this.dataDir = config.dataDir || process.env.CLIP_DATA_DIR || '/app/data';
        this.clipsDir = path.join(this.dataDir, 'clips');
        this.aspectRatio = config.aspectRatio || '9:16';
        this.resolution = config.resolution || process.env.SEEDANCE_RESOLUTION || '720p';
    }

    async ensureDirs() {
        await fs.mkdir(this.clipsDir, { recursive: true });
    }

    /**
     * Generate one product ad and return a pipeline-shaped segment, or a skip
     * marker { status:'skipped', reason } (never throws on a missing key/image).
     */
    async generateProductAd(job = {}) {
        if (!seedance.hasFal()) {
            return { status: 'skipped', reason: 'no FAL_KEY' };
        }
        const images = job.productImageUrls
            || (job.productImageUrl ? [job.productImageUrl] : []);
        if (!images.length) {
            return { status: 'skipped', reason: 'no product image' };
        }

        await this.ensureDirs();

        const prompt = await this.buildPrompt(job);
        const { videoUrl, seed, endpoint } = await seedance.generateVideo({
            mode: 'reference',
            prompt,
            imageUrls: images,
            aspectRatio: this.aspectRatio,
            resolution: this.resolution,
            generateAudio: true
        });

        const outName = `${job.clipId || 'ad'}_ad_${Date.now()}.mp4`;
        const outPath = path.join(this.clipsDir, outName);
        await seedance.download(videoUrl, outPath);

        return {
            index: 0,
            provider: 'seedance',
            model: endpoint,
            seed,
            path: outPath,
            title: job.productTitle
                ? `Ad: ${String(job.productTitle).slice(0, 60)}`
                : `Product ad ${job.clientId || job.clipId || ''}`.trim(),
            // Seedance carries native audio + on-screen action; ASR captioning
            // doesn't apply, so mark n/a (same convention as higgsfield.js).
            captions: { status: 'n/a' }
        };
    }

    /**
     * Compose the generation prompt. A supplied angle/brief wins; otherwise ask
     * DeepSeek for a localized short-form ad concept. Falls back to a template
     * prompt when no DeepSeek key is set, so this never blocks on the LLM.
     *
     * Every ad here runs in reference mode against the supplier's own photo, so
     * the prompt has to fence the product off: say what may change (setting,
     * light, camera, action) and what may not (the item itself). Without that,
     * the model happily restyles the product into something better looking than
     * the one you can actually ship — and on a dropship order that is a refund,
     * a chargeback and a store rating, not a cosmetic problem.
     */
    async buildPrompt(job) {
        let hook = job.angle || job.brief;

        if (!hook && llm.hasDeepSeek()) {
            const lang = job.targetLang || 'English';
            try {
                const reply = await llm.chatDeepSeek([
                    { role: 'system', content: `You write short, punchy UGC-style short-form video ad concepts. Reply with ONE vivid 1-2 sentence shot description in ${lang}. Describe only the setting, camera and action — never the product's own appearance, since it is fixed by a reference photo. No preamble, no quotes.` },
                    { role: 'user', content: `Product: ${job.productTitle || 'a product'}${job.price ? ` (price ${job.price})` : ''}. Target market: ${job.targetGeo || 'global'}. Write a scroll-stopping 5-second vertical ad concept that shows the product in use.` }
                ], { maxTokens: 220, temperature: 0.8 });
                hook = String(reply).trim().replace(/^["']|["']$/g, '');
            } catch (error) {
                console.error(`Product-ad hook generation failed, using template: ${error.message}`);
            }
        }

        if (!hook) {
            hook = `Fast UGC-style vertical ad: a hand demonstrates ${job.productTitle || 'the product'} on a clean bright surface, punchy quick cuts, energetic and upbeat`;
        }

        return `${hook} ${PRODUCT_FENCE}`;
    }
}

module.exports = ProductAdProducer;
