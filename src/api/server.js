/**
 * ClipForge API Server
 * Main Express server with all routes and middleware
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const Redis = require('ioredis');
const WhopIntegration = require('../integration/whop');

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
