/**
 * ClipForge preflight — readiness & fallback matrix.
 *
 * Reads config/.env (or a path arg) and prints what will run LIVE vs on
 * FALLBACK vs OFF, given which keys are present. Nothing here is fatal except
 * unset core secrets: every integration degrades gracefully, so the fleet runs
 * on a bare €20 box with zero API keys and lights up feature-by-feature as you
 * add them.
 *
 * Usage:  node scripts/preflight.mjs [path/to/.env]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = process.argv[2]
    || (fs.existsSync(path.join(root, 'config/.env')) ? path.join(root, 'config/.env') : path.join(root, 'config/.env.example'));

const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
}
// A value counts as "set" only if it's non-empty and contains no placeholder
// token anywhere (the template uses xxx / your- / change-this / etc.).
const set = (k) => {
    const v = (env[k] || '').trim();
    if (!v) return false;
    return !/(xxx|your-|change-this|generate-a|example\.com|[<>])/i.test(v);
};
const any = (...ks) => ks.some(set);

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', n: '\x1b[0m' };
const badge = (s) => s === 'LIVE' ? `${C.g}LIVE    ${C.n}` : s === 'FALLBACK' ? `${C.y}FALLBACK${C.n}`
    : s === 'OFF' ? `${C.d}OFF     ${C.n}` : s === 'AGENT' ? `${C.c}AGENT   ${C.n}` : `${C.r}${s}${C.n}`;

const rows = [
    ['Clip production (yt-dlp+ffmpeg)', 'LIVE', 'core — always on, CPU only'],
    ['Highlight scoring',
        any('DEEPSEEK_API_KEY') && any('FAL_KEY', 'ASR_ENDPOINT') ? 'LIVE' : 'FALLBACK',
        any('DEEPSEEK_API_KEY') && any('FAL_KEY', 'ASR_ENDPOINT') ? 'DeepSeek/Claude over transcript' : 'naive fixed windows (needs DEEPSEEK + ASR)'],
    ['Burned captions',
        any('FAL_KEY', 'ASR_ENDPOINT') ? 'LIVE' : 'FALLBACK',
        any('FAL_KEY', 'ASR_ENDPOINT') ? 'ASR → .ass karaoke' : 'no captions (set FAL_KEY or ASR_ENDPOINT)'],
    ['Stock-reel path (SMB, $0)',
        any('PEXELS_API_KEY', 'PIXABAY_API_KEY') ? 'LIVE' : 'OFF',
        any('PEXELS_API_KEY', 'PIXABAY_API_KEY') ? 'Pexels/Pixabay assembly' : 'set PEXELS_API_KEY or PIXABAY_API_KEY'],
    ['Generative spec-ad (Higgsfield)',
        set('HIGGSFIELD_API_KEY') ? 'LIVE' : 'OFF',
        set('HIGGSFIELD_API_KEY') ? 'Kling default / Sora on premium' : 'set HIGGSFIELD_API_KEY'],
    ['Posting + DM farm (Mobile-Use)',
        set('MOBILEUSE_HOST') ? 'LIVE' : 'FALLBACK',
        set('MOBILEUSE_HOST') ? `Mobile-Use at ${env['MOBILEUSE_HOST']}:${env['MOBILEUSE_PORT'] || '8000'}` : 'DRY-RUN (logs, no send) — set MOBILEUSE_HOST (desktop bridge with ADB phones)'],
    ['Billing / subs (Whop)',
        set('WHOP_API_KEY') ? 'LIVE' : 'OFF',
        set('WHOP_API_KEY') ? 'webhooks + subscriptions' : 'set WHOP_API_KEY'],
    ['Intelligence / lead discovery', 'AGENT',
        'operator agent via MCP (ScrapeCreators / Apify / Exa) — see config/mcp.example.json'],
    ['Notifications',
        any('SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN') ? 'LIVE' : 'OFF',
        any('SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN') ? 'ops alerts' : 'agent handles Telegram, or set a webhook'],
];

console.log(`\nClipForge preflight — ${path.relative(root, envPath)}\n`);
console.log(`  ${'Feature'.padEnd(34)}Status    Detail`);
console.log(`  ${'-'.repeat(34)}--------  ${'-'.repeat(40)}`);
for (const [f, s, d] of rows) console.log(`  ${f.padEnd(34)}${badge(s)}  ${C.d}${d}${C.n}`);

// Core secrets must be real before deploy.
const secretsBad = ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'API_SECRET'].filter(k => !set(k));
console.log('');
if (secretsBad.length) {
    console.log(`  ${C.r}✗ core secrets not set: ${secretsBad.join(', ')} — run ./scripts/bootstrap.sh${C.n}\n`);
    process.exit(1);
}
console.log(`  ${C.g}✓ core secrets set — deployable. Unset features above run on fallback, not failure.${C.n}\n`);
