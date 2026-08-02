/**
 * ClipForge Worker
 * Background job processor for clip generation and outreach
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const WhopIntegration = require('../integration/whop');
const mobileuse = require('../integration/mobileuse');
const ProductionPipeline = require('../production/pipeline');
const HiggsfieldProducer = require('../production/higgsfield');
const StockReelProducer = require('../production/stockreel');
const ProductAdProducer = require('../production/productad');
const { extractPoster } = require('../production/poster');
const r2 = require('../integration/r2');
// posting/engagement export plain function collections (not classes).
const posting = require('../production/posting');
const engagement = require('../production/engagement');

const config = {
    whop: {
        apiKey: process.env.WHOP_API_KEY,
        merchantId: process.env.WHOP_MERCHANT_ID,
        webhookSecret: process.env.WHOP_WEBHOOK_SECRET,
        defaultCommission: parseInt(process.env.WHOP_DEFAULT_COMMISSION) || 30,
        referralCommission: parseInt(process.env.WHOP_REFERRAL_COMMISSION) || 25
    }
};

const whop = new WhopIntegration(config.whop);
const pipeline = new ProductionPipeline({ dataDir: process.env.CLIP_DATA_DIR || '/app/data' });
const higgsfield = new HiggsfieldProducer({ dataDir: process.env.CLIP_DATA_DIR || '/app/data' });
const stockReel = new StockReelProducer({ dataDir: process.env.CLIP_DATA_DIR || '/app/data' });
const productAd = new ProductAdProducer({ dataDir: process.env.CLIP_DATA_DIR || '/app/data' });

// Mobile-Use is optional at boot: check lazily only when a post/engagement job runs.
let mobileuseReady = false;
let mobileuseChecked = false;

async function ensureMobileUse() {
    if (mobileuseReady) return true;
    if (mobileuseChecked && !mobileuse.isConfigured()) return false;
    if (!mobileuse.isConfigured()) {
        mobileuseChecked = true;
        return false; // Mobile-Use not configured → dry-run
    }
    const alive = await mobileuse.isAlive();
    if (alive) {
        mobileuseReady = true;
        console.log('Mobile-Use: server reachable');
    } else {
        console.log('Mobile-Use: server not reachable, posting in dry-run');
    }
    mobileuseChecked = true;
    return alive;
}

const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD
});

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    db: process.env.REDIS_DB
});

// Worker queues
const queues = {
    clip: 'clip_queue',
    generate: 'generate_queue',
    reel: 'reel_queue',
    productAd: 'product_ad_queue',
    post: 'post_queue',
    outreach: 'outreach_queue',
    engagement: 'engagement_queue',
    analytics: 'analytics_queue',
    onboarding: 'onboarding_queue'
};

// Process clip generation jobs.
// Produces real clips, then parks each at status='pending_review' for a human
// gate. Nothing auto-posts — approval happens via /api/clips/:id/approve.
async function processClipJob(job) {
    console.log(`Processing clip job: client=${job.clientId} source=${job.sourceUrl || job.sourcePath}`);

    const client = await pool.connect();
    let clipId;
    try {
        const inserted = await client.query(
            `INSERT INTO clips (client_id, source_url, source_platform, status)
             VALUES ($1, $2, $3, 'processing') RETURNING id`,
            [job.clientId, job.sourceUrl || null, job.sourcePlatform || null]
        );
        clipId = inserted.rows[0].id;
    } finally {
        client.release();
    }

    try {
        const produced = await pipeline.produce({ ...job, clipId });

        if (!produced.length) {
            await setClipStatus(clipId, 'failed', { error: 'no segments produced' });
            return { clipId, status: 'failed' };
        }

        // First segment stays on this row; extra segments get their own rows.
        const primary = produced[0];
        await setClipStatus(clipId, 'pending_review', {
            producedAt: new Date().toISOString(),
            job: reQueueable(job),
            segments: produced.map(p => ({ start: p.start, end: p.end, path: p.path, title: p.title })),
            clipPath: primary.path,
            captions: primary.captions,
            platforms: job.platforms || ['tiktok', 'youtube']
        });

        for (let i = 1; i < produced.length; i++) {
            const seg = produced[i];
            const extra = await pool.connect();
            try {
                await extra.query(
                    `INSERT INTO clips (client_id, source_url, source_platform, title, status, metadata)
                     VALUES ($1, $2, $3, $4, 'pending_review', $5)`,
                    [job.clientId, job.sourceUrl || null, job.sourcePlatform || null, seg.title,
                     JSON.stringify({ clipPath: seg.path, captions: seg.captions, start: seg.start, end: seg.end,
                                      platforms: job.platforms || ['tiktok', 'youtube'] })]
                );
            } finally {
                extra.release();
            }
        }

        console.log(`Clip job produced ${produced.length} segment(s) awaiting review: ${clipId}`);
        return { clipId, status: 'pending_review', segments: produced.length };
    } catch (error) {
        console.error(`Clip production failed (${clipId}): ${error.message}`);
        if (clipId) await setClipStatus(clipId, 'failed', { error: error.message });
        return { clipId, status: 'failed', error: error.message };
    }
}

// Process generative spec-ad jobs (SMB path, no source footage → Higgsfield).
// Lands at the same 'pending_review' gate as clipped videos.
async function processGenerateJob(job) {
    console.log(`Processing generate job: client=${job.clientId} brief=${(job.brief || job.productUrl || '').slice(0, 60)}`);

    const client = await pool.connect();
    let clipId;
    try {
        const inserted = await client.query(
            `INSERT INTO clips (client_id, source_platform, title, status)
             VALUES ($1, 'higgsfield', $2, 'processing') RETURNING id`,
            [job.clientId, job.title || 'Spec ad']
        );
        clipId = inserted.rows[0].id;
    } finally {
        client.release();
    }

    try {
        const seg = await higgsfield.generateSpecAd({ ...job, clipId });

        if (!seg || seg.status === 'skipped' || !seg.path) {
            await setClipStatus(clipId, 'failed', { error: seg && seg.reason ? seg.reason : 'no video produced' });
            return { clipId, status: 'failed', reason: seg && seg.reason };
        }

        await setClipStatus(clipId, 'pending_review', {
            producedAt: new Date().toISOString(),
            job: reQueueable(job),
            clipPath: seg.path,
            provider: seg.provider || 'higgsfield',
            model: seg.model,
            captions: seg.captions || { status: 'n/a' },
            platforms: job.platforms || ['tiktok', 'instagram']
        });

        console.log(`Spec-ad generated, awaiting review: ${clipId}`);
        return { clipId, status: 'pending_review' };
    } catch (error) {
        console.error(`Spec-ad generation failed (${clipId}): ${error.message}`);
        if (clipId) await setClipStatus(clipId, 'failed', { error: error.message });
        return { clipId, status: 'failed', error: error.message };
    }
}

// Process free stock-reel jobs (SMB path, no footage → Pexels/Pixabay assembly).
// Same 'pending_review' gate. $0 COGS beyond a cheap script call.
async function processReelJob(job) {
    console.log(`Processing reel job: client=${job.clientId} brief=${(job.brief || '').slice(0, 60)}`);

    const client = await pool.connect();
    let clipId;
    try {
        const inserted = await client.query(
            `INSERT INTO clips (client_id, source_platform, title, status)
             VALUES ($1, 'stock', $2, 'processing') RETURNING id`,
            [job.clientId, job.title || 'Stock reel']
        );
        clipId = inserted.rows[0].id;
    } finally {
        client.release();
    }

    try {
        const seg = await stockReel.generateReel({ ...job, clipId });

        if (!seg || seg.status === 'skipped' || !seg.path) {
            await setClipStatus(clipId, 'failed', { error: seg && seg.reason ? seg.reason : 'no reel produced' });
            return { clipId, status: 'failed', reason: seg && seg.reason };
        }

        await setClipStatus(clipId, 'pending_review', {
            producedAt: new Date().toISOString(),
            job: reQueueable(job),
            clipPath: seg.path,
            provider: seg.provider || 'stock',
            model: seg.model,
            scenes: seg.scenes,
            captions: seg.captions || { status: 'n/a' },
            platforms: job.platforms || ['tiktok', 'instagram']
        });

        console.log(`Stock reel produced, awaiting review: ${clipId}`);
        return { clipId, status: 'pending_review' };
    } catch (error) {
        console.error(`Stock reel failed (${clipId}): ${error.message}`);
        if (clipId) await setClipStatus(clipId, 'failed', { error: error.message });
        return { clipId, status: 'failed', error: error.message };
    }
}

// Build a UTM query string for a product ad. {platform} is resolved per-platform
// at post time (in processPostJob). Returns null when there's no store link.
function buildUtm(job, clipId) {
    if (!job.storeUrl) return null;
    const slug = String(job.productSlug || job.productTitle || 'product')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return `utm_source={platform}&utm_medium=organic&utm_campaign=${slug}&utm_content=${clipId}`;
}

// Process product-ad jobs (dropship path, product photo → Seedance ad).
// Same 'pending_review' gate as every other producer. Approved ads post with
// the store link (see the approve endpoint + processPostJob).
async function processProductAdJob(job) {
    console.log(`Processing product-ad job: ${(job.productTitle || '').slice(0, 60)} geo=${job.targetGeo || ''}`);

    const client = await pool.connect();
    let clipId;
    try {
        const inserted = await client.query(
            `INSERT INTO clips (client_id, source_platform, title, status)
             VALUES ($1, 'seedance', $2, 'processing') RETURNING id`,
            [job.clientId || null,
             job.productTitle ? `Ad: ${String(job.productTitle).slice(0, 60)}` : 'Product ad']
        );
        clipId = inserted.rows[0].id;
    } finally {
        client.release();
    }

    try {
        const seg = await productAd.generateProductAd({ ...job, clipId });

        if (!seg || seg.status === 'skipped' || !seg.path) {
            await setClipStatus(clipId, 'failed', { error: seg && seg.reason ? seg.reason : 'no ad produced' });
            return { clipId, status: 'failed', reason: seg && seg.reason };
        }

        await setClipStatus(clipId, 'pending_review', {
            producedAt: new Date().toISOString(),
            job: reQueueable(job),
            type: 'product_ad',
            clipPath: seg.path,
            provider: seg.provider || 'seedance',
            model: seg.model,
            captions: seg.captions || { status: 'n/a' },
            product: {
                title: job.productTitle || null,
                price: job.price || null,
                images: job.productImageUrls || (job.productImageUrl ? [job.productImageUrl] : []),
                supplierUrl: job.supplierUrl || null
            },
            targetGeo: job.targetGeo || null,
            targetLang: job.targetLang || null,
            storeUrl: job.storeUrl || null,
            utm: buildUtm(job, clipId),
            platforms: job.platforms || ['tiktok', 'instagram']
        });

        console.log(`Product ad generated, awaiting review: ${clipId}`);
        return { clipId, status: 'pending_review' };
    } catch (error) {
        console.error(`Product ad generation failed (${clipId}): ${error.message}`);
        if (clipId) await setClipStatus(clipId, 'failed', { error: error.message });
        return { clipId, status: 'failed', error: error.message };
    }
}

// Grab a still from a produced clip so the review queue is scannable at a glance
// (a wall of identical placeholders tells the operator nothing). Best-effort:
// any failure just means no poster, never a failed clip.
// (extractPoster now lives in src/production/poster.js — shared with the API,
// which generates posters on demand for clips produced before they existed.)

// Strip the transient bits and keep what's needed to re-queue this exact job.
// Without this a re-roll can't reproduce a reel/spec-ad, since the brief that
// created them lived only in the queue message.
function reQueueable(job = {}) {
    const { queuedAt, clipId, ...rest } = job;
    return rest;
}

// Update a clip's status + merge metadata.
// When a clip first lands in the review gate we also extract a poster frame, so
// every production path (clip/reel/spec-ad/product-ad) gets one for free.
async function setClipStatus(clipId, status, metaPatch = {}) {
    if (status === 'pending_review' && metaPatch.clipPath && !metaPatch.poster) {
        const poster = await extractPoster(metaPatch.clipPath);
        if (poster) metaPatch = { ...metaPatch, poster };

        // Push the media to R2 when configured. Free egress there, and the box
        // stops being the single copy. Best-effort: a failure just means the
        // local file keeps serving.
        if (r2.isConfigured()) {
            const [clipKey, posterKey] = await Promise.all([
                r2.uploadAsset(metaPatch.clipPath, `clips/${clipId}`),
                metaPatch.poster ? r2.uploadAsset(metaPatch.poster, `clips/${clipId}`) : Promise.resolve(null)
            ]);
            if (clipKey) metaPatch = { ...metaPatch, r2Key: clipKey };
            if (posterKey) metaPatch = { ...metaPatch, r2PosterKey: posterKey };
        }
    }
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE clips
             SET status = $1,
                 metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
             WHERE id = $3`,
            [status, JSON.stringify(metaPatch), clipId]
        );
    } finally {
        client.release();
    }
}

// Append the store link (with per-platform UTM) to a caption, for product ads.
// No-op when the job carries no storeUrl.
function buildLinkedCaption(caption, job, platform) {
    if (!job.storeUrl) return caption;
    const sep = job.storeUrl.includes('?') ? '&' : '?';
    const utm = job.utm ? sep + String(job.utm).replace(/\{platform\}/g, platform) : '';
    const link = `${job.storeUrl}${utm}`;
    return caption ? `${caption}\n\n🛒 ${link}` : link;
}

// Process posting jobs (approved clips → Mobile-Use posts on real devices).
// Enqueued by the approval endpoint, never automatically.
async function processPostJob(job) {
    console.log(`Processing post job: clip=${job.clipId} platforms=${(job.platforms || []).join(',')}`);

    const clipPath = job.clipPath;
    const caption = job.caption || job.title || '';
    const platforms = job.platforms && job.platforms.length ? job.platforms : ['tiktok'];

    const live = await ensureMobileUse();
    const results = [];

    for (const platform of platforms) {
        try {
            let result;
            const linkedCaption = buildLinkedCaption(caption, job, platform);
            if (!live) {
                result = { success: true, dryRun: true };
                console.log(`[dry-run] would post ${clipPath} to ${platform}${job.storeUrl ? ` (link: ${job.storeUrl})` : ''}`);
            } else {
                // Pick a device for this platform
                const deviceId = await mobileuse.pickDevice(platform);
                if (!deviceId) {
                    throw new Error(`no device available for ${platform}`);
                }
                result = await posting.postClip({
                    clipId: job.clipId,
                    clipPath,
                    caption: linkedCaption,
                    platform,
                    deviceId,
                    mobileuse
                });
            }
            results.push({ platform, ...result });
        } catch (error) {
            console.error(`Post to ${platform} failed: ${error.message}`);
            results.push({ platform, success: false, error: error.message });
        }
    }

    const anyPosted = results.some(r => r.success);
    await setClipStatus(job.clipId, anyPosted ? 'posted' : 'failed', {
        postResults: results,
        postedAt: anyPosted ? new Date().toISOString() : undefined,
        dryRun: !live
    });

    if (anyPosted) {
        const client = await pool.connect();
        try {
            await client.query(
                `UPDATE clips SET platforms_posted = $1, posted_at = NOW() WHERE id = $2`,
                [results.filter(r => r.success).map(r => r.platform), job.clipId]
            );
        } finally {
            client.release();
        }
    }

    return { clipId: job.clipId, results };
}

// Process outreach jobs (human-APPROVED DMs → Mobile-Use sends from real device).
// Only reaches here after /api/outreach/:id/approve. Dry-runs without Mobile-Use.
async function processOutreachJob(job) {
    console.log(`Processing outreach job: ${job.targetHandle} (${job.targetPlatform})`);

    const live = await ensureMobileUse();
    let result;
    try {
        if (!live) {
            result = { success: true, dryRun: true };
            console.log(`[dry-run] would DM ${job.targetHandle} on ${job.targetPlatform}`);
        } else {
            const platform = String(job.targetPlatform || 'tiktok').toLowerCase();
            const deviceId = await mobileuse.pickDevice(platform);
            if (!deviceId) throw new Error('no device available for outreach');
            // Use engagement producer's DM executor (handles rate limiting)
            result = await engagement.executeDM({
                deviceId,
                platform,
                targetUsername: job.targetHandle,
                dmText: job.message,
                mobileuse
            });
        }
    } catch (error) {
        console.error(`Outreach send failed (${job.targetHandle}): ${error.message}`);
        result = { success: false, error: error.message };
    }

    // Update the existing staged row (created by /api/outreach/send).
    const dbClient = await pool.connect();
    try {
        if (job.messageId) {
            await dbClient.query(
                `UPDATE outreach_messages
                 SET status = $1, message_sent_at = $2
                 WHERE id = $3`,
                [result.success ? 'sent' : 'failed',
                 result.success ? new Date().toISOString() : null,
                 job.messageId]
            );
        } else {
            // Fallback for ad-hoc jobs without a staged row.
            await dbClient.query(
                `INSERT INTO outreach_messages
                 (target_handle, target_platform, message_content, message_sent_at, status)
                 VALUES ($1, $2, $3, $4, $5)`,
                [job.targetHandle, job.targetPlatform, job.message,
                 result.success ? new Date().toISOString() : null,
                 result.success ? 'sent' : 'failed']
            );
        }
    } finally {
        dbClient.release();
    }

    console.log(`Outreach ${result.success ? 'sent' : 'failed'}: ${job.targetHandle}`);
    return { targetHandle: job.targetHandle, ...result };
}

// Process engagement jobs (scan comments → propose replies/DMs → human gate).
// Scans comments on a posted clip, keyword-matches buying intent, proposes
// replies + DMs. Proposals land in the engagement review queue for human
// approval (stored in clips.metadata.engagement). Degrades gracefully.
async function processEngagementJob(job) {
    console.log(`Processing engagement job: clip=${job.clipId} platform=${job.platform || 'tiktok'}`);

    const live = await ensureMobileUse();
    if (!live) {
        console.log(`[dry-run] Mobile-Use not reachable, skipping engagement scan`);
        return { clipId: job.clipId, status: 'skipped', reason: 'mobileuse_not_alive' };
    }

    try {
        const deviceId = job.deviceId || await mobileuse.pickDevice(job.platform || 'tiktok');
        if (!deviceId) {
            return { clipId: job.clipId, status: 'skipped', reason: 'no_device' };
        }

        const scanResult = await engagement.scanAndPropose({
            deviceId,
            platform: job.platform || 'tiktok',
            clipUrl: job.clipUrl || null,
            clipId: job.clipId,
            link: job.link || job.storeUrl || null,
            mobileuse
        });

        if (!scanResult) {
            return { clipId: job.clipId, status: 'skipped', reason: 'scan_failed' };
        }

        // Store proposed engagement actions in clips.metadata for human review.
        // The API engagement endpoints read from here.
        if (scanResult.proposals.length > 0) {
            const dbClient = await pool.connect();
            try {
                const existing = await dbClient.query(
                    'SELECT metadata FROM clips WHERE id = $1', [job.clipId]
                );
                const meta = existing.rows[0]?.metadata || {};
                const prevEngagement = meta.engagement || { pending: [] };
                prevEngagement.pending = [...(prevEngagement.pending || []), ...scanResult.proposals];
                await dbClient.query(
                    `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                    [JSON.stringify({ engagement: prevEngagement }), job.clipId]
                );
            } finally {
                dbClient.release();
            }
        }

        console.log(`Engagement scan: ${scanResult.comments.length} comments, ${scanResult.matched.length} matched, ${scanResult.proposals.length} proposed`);
        return {
            clipId: job.clipId,
            status: 'scanned',
            commentsFound: scanResult.comments.length,
            matched: scanResult.matched.length,
            proposed: scanResult.proposals.length
        };
    } catch (error) {
        console.error(`Engagement scan failed (${job.clipId}): ${error.message}`);
        return { clipId: job.clipId, status: 'failed', error: error.message };
    }
}

// Process onboarding jobs
async function processOnboardingJob(job) {
    console.log(`Processing onboarding: ${job.email}`);

    // (Creator intelligence on new clients is now an operator-agent task via
    // connected MCP servers, not an inline subprocess call.)

    // Queue initial clips for processing
    await redis.lpush('clip_queue', JSON.stringify({
        clientId: job.email,
        sourceUrl: 'onboarding_initial',
        platforms: ['tiktok'],
        queuedAt: new Date().toISOString()
    }));

    return { status: 'onboarded', email: job.email };
}

// Process analytics jobs
async function processAnalyticsJob(job) {
    console.log(`Processing analytics: ${job.clientId}`);

    const dbClient = await pool.connect();
    try {
        // Calculate revenue for client
        const result = await dbClient.query(
            `SELECT SUM(revenue_generated) as total_revenue
             FROM clips WHERE client_id = $1`,
            [job.clientId]
        );

        const totalRevenue = result.rows[0]?.total_revenue || 0;

        // Record analytics
        await dbClient.query(
            `INSERT INTO analytics
             (client_id, metric_type, metric_value)
             VALUES ($1, 'total_revenue', $2)`,
            [job.clientId, totalRevenue]
        );

        return { clientId: job.clientId, totalRevenue };
    } finally {
        dbClient.release();
    }
}

// Worker loop.
// Each consumer gets its OWN Redis connection: BRPOP is blocking, and multiple
// blocking commands on one shared connection serialize, stalling other queues
// up to the timeout each cycle. A dedicated connection per queue keeps them
// genuinely concurrent.
async function runWorker(queueName, processor) {
    console.log(`Starting worker for queue: ${queueName}`);
    const conn = redis.duplicate();

    while (true) {
        try {
            // Blocking pop from queue
            const job = await conn.brpop(queueName, 5);

            if (job) {
                const jobData = JSON.parse(job[1]);
                await processor(jobData);
            }
        } catch (error) {
            console.error(`Worker error (${queueName}): ${error.message}`);
            // Exponential backoff on error
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Main worker initialization
async function main() {
    console.log('ClipForge Worker starting...');

    // Device-touching queues (post/outreach/engagement) run wherever Mobile-Use
    // is: on the operator's DESKTOP, never the VPS (no phones). With
    // POST_EXECUTOR=desktop the worker SKIPS those consumers and the Tauri
    // desktop bridge claims them via /api/bridge/* instead. Default 'worker'
    // preserves the old behavior for a machine that has phones + the worker.
    const deviceOnDesktop = process.env.POST_EXECUTOR === 'desktop';
    if (deviceOnDesktop) {
        console.log('POST_EXECUTOR=desktop → worker defers post/outreach/engagement to the desktop bridge');
    }

    const workers = [
        runWorker(queues.clip, processClipJob),
        runWorker(queues.generate, processGenerateJob),
        runWorker(queues.reel, processReelJob),
        runWorker(queues.productAd, processProductAdJob),
        runWorker(queues.onboarding, processOnboardingJob),
        runWorker(queues.analytics, processAnalyticsJob)
    ];
    if (!deviceOnDesktop) {
        workers.push(
            runWorker(queues.post, processPostJob),
            runWorker(queues.outreach, processOutreachJob),
            runWorker(queues.engagement, processEngagementJob)
        );
    }

    await Promise.all(workers);
}

main().catch(error => {
    console.error('Worker crashed:', error);
    process.exit(1);
});
