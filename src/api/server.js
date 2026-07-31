/**
 * ClipForge API Server
 * Main Express server with all routes and middleware
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const Redis = require('ioredis');
const WhopIntegration = require('../integration/whop');
const mobileuse = require('../integration/mobileuse');
const engagementProducer = require('../production/engagement');

const app = express();

// Configuration
const config = {
    whop: {
        apiKey: process.env.WHOP_API_KEY,
        merchantId: process.env.WHOP_MERCHANT_ID,
        webhookSecret: process.env.WHOP_WEBHOOK_SECRET,
        defaultCommission: parseInt(process.env.WHOP_DEFAULT_COMMISSION) || 30,
        referralCommission: parseInt(process.env.WHOP_REFERRAL_COMMISSION) || 25
    }
};

// Initialize integrations
const whop = new WhopIntegration(config.whop);

// Database connection
const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD
});

// Redis connection
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    db: process.env.REDIS_DB
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

// White-label branding, driven entirely by env (one deploy = one brand).
const brand = {
    name: process.env.BRAND_NAME || 'ClipForge',
    domain: process.env.BRAND_DOMAIN || process.env.DOMAIN || '',
    supportEmail: process.env.BRAND_SUPPORT_EMAIL || '',
    primaryColor: process.env.BRAND_PRIMARY_COLOR || '#5b8def'
};

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', brand: brand.name, timestamp: new Date().toISOString() });
});

// Branding surface (for a white-label front-end / reseller dashboard).
app.get('/api/brand', (req, res) => {
    res.json(brand);
});

// ============================================
// WHOP WEBHOOK ENDPOINTS
// ============================================

app.post('/api/webhooks/whop', async (req, res) => {
    try {
        const signature = req.headers['x-whop-signature'];

        // Verify webhook signature
        if (!whop.verifyWebhookSignature(JSON.stringify(req.body), signature)) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const result = await whop.processWebhookEvent(req.body);

        // Take action based on event type
        if (result.action === 'activate_client') {
            await activateClient(result);
        } else if (result.action === 'deactivate_client') {
            await deactivateClient(result);
        } else if (result.action === 'update_tier') {
            await updateClientTier(result);
        } else if (result.action === 'notify_client') {
            await notifyClient(result);
        } else if (result.action === 'suspend_service') {
            await suspendService(result);
        }

        res.json({ received: true, action: result.action });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ============================================
// WHOP SUBSCRIPTIONS
// ============================================

app.get('/api/subscriptions', async (req, res) => {
    try {
        const subscriptions = await whop.listSubscriptions({ status: 'active' });
        res.json({ subscriptions });
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

app.get('/api/subscriptions/:id', async (req, res) => {
    try {
        const subscription = await whop.getSubscription(req.params.id);
        res.json(subscription);
    } catch (error) {
        console.error('Error fetching subscription:', error);
        res.status(500).json({ error: 'Failed to fetch subscription' });
    }
});

// ============================================
// AFFILIATE ENDPOINTS
// ============================================

app.get('/api/affiliates/stats', async (req, res) => {
    try {
        const affiliateId = req.query.affiliateId;
        if (!affiliateId) {
            return res.status(400).json({ error: 'Affiliate ID required' });
        }

        const stats = await whop.getAffiliateStats(affiliateId);
        res.json(stats);
    } catch (error) {
        console.error('Error fetching affiliate stats:', error);
        res.status(500).json({ error: 'Failed to fetch affiliate stats' });
    }
});

app.post('/api/affiliates/link', async (req, res) => {
    try {
        const { whopId, affiliateId } = req.body;
        const link = await whop.createAffiliateLink(whopId, affiliateId);
        res.json({ link });
    } catch (error) {
        console.error('Error creating affiliate link:', error);
        res.status(500).json({ error: 'Failed to create affiliate link' });
    }
});

app.post('/api/affiliates/commission', async (req, res) => {
    try {
        const { whopId, email, commission } = req.body;
        await whop.setCustomCommission(whopId, email, commission);
        res.json({ success: true });
    } catch (error) {
        console.error('Error setting commission:', error);
        res.status(500).json({ error: 'Failed to set commission' });
    }
});

// Intelligence (search/trends/discover/creator-lead discovery) has moved OUT of
// ClipForge: the operator agent does it through connected MCP servers
// (ScrapeCreators, Apify, Exa, Perplexity) and pushes vetted leads in via
// stage_outreach. No in-app subprocess. See docs/OPERATE.md.

// ============================================
// PRODUCTION ENDPOINTS
// ============================================

app.post('/api/clips/generate', async (req, res) => {
    try {
        const { clientId, sourceUrl, sourcePath, segments, platforms } = req.body;

        // Queue clip generation job. sourcePath clips an already-local file
        // (uploaded asset or smoke test); sourceUrl downloads via yt-dlp.
        await redis.lpush('clip_queue', JSON.stringify({
            clientId,
            sourceUrl,
            sourcePath,
            segments,
            platforms: platforms || ['tiktok', 'youtube'],
            queuedAt: new Date().toISOString()
        }));

        res.json({ status: 'queued', message: 'Clip generation job queued' });
    } catch (error) {
        console.error('Clip generation error:', error);
        res.status(500).json({ error: 'Failed to queue clip generation' });
    }
});

// SMB spec-ad generation (no source footage → Higgsfield). Lands in review queue.
app.post('/api/specads/generate', async (req, res) => {
    try {
        const { clientId, brief, productUrl, platforms, premium, title } = req.body || {};
        if (!brief && !productUrl) {
            return res.status(400).json({ error: 'Provide a brief or a productUrl' });
        }

        await redis.lpush('generate_queue', JSON.stringify({
            clientId,
            brief,
            productUrl,
            title,
            platforms: platforms || ['tiktok', 'instagram'],
            premium: !!premium,
            queuedAt: new Date().toISOString()
        }));

        res.json({ status: 'queued', message: 'Spec-ad generation queued' });
    } catch (error) {
        console.error('Spec-ad generation error:', error);
        res.status(500).json({ error: 'Failed to queue spec-ad generation' });
    }
});

// Free stock-footage reel (no source footage → Pexels/Pixabay). Lands in review queue.
app.post('/api/reels/generate', async (req, res) => {
    try {
        const { clientId, brief, script, keywords, platforms, title, sceneDuration, maxScenes } = req.body || {};
        if (!brief && !script) {
            return res.status(400).json({ error: 'Provide a brief or a script' });
        }

        await redis.lpush('reel_queue', JSON.stringify({
            clientId, brief, script, keywords, title, sceneDuration, maxScenes,
            platforms: platforms || ['tiktok', 'instagram'],
            queuedAt: new Date().toISOString()
        }));

        res.json({ status: 'queued', message: 'Stock reel generation queued' });
    } catch (error) {
        console.error('Reel generation error:', error);
        res.status(500).json({ error: 'Failed to queue reel generation' });
    }
});

// Product-ad generation (dropship path, product photo → Seedance). Lands in review queue.
app.post('/api/productads/generate', async (req, res) => {
    try {
        const { clientId, productTitle, productImageUrl, productImageUrls, price,
                targetGeo, targetLang, angle, storeUrl, supplierUrl, platforms } = req.body || {};
        const images = productImageUrls || (productImageUrl ? [productImageUrl] : []);
        if (!images.length) {
            return res.status(400).json({ error: 'Provide productImageUrl or productImageUrls' });
        }

        await redis.lpush('product_ad_queue', JSON.stringify({
            clientId, productTitle, productImageUrls: images, price,
            targetGeo, targetLang, angle, storeUrl, supplierUrl,
            platforms: platforms || ['tiktok', 'instagram'],
            queuedAt: new Date().toISOString()
        }));

        res.json({ status: 'queued', message: 'Product-ad generation queued' });
    } catch (error) {
        console.error('Product-ad generation error:', error);
        res.status(500).json({ error: 'Failed to queue product-ad generation' });
    }
});

app.get('/api/clips/queue', async (req, res) => {
    try {
        const queueLength = await redis.llen('clip_queue');
        const pending = await redis.lrange('clip_queue', 0, -1);

        res.json({
            queueLength,
            pending: pending.map(item => JSON.parse(item))
        });
    } catch (error) {
        console.error('Queue fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch queue' });
    }
});

// ---- Human-in-the-loop review gate ----

// Clips waiting for a human to approve or reject before anything posts.
app.get('/api/clips/review-queue', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(
                `SELECT id, client_id, title, source_url, status, metadata, created_at
                 FROM clips WHERE status = 'pending_review'
                 ORDER BY created_at ASC`
            );
            res.json({ count: result.rows.length, clips: result.rows });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Review queue error:', error);
        res.status(500).json({ error: 'Failed to fetch review queue' });
    }
});

// Approve a clip → enqueue it for posting via the farm. Only path that posts.
app.post('/api/clips/:id/approve', async (req, res) => {
    try {
        const { platforms, caption, tier } = req.body || {};
        const client = await pool.connect();
        try {
            const result = await client.query(
                `SELECT * FROM clips WHERE id = $1`, [req.params.id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Clip not found' });
            }
            const clip = result.rows[0];
            if (clip.status !== 'pending_review') {
                return res.status(409).json({ error: `Clip is '${clip.status}', not 'pending_review'` });
            }

            const meta = clip.metadata || {};
            const clipPath = meta.clipPath;
            if (!clipPath) {
                return res.status(422).json({ error: 'Clip has no rendered file to post' });
            }

            await client.query(
                `UPDATE clips SET status = 'approved',
                 metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
                 WHERE id = $2`,
                [JSON.stringify({ approvedAt: new Date().toISOString() }), clip.id]
            );

            await redis.lpush('post_queue', JSON.stringify({
                clipId: clip.id,
                clipPath,
                caption: caption || clip.title || '',
                platforms: platforms || meta.platforms || ['tiktok'],
                tier: tier || 1,
                // Product ads post with the store link (with per-platform UTM).
                storeUrl: meta.storeUrl || null,
                utm: meta.utm || null,
                queuedAt: new Date().toISOString()
            }));

            res.json({ status: 'approved', clipId: clip.id, queuedForPosting: true });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Approve error:', error);
        res.status(500).json({ error: 'Failed to approve clip' });
    }
});

// Reject a clip → nothing posts; record the reason.
app.post('/api/clips/:id/reject', async (req, res) => {
    try {
        const { reason } = req.body || {};
        const client = await pool.connect();
        try {
            const result = await client.query(
                `UPDATE clips SET status = 'rejected',
                 metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
                 WHERE id = $2 AND status = 'pending_review'
                 RETURNING id`,
                [JSON.stringify({ rejectedAt: new Date().toISOString(), rejectReason: reason || null }), req.params.id]
            );
            if (result.rows.length === 0) {
                return res.status(409).json({ error: 'Clip not found or not in pending_review' });
            }
            res.json({ status: 'rejected', clipId: result.rows[0].id });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Reject error:', error);
        res.status(500).json({ error: 'Failed to reject clip' });
    }
});

app.get('/api/clips/:id/status', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(
                'SELECT * FROM clips WHERE id = $1',
                [req.params.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Clip not found' });
            }

            res.json(result.rows[0]);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Clip status error:', error);
        res.status(500).json({ error: 'Failed to fetch clip status' });
    }
});

// ============================================
// OUTREACH ENDPOINTS
// ============================================

// Stage an outreach DM as a draft awaiting human review. Does NOT send.
// A person approves via /api/outreach/:id/approve before the farm touches it.
app.post('/api/outreach/send', async (req, res) => {
    try {
        const { targetHandle, targetPlatform, message, clientId, campaignId } = req.body;
        if (!targetHandle || !message) {
            return res.status(400).json({ error: 'targetHandle and message are required' });
        }

        const client = await pool.connect();
        try {
            const result = await client.query(
                `INSERT INTO outreach_messages
                 (campaign_id, client_id, target_handle, target_platform, message_content, status)
                 VALUES ($1, $2, $3, $4, $5, 'pending_review')
                 RETURNING id`,
                [campaignId || null, clientId || null, targetHandle, targetPlatform || null, message]
            );
            res.json({ status: 'pending_review', messageId: result.rows[0].id });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Outreach error:', error);
        res.status(500).json({ error: 'Failed to stage outreach message' });
    }
});

// DMs waiting for a human to approve or reject before the farm sends them.
app.get('/api/outreach/review-queue', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(
                `SELECT id, campaign_id, client_id, target_handle, target_platform,
                        message_content, created_at
                 FROM outreach_messages WHERE status = 'pending_review'
                 ORDER BY created_at ASC`
            );
            res.json({ count: result.rows.length, messages: result.rows });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Outreach review queue error:', error);
        res.status(500).json({ error: 'Failed to fetch outreach review queue' });
    }
});

// Approve a DM → enqueue for the farm to send. Optionally override the text.
app.post('/api/outreach/:id/approve', async (req, res) => {
    try {
        const { message, tier } = req.body || {};
        const client = await pool.connect();
        try {
            const result = await client.query(
                `SELECT * FROM outreach_messages WHERE id = $1`, [req.params.id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Message not found' });
            }
            const msg = result.rows[0];
            if (msg.status !== 'pending_review') {
                return res.status(409).json({ error: `Message is '${msg.status}', not 'pending_review'` });
            }

            const finalText = message || msg.message_content;
            await client.query(
                `UPDATE outreach_messages SET status = 'approved', message_content = $1 WHERE id = $2`,
                [finalText, msg.id]
            );

            await redis.lpush('outreach_queue', JSON.stringify({
                messageId: msg.id,
                targetHandle: msg.target_handle,
                targetPlatform: msg.target_platform,
                message: finalText,
                clientId: msg.client_id,
                tier: tier || 1,
                queuedAt: new Date().toISOString()
            }));

            res.json({ status: 'approved', messageId: msg.id, queuedForSending: true });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Outreach approve error:', error);
        res.status(500).json({ error: 'Failed to approve outreach message' });
    }
});

// Reject a DM → nothing sends; record the reason.
app.post('/api/outreach/:id/reject', async (req, res) => {
    try {
        const { reason } = req.body || {};
        const client = await pool.connect();
        try {
            const result = await client.query(
                `UPDATE outreach_messages SET status = 'rejected',
                 response_content = COALESCE($1, response_content)
                 WHERE id = $2 AND status = 'pending_review'
                 RETURNING id`,
                [reason ? `[rejected] ${reason}` : null, req.params.id]
            );
            if (result.rows.length === 0) {
                return res.status(409).json({ error: 'Message not found or not in pending_review' });
            }
            res.json({ status: 'rejected', messageId: result.rows[0].id });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Outreach reject error:', error);
        res.status(500).json({ error: 'Failed to reject outreach message' });
    }
});

app.get('/api/outreach/analytics', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(`
                SELECT
                    COUNT(*) as total_sent,
                    SUM(CASE WHEN response_received THEN 1 ELSE 0 END) as responses,
                    SUM(CASE WHEN converted THEN 1 ELSE 0 END) as conversions
                FROM outreach_messages
            `);

            res.json(result.rows[0]);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ============================================
// MOBILE-USE DEVICE & ENGAGEMENT ENDPOINTS
// ============================================

// List connected ADB devices via Mobile-Use.
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await mobileuse.listDevices();
        if (devices === null) {
            return res.json({ devices: [], reachable: false, message: 'Mobile-Use server not reachable' });
        }
        res.json({ devices, reachable: true, count: devices.length });
    } catch (error) {
        console.error('Device list error:', error);
        res.status(500).json({ error: 'Failed to list devices' });
    }
});

// Fetch comments on a posted clip via Mobile-Use.
app.post('/api/posts/:clipId/comments', async (req, res) => {
    try {
        const { deviceId, platform, clipUrl } = req.body || {};
        if (!deviceId) {
            return res.status(400).json({ error: 'deviceId required' });
        }

        const comments = await engagementProducer.scanComments({
            deviceId,
            platform: platform || 'tiktok',
            clipUrl,
            mobileuse
        });

        if (comments === null) {
            return res.json({ comments: [], reachable: false, message: 'Mobile-Use server not reachable' });
        }
        res.json({ comments, count: comments.length, reachable: true });
    } catch (error) {
        console.error('Comment fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// Scan comments + propose replies/DMs (keyword match). Queues an engagement job.
app.post('/api/posts/:clipId/scan', async (req, res) => {
    try {
        const { platform, deviceId, clipUrl, link } = req.body || {};

        // Look up clip metadata for link if not provided
        let storeLink = link;
        let plat = platform || 'tiktok';
        let url = clipUrl || null;
        const dbClient = await pool.connect();
        try {
            const result = await dbClient.query('SELECT metadata FROM clips WHERE id = $1', [req.params.clipId]);
            if (result.rows.length > 0) {
                const meta = result.rows[0].metadata || {};
                if (!storeLink) storeLink = meta.storeUrl || null;
                if (!platform) plat = (meta.platforms_posted || meta.platforms || ['tiktok'])[0];
                if (!url) url = meta.clipUrl || null;
            }
            // Persist the post URL so approved replies can target THIS video
            // instead of "the most recent post" (which may be a newer clip).
            if (url) {
                await dbClient.query(
                    `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                    [JSON.stringify({ clipUrl: url }), req.params.clipId]
                );
            }
        } finally {
            dbClient.release();
        }

        await redis.lpush('engagement_queue', JSON.stringify({
            clipId: req.params.clipId,
            platform: plat,
            deviceId: deviceId || null,
            clipUrl: url,
            link: storeLink,
            queuedAt: new Date().toISOString()
        }));

        res.json({ status: 'queued', clipId: req.params.clipId, message: 'Engagement scan queued' });
    } catch (error) {
        console.error('Engagement scan queue error:', error);
        res.status(500).json({ error: 'Failed to queue engagement scan' });
    }
});

// Propose a reply to a comment (stages for human review, does NOT post).
app.post('/api/posts/:clipId/reply', async (req, res) => {
    try {
        const { comment, link } = req.body || {};
        if (!comment || !comment.username || !comment.text) {
            return res.status(400).json({ error: 'comment with username+text required' });
        }

        const proposal = engagementProducer.proposeReply(comment, { link });

        // Store in clip metadata
        const dbClient = await pool.connect();
        try {
            const result = await dbClient.query('SELECT metadata FROM clips WHERE id = $1', [req.params.clipId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Clip not found' });
            }
            const meta = result.rows[0].metadata || {};
            const eng = meta.engagement || { pending: [] };
            eng.pending = [...(eng.pending || []), {
                clipId: req.params.clipId,
                comment,
                replyText: proposal.replyText,
                type: 'reply',
                status: 'pending_review',
                createdAt: new Date().toISOString()
            }];
            await dbClient.query(
                `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                [JSON.stringify({ engagement: eng }), req.params.clipId]
            );
        } finally {
            dbClient.release();
        }

        res.json({ status: 'pending_review', proposal: proposal.replyText });
    } catch (error) {
        console.error('Reply proposal error:', error);
        res.status(500).json({ error: 'Failed to propose reply' });
    }
});

// Propose a DM to a commenter (stages for human review, does NOT send).
app.post('/api/posts/:clipId/dm', async (req, res) => {
    try {
        const { comment, link } = req.body || {};
        if (!comment || !comment.username || !comment.text) {
            return res.status(400).json({ error: 'comment with username+text required' });
        }

        const proposal = engagementProducer.proposeDM(comment, { link });

        // Store in clip metadata
        const dbClient = await pool.connect();
        try {
            const result = await dbClient.query('SELECT metadata FROM clips WHERE id = $1', [req.params.clipId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Clip not found' });
            }
            const meta = result.rows[0].metadata || {};
            const eng = meta.engagement || { pending: [] };
            eng.pending = [...(eng.pending || []), {
                clipId: req.params.clipId,
                comment,
                dmText: proposal.dmText,
                link: proposal.link,
                type: 'dm',
                status: 'pending_review',
                createdAt: new Date().toISOString()
            }];
            await dbClient.query(
                `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                [JSON.stringify({ engagement: eng }), req.params.clipId]
            );
        } finally {
            dbClient.release();
        }

        res.json({ status: 'pending_review', proposal: proposal.dmText });
    } catch (error) {
        console.error('DM proposal error:', error);
        res.status(500).json({ error: 'Failed to propose DM' });
    }
});

// List pending engagement actions (replies + DMs awaiting approval).
app.get('/api/engagement/queue', async (req, res) => {
    try {
        const dbClient = await pool.connect();
        try {
            const result = await dbClient.query(
                `SELECT id, metadata->'engagement' as engagement FROM clips
                 WHERE metadata->'engagement'->'pending' IS NOT NULL
                 ORDER BY created_at DESC`
            );
            const pending = [];
            for (const row of result.rows) {
                const eng = row.engagement || {};
                for (const item of (eng.pending || [])) {
                    if (item.status === 'pending_review') {
                        pending.push({ clipId: row.id, ...item });
                    }
                }
            }
            res.json({ count: pending.length, pending });
        } finally {
            dbClient.release();
        }
    } catch (error) {
        console.error('Engagement queue error:', error);
        res.status(500).json({ error: 'Failed to fetch engagement queue' });
    }
});

// Approve a pending engagement action (reply or DM) → Mobile-Use executes.
app.post('/api/engagement/:id/approve', async (req, res) => {
    try {
        const { clipId } = req.body || {};
        if (!clipId) {
            return res.status(400).json({ error: 'clipId required' });
        }

        const dbClient = await pool.connect();
        try {
            const result = await dbClient.query('SELECT metadata FROM clips WHERE id = $1', [clipId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Clip not found' });
            }
            const meta = result.rows[0].metadata || {};
            const eng = meta.engagement || { pending: [] };
            const item = (eng.pending || []).find(p => (p.id || p.createdAt) === req.params.id && p.status === 'pending_review');
            if (!item) {
                return res.status(404).json({ error: 'Engagement action not found or not pending' });
            }

            // Mark as approved
            item.status = 'approved';
            item.approvedAt = new Date().toISOString();
            await dbClient.query(
                `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                [JSON.stringify({ engagement: eng }), clipId]
            );

            // Both replies and DMs are DEVICE actions, so both go on the queue for
            // whoever owns the phones (the desktop bridge under POST_EXECUTOR=desktop).
            // Never call Mobile-Use from here — the VPS has no handsets attached.
            await redis.lpush('outreach_queue', JSON.stringify({
                type: item.type === 'dm' ? 'dm' : 'reply',
                messageId: null,
                clipId,
                engagementId: req.params.id,
                targetHandle: item.comment && item.comment.username,
                targetPlatform: item.platform || 'tiktok',
                message: item.type === 'dm' ? item.dmText : item.replyText,
                comment: item.comment || null,
                // Lets the device open THIS post to reply, rather than guessing
                // at "the most recent one" (which may be a newer clip).
                clipUrl: meta.clipUrl || null,
                queuedAt: new Date().toISOString()
            }));

            res.json({ status: 'approved', id: req.params.id, clipId });
        } finally {
            dbClient.release();
        }
    } catch (error) {
        console.error('Engagement approve error:', error);
        res.status(500).json({ error: 'Failed to approve engagement action' });
    }
});

// Reject a pending engagement action.
app.post('/api/engagement/:id/reject', async (req, res) => {
    try {
        const { clipId, reason } = req.body || {};
        if (!clipId) {
            return res.status(400).json({ error: 'clipId required' });
        }

        const dbClient = await pool.connect();
        try {
            const result = await dbClient.query('SELECT metadata FROM clips WHERE id = $1', [clipId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Clip not found' });
            }
            const meta = result.rows[0].metadata || {};
            const eng = meta.engagement || { pending: [] };
            const item = (eng.pending || []).find(p => (p.id || p.createdAt) === req.params.id && p.status === 'pending_review');
            if (!item) {
                return res.status(404).json({ error: 'Engagement action not found or not pending' });
            }

            item.status = 'rejected';
            item.rejectedAt = new Date().toISOString();
            item.rejectReason = reason || null;
            await dbClient.query(
                `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                [JSON.stringify({ engagement: eng }), clipId]
            );

            res.json({ status: 'rejected', id: req.params.id, clipId });
        } finally {
            dbClient.release();
        }
    } catch (error) {
        console.error('Engagement reject error:', error);
        res.status(500).json({ error: 'Failed to reject engagement action' });
    }
});

// ============================================
// DESKTOP BRIDGE (Mobile-Use runs on the operator's laptop, not the VPS)
// ============================================
// AUTH: these routes claim (destructively pop) jobs, stream produced media, and
// mark clips posted, and the desktop reaches them over the tailnet / a Traefik
// route — not localhost. So they require a shared secret. Fails CLOSED: with no
// BRIDGE_TOKEN/API_SECRET configured, the bridge is disabled rather than open.
function requireBridgeAuth(req, res, next) {
    const expected = process.env.BRIDGE_TOKEN || process.env.API_SECRET || '';
    if (!expected) {
        return res.status(503).json({ error: 'Bridge disabled: set BRIDGE_TOKEN (or API_SECRET)' });
    }
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : header;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}
app.use('/api/bridge', requireBridgeAuth);

// The VPS produces + gates; it cannot touch phones. The Tauri desktop app runs
// Mobile-Use locally and CLAIMS device jobs here, executes them on real phones,
// downloads the clip file, and REPORTS results back. Enabled by POST_EXECUTOR=desktop
// (the VPS worker then skips the post_queue consumer — see worker/index.js).

// Claim the next approved post job (atomic RPOP off post_queue). Marks the clip
// 'posting' and returns the job plus a file URL the desktop downloads from.
app.get('/api/bridge/posts/claim', async (req, res) => {
    try {
        const raw = await redis.rpop('post_queue');
        if (!raw) return res.json({ job: null });
        const job = JSON.parse(raw);
        if (job.clipId) {
            const c = await pool.connect();
            try {
                await c.query(
                    `UPDATE clips SET status = 'posting',
                     metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
                     WHERE id = $2 AND status = 'approved'`,
                    [JSON.stringify({ claimedBy: req.query.device || 'desktop', claimedAt: new Date().toISOString() }), job.clipId]
                );
            } finally { c.release(); }
        }
        job.fileUrl = job.clipId ? `/api/bridge/clips/${job.clipId}/file` : null;
        res.json({ job });
    } catch (error) {
        console.error('Bridge claim error:', error);
        res.status(500).json({ error: 'Failed to claim post job' });
    }
});

// Stream the produced mp4 for a clip so the desktop can hand it to Mobile-Use.
// Path comes from clips.metadata.clipPath and is confined to CLIP_DATA_DIR.
app.get('/api/bridge/clips/:id/file', async (req, res) => {
    try {
        const c = await pool.connect();
        let clipPath;
        try {
            const r = await c.query('SELECT metadata FROM clips WHERE id = $1', [req.params.id]);
            if (!r.rows.length) return res.status(404).json({ error: 'Clip not found' });
            clipPath = (r.rows[0].metadata || {}).clipPath;
        } finally { c.release(); }
        if (!clipPath) return res.status(404).json({ error: 'Clip has no rendered file' });

        // Confine to CLIP_DATA_DIR: append a separator so "/app/data" can't match
        // "/app/data-evil", and resolve symlinks (realpath) before comparing.
        const dataDir = path.resolve(process.env.CLIP_DATA_DIR || '/app/data') + path.sep;
        let real;
        try { real = fs.realpathSync(path.resolve(clipPath)); }
        catch { return res.status(404).json({ error: 'File not available' }); }
        if (!(real + path.sep).startsWith(dataDir)) {
            return res.status(404).json({ error: 'File not available' });
        }
        res.download(real);
    } catch (error) {
        console.error('Bridge file error:', error);
        res.status(500).json({ error: 'Failed to serve clip file' });
    }
});

// Desktop reports the outcome of a post job (mirrors the worker's status update).
app.post('/api/bridge/posts/:clipId/result', async (req, res) => {
    try {
        const { results } = req.body || {};
        if (!Array.isArray(results)) {
            return res.status(400).json({ error: 'results array required' });
        }
        const anyPosted = results.some(r => r && r.success);
        const c = await pool.connect();
        try {
            await c.query(
                `UPDATE clips SET status = $1,
                 metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                 WHERE id = $3`,
                [anyPosted ? 'posted' : 'failed',
                 JSON.stringify({ postResults: results, postedAt: anyPosted ? new Date().toISOString() : undefined, dryRun: false }),
                 req.params.clipId]
            );
            if (anyPosted) {
                await c.query(
                    `UPDATE clips SET platforms_posted = $1, posted_at = NOW() WHERE id = $2`,
                    [results.filter(r => r.success).map(r => r.platform), req.params.clipId]
                );
            }
        } finally { c.release(); }
        res.json({ status: anyPosted ? 'posted' : 'failed', clipId: req.params.clipId });
    } catch (error) {
        console.error('Bridge result error:', error);
        res.status(500).json({ error: 'Failed to record post result' });
    }
});

// ---- engagement scans (desktop reads the comments, VPS does the thinking) ----

// Claim the next comment-scan job.
app.get('/api/bridge/engagement/claim', async (req, res) => {
    try {
        const raw = await redis.rpop('engagement_queue');
        if (!raw) return res.json({ job: null });
        res.json({ job: JSON.parse(raw) });
    } catch (error) {
        console.error('Bridge engagement claim error:', error);
        res.status(500).json({ error: 'Failed to claim engagement job' });
    }
});

// Desktop reports the comments it read off the screen. Keyword matching and
// reply/DM drafting happen HERE (not on the desktop) so the device side stays a
// dumb executor and the logic lives in one place. Proposals land in
// clips.metadata.engagement.pending → the human gate at /api/engagement/queue.
app.post('/api/bridge/engagement/:clipId/result', async (req, res) => {
    try {
        const { comments, link, platform } = req.body || {};
        if (!Array.isArray(comments)) {
            return res.status(400).json({ error: 'comments array required' });
        }

        const matched = engagementProducer.matchKeywords(comments);
        const c = await pool.connect();
        try {
            const r = await c.query('SELECT metadata FROM clips WHERE id = $1', [req.params.clipId]);
            if (!r.rows.length) return res.status(404).json({ error: 'Clip not found' });

            const meta = r.rows[0].metadata || {};
            const storeLink = link || meta.storeUrl || null;
            const plat = platform || (meta.platforms_posted || meta.platforms || ['tiktok'])[0];
            const eng = meta.engagement || { pending: [] };
            const now = new Date().toISOString();

            for (const comment of matched) {
                // Propose BOTH a public reply and a DM per buying-intent comment;
                // the human approves each independently.
                const reply = engagementProducer.proposeReply(comment, { link: storeLink });
                const dm = engagementProducer.proposeDM(comment, { link: storeLink });
                eng.pending = [
                    ...(eng.pending || []),
                    { id: `${Date.now()}-r-${comment.username}`, clipId: req.params.clipId, platform: plat,
                      comment, replyText: reply.replyText, type: 'reply', status: 'pending_review', createdAt: now },
                    { id: `${Date.now()}-d-${comment.username}`, clipId: req.params.clipId, platform: plat,
                      comment, dmText: dm.dmText, link: dm.link, type: 'dm', status: 'pending_review', createdAt: now }
                ];
            }
            eng.lastScanAt = now;

            await c.query(
                `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                [JSON.stringify({ engagement: eng }), req.params.clipId]
            );
        } finally { c.release(); }

        res.json({ status: 'scanned', scanned: comments.length, matched: matched.length,
                   proposed: matched.length * 2 });
    } catch (error) {
        console.error('Bridge engagement result error:', error);
        res.status(500).json({ error: 'Failed to record engagement scan' });
    }
});

// ---- approved device actions: replies + DMs (human already said yes) ----

app.get('/api/bridge/actions/claim', async (req, res) => {
    try {
        const raw = await redis.rpop('outreach_queue');
        if (!raw) return res.json({ job: null });
        res.json({ job: JSON.parse(raw) });
    } catch (error) {
        console.error('Bridge action claim error:', error);
        res.status(500).json({ error: 'Failed to claim action' });
    }
});

// Desktop reports whether the reply/DM actually sent.
app.post('/api/bridge/actions/result', async (req, res) => {
    try {
        const { messageId, clipId, engagementId, success, error: errMsg } = req.body || {};
        const c = await pool.connect();
        try {
            // Cold-outreach rows live in outreach_messages.
            if (messageId) {
                await c.query(
                    `UPDATE outreach_messages SET status = $1, message_sent_at = $2 WHERE id = $3`,
                    [success ? 'sent' : 'failed', success ? new Date().toISOString() : null, messageId]
                );
            }
            // Engagement actions live inside clips.metadata.engagement.pending.
            if (clipId && engagementId) {
                const r = await c.query('SELECT metadata FROM clips WHERE id = $1', [clipId]);
                if (r.rows.length) {
                    const meta = r.rows[0].metadata || {};
                    const eng = meta.engagement || { pending: [] };
                    const item = (eng.pending || []).find(p => (p.id || p.createdAt) === engagementId);
                    if (item) {
                        item.status = success ? 'sent' : 'failed';
                        item.sentAt = success ? new Date().toISOString() : null;
                        if (errMsg) item.error = errMsg;
                        await c.query(
                            `UPDATE clips SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                            [JSON.stringify({ engagement: eng }), clipId]
                        );
                    }
                }
            }
        } finally { c.release(); }
        res.json({ status: success ? 'sent' : 'failed' });
    } catch (error) {
        console.error('Bridge action result error:', error);
        res.status(500).json({ error: 'Failed to record action result' });
    }
});

// ============================================
// CLIENT MANAGEMENT
// ============================================

app.get('/api/clients', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(
                'SELECT * FROM clients WHERE status = $1 ORDER BY created_at DESC',
                ['active']
            );
            res.json({ clients: result.rows });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Client fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch clients' });
    }
});

app.get('/api/clients/:id', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(
                'SELECT * FROM clients WHERE id = $1',
                [req.params.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Client not found' });
            }

            res.json(result.rows[0]);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Client fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch client' });
    }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function activateClient(result) {
    const client = await pool.connect();
    try {
        await client.query(
            `INSERT INTO clients (email, whop_customer_id, whop_subscription_id, status)
             VALUES ($1, $2, $3, 'active')
             ON CONFLICT (email) DO UPDATE
             SET whop_subscription_id = $3, status = 'active', updated_at = NOW()`,
            [result.email, result.customerId, result.subscriptionId]
        );

        // Queue onboarding job
        await redis.lpush('onboarding_queue', JSON.stringify({
            email: result.email,
            plan: result.plan,
            subscriptionId: result.subscriptionId
        }));

        console.log(`Client activated: ${result.email}`);
    } finally {
        client.release();
    }
}

async function deactivateClient(result) {
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE clients SET status = 'churned', updated_at = NOW()
             WHERE whop_subscription_id = $1`,
            [result.subscriptionId]
        );
        console.log(`Client deactivated: ${result.subscriptionId}`);
    } finally {
        client.release();
    }
}

async function updateClientTier(result) {
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE clients SET tier = $1, updated_at = NOW()
             WHERE whop_subscription_id = $2`,
            [result.newPlan, result.subscriptionId]
        );
        console.log(`Client tier updated: ${result.subscriptionId} -> ${result.newPlan}`);
    } finally {
        client.release();
    }
}

async function notifyClient(result) {
    // Implementation for notification (Slack, email, etc.)
    console.log(`Notification sent to customer: ${result.customerId}`);
}

async function suspendService(result) {
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE clients SET status = 'suspended', updated_at = NOW()
             WHERE whop_subscription_id = $1`,
            [result.subscriptionId]
        );
        console.log(`Service suspended: ${result.subscriptionId}`);
    } finally {
        client.release();
    }
}

// Start server. BIND_ADDRESS lets you bind to a Tailscale IP or 127.0.0.1 for
// zero public exposure (agents + MCP reach it locally / over the tailnet).
const PORT = process.env.PORT || 3000;
const HOST = process.env.BIND_ADDRESS || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`ClipForge API (${brand.name}) listening on ${HOST}:${PORT}`);
});

module.exports = app;
