/**
 * ClipForge MCP server.
 *
 * Exposes the ClipForge control surface as MCP tools so ANY agent runtime
 * (Claude Code, Codex, Pi) can operate the fleet through one interface and
 * report over its own channel (e.g. Telegram). Thin wrapper over the running
 * HTTP API — no business logic here, so it stays runtime-agnostic.
 *
 * Run:  node src/mcp/server.mjs   (stdio transport)
 * Env:  CLIPFORGE_API_URL   default http://localhost:3000
 *       CLIPFORGE_API_SECRET optional bearer, sent if set
 *
 * Wire into an agent's mcp config, e.g.:
 *   { "mcpServers": { "clipforge": { "command": "node",
 *       "args": ["/opt/clipforge/src/mcp/server.mjs"],
 *       "env": { "CLIPFORGE_API_URL": "http://localhost:3000" } } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.CLIPFORGE_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SECRET = process.env.CLIPFORGE_API_SECRET;

// One HTTP call → MCP content. Errors come back as isError text, never throw,
// so the agent sees a readable failure instead of a dead tool.
async function call(method, path, body) {
    try {
        const res = await fetch(`${API}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(SECRET ? { Authorization: `Bearer ${SECRET}` } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!res.ok) {
            return { content: [{ type: 'text', text: `HTTP ${res.status}: ${JSON.stringify(data)}` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `request failed: ${err.message}` }], isError: true };
    }
}

const server = new McpServer({ name: 'clipforge', version: '1.0.0' });

// Helper to cut boilerplate: register a tool that maps args → one HTTP call.
function tool(name, description, shape, build) {
    server.registerTool(name, { description, inputSchema: shape }, async (args = {}) => {
        const { method, path, body } = build(args);
        return call(method, path, body);
    });
}

// ---- production: queue jobs (all land in the human-review gate) ----
tool('queue_clip', 'Queue a clip job from a creator source (sourceUrl downloads via yt-dlp, or sourcePath clips a local file).',
    { clientId: z.string().optional(), sourceUrl: z.string().optional(), sourcePath: z.string().optional(),
      platforms: z.array(z.string()).optional() },
    (a) => ({ method: 'POST', path: '/api/clips/generate', body: a }));

tool('queue_reel', 'Queue a free stock-footage reel (Pexels/Pixabay) from a brief. $0-COGS SMB path.',
    { clientId: z.string().optional(), brief: z.string(), keywords: z.string().optional(),
      platforms: z.array(z.string()).optional() },
    (a) => ({ method: 'POST', path: '/api/reels/generate', body: a }));

tool('queue_specad', 'Queue a generative Higgsfield spec-ad from a brief or product URL. Set premium=true for Sora/Veo (costly).',
    { clientId: z.string().optional(), brief: z.string().optional(), productUrl: z.string().optional(),
      premium: z.boolean().optional(), platforms: z.array(z.string()).optional() },
    (a) => ({ method: 'POST', path: '/api/specads/generate', body: a }));

tool('queue_product_ad', 'Queue a dropship product ad from a product photo (Seedance reference-to-video). Localized hook via DeepSeek; approved ads post with the store link + UTM.',
    { clientId: z.string().optional(), productTitle: z.string().optional(),
      productImageUrl: z.string().optional(), productImageUrls: z.array(z.string()).optional(),
      price: z.string().optional(), targetGeo: z.string().optional(), targetLang: z.string().optional(),
      angle: z.string().optional(), storeUrl: z.string().optional(), supplierUrl: z.string().optional(),
      platforms: z.array(z.string()).optional() },
    (a) => ({ method: 'POST', path: '/api/productads/generate', body: a }));

// ---- clip review gate ----
tool('review_queue', 'List clips awaiting human approval before posting.', {},
    () => ({ method: 'GET', path: '/api/clips/review-queue' }));

tool('approve_clip', 'Approve a produced clip → queues it for posting via Mobile-Use on a real device (dry-run if no Mobile-Use server).',
    { clipId: z.string(), platforms: z.array(z.string()).optional(), caption: z.string().optional(), tier: z.number().optional() },
    (a) => ({ method: 'POST', path: `/api/clips/${a.clipId}/approve`,
              body: { platforms: a.platforms, caption: a.caption, tier: a.tier } }));

tool('reject_clip', 'Reject a produced clip so nothing posts. Records the reason.',
    { clipId: z.string(), reason: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/clips/${a.clipId}/reject`, body: { reason: a.reason } }));

tool('clip_status', 'Get the full status/metadata of one clip.',
    { clipId: z.string() },
    (a) => ({ method: 'GET', path: `/api/clips/${a.clipId}/status` }));

// ---- outreach review gate ----
tool('outreach_review_queue', 'List outreach DMs staged and awaiting human approval before the farm sends.', {},
    () => ({ method: 'GET', path: '/api/outreach/review-queue' }));

tool('stage_outreach', 'Stage a DM draft (does NOT send) for human review.',
    { targetHandle: z.string(), targetPlatform: z.string().optional(), message: z.string(), clientId: z.string().optional() },
    (a) => ({ method: 'POST', path: '/api/outreach/send', body: a }));

tool('approve_outreach', 'Approve a staged DM → queues it for Mobile-Use to send from a real device (dry-run if no Mobile-Use). Optional edited text.',
    { messageId: z.string(), message: z.string().optional(), tier: z.number().optional() },
    (a) => ({ method: 'POST', path: `/api/outreach/${a.messageId}/approve`, body: { message: a.message, tier: a.tier } }));

tool('reject_outreach', 'Reject a staged DM so nothing sends. Records the reason.',
    { messageId: z.string(), reason: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/outreach/${a.messageId}/reject`, body: { reason: a.reason } }));

// ---- Mobile-Use device + engagement tools ----
tool('list_devices', 'List connected ADB devices via Mobile-Use (real Android phones on the desktop bridge).',
    {},
    () => ({ method: 'GET', path: '/api/devices' }));

tool('device_status', 'Get the status of a specific Mobile-Use device.',
    { deviceId: z.string() },
    () => ({ method: 'GET', path: `/api/devices` }));  // list + client-side filter for now

tool('post_clip', 'Queue an approved clip for posting via Mobile-Use. Same as approve_clip but with explicit device/platform.',
    { clipId: z.string(), platforms: z.array(z.string()).optional(), caption: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/clips/${a.clipId}/approve`,
              body: { platforms: a.platforms, caption: a.caption } }));

tool('scan_comments', 'Scan comments on a posted clip via Mobile-Use → keyword-match buying intent → propose replies + DMs (queued for human review).',
    { clipId: z.string(), platform: z.string().optional(), deviceId: z.string().optional(), clipUrl: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/posts/${a.clipId}/scan`,
              body: { platform: a.platform, deviceId: a.deviceId, clipUrl: a.clipUrl } }));

tool('reply_comment', 'Propose a reply to a specific comment (stages for human review, does NOT post).',
    { clipId: z.string(), username: z.string(), text: z.string(), link: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/posts/${a.clipId}/reply`,
              body: { comment: { username: a.username, text: a.text }, link: a.link } }));

tool('dm_commenter', 'Propose a DM to a commenter (stages for human review, does NOT send).',
    { clipId: z.string(), username: z.string(), text: z.string(), link: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/posts/${a.clipId}/dm`,
              body: { comment: { username: a.username, text: a.text }, link: a.link } }));

tool('engagement_queue', 'List pending engagement actions (replies + DMs awaiting human approval).',
    {},
    () => ({ method: 'GET', path: '/api/engagement/queue' }));

tool('approve_engagement', 'Approve a pending engagement reply/DM → Mobile-Use executes on device.',
    { id: z.string(), clipId: z.string() },
    (a) => ({ method: 'POST', path: `/api/engagement/${a.id}/approve`, body: { clipId: a.clipId } }));

tool('reject_engagement', 'Reject a pending engagement reply/DM.',
    { id: z.string(), clipId: z.string(), reason: z.string().optional() },
    (a) => ({ method: 'POST', path: `/api/engagement/${a.id}/reject`, body: { clipId: a.clipId, reason: a.reason } }));

// ---- overview ----
tool('list_clients', 'List active clients.', {},
    () => ({ method: 'GET', path: '/api/clients' }));

tool('brand', 'Get this instance branding (white-label identity).', {},
    () => ({ method: 'GET', path: '/api/brand' }));

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr only — stdout is the JSON-RPC channel.
    console.error(`ClipForge MCP server up, targeting ${API}`);
}

main().catch((err) => { console.error('MCP server failed:', err); process.exit(1); });
