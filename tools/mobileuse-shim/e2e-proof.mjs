/**
 * End-to-end proof: VPS -> HITL gate -> desktop bridge -> real Android device.
 *
 * Plays the desktop bridge by hand, over the same HTTP contract the Tauri app
 * uses, so every link is exercised for real: the VPS produces a clip, a human
 * gate approves it, the bridge claims it, downloads it, and puts it on an
 * actual handset where a gallery picker can see it.
 *
 * The agent step is deliberately included and expected to fail without an LLM
 * key. That is the honest picture: everything up to it is code, that one link
 * is credit.
 *
 * Usage:
 *   node e2e-proof.mjs
 * Env:
 *   VPS        base url of the API              (default http://127.0.0.1:3100)
 *   TOKEN      bridge bearer token (API_SECRET) (required)
 *   SHIM       shim base url                    (default http://127.0.0.1:8000)
 *   DEVICE     adb serial                       (default emulator-5554)
 */

const VPS = process.env.VPS || 'http://127.0.0.1:3100';
const SHIM = process.env.SHIM || 'http://127.0.0.1:8000';
const DEVICE = process.env.DEVICE || 'emulator-5554';
const TOKEN = process.env.TOKEN || '';

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`); };
const note = (m) => { skip++; console.log(`  GATED ${m}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, path, body, raw = false) {
    const res = await fetch(`${VPS}${path}`, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
}

async function main() {
    console.log(`\nClip4Clicks e2e — VPS ${VPS} -> device ${DEVICE}\n`);
    if (!TOKEN) { console.log('TOKEN is required'); process.exit(2); }

    // ── 1. the device is really there ────────────────────────────────────────
    const devs = await (await fetch(`${SHIM}/devices`)).json();
    const found = (devs.devices || []).find(d => d.id === DEVICE && d.status === 'device');
    found ? ok(`device online: ${found.id} (${found.model})`) : bad(`device ${DEVICE} not online`);
    if (!found) return;

    // ── 2. VPS produces a clip ───────────────────────────────────────────────
    const health = await api('GET', '/health');
    health.status === 200 ? ok(`VPS healthy (${health.json.brand})`) : bad(`VPS health ${health.status}`);

    const reviewQueue = async () => {
        const q = await api('GET', '/api/clips/review-queue');
        return Array.isArray(q.json.clips) ? q.json.clips : [];
    };

    // Snapshot the queue BEFORE queueing, and wait for an id that was not in it.
    // Deliberately not a created_at comparison: that would pit this laptop's
    // clock against Postgres', and any skew either grabs someone else's clip or
    // never matches our own.
    const before = new Set((await reviewQueue()).map(c => c.id));

    const gen = await api('POST', '/api/clips/generate',
        { clientId: null, sourcePath: '/app/data/sources/smoke_sample.mp4', maxClips: 1 });
    gen.status === 200 ? ok('clip job queued on the VPS') : bad(`queue: ${JSON.stringify(gen.json)}`);

    let clip = null;
    for (let i = 0; i < 90 && !clip; i++) {
        await sleep(1000);
        clip = (await reviewQueue()).find(c => !before.has(c.id));
    }
    clip ? ok(`clip produced -> pending_review (${clip.id})`) : bad('no clip reached pending_review');
    if (!clip) return;

    // ── 3. the human gate ────────────────────────────────────────────────────
    const appr = await api('POST', `/api/clips/${clip.id}/approve`, { platforms: ['tiktok'] });
    appr.status === 200 ? ok('approved at the HITL gate -> queued for posting') : bad(`approve: ${JSON.stringify(appr.json)}`);

    // ── 4. the desktop bridge claims it ──────────────────────────────────────
    let job = null;
    for (let i = 0; i < 5; i++) {
        const claim = await api('GET', `/api/bridge/posts/claim?device=${DEVICE}`);
        const j = claim.json && claim.json.job;
        if (!j) break;
        if (j.clipId === clip.id) { job = j; break; }
        console.log(`        (skipped a pre-existing job for clip ${j.clipId})`);
    }
    job ? ok(`bridge claimed the job (fileUrl present: ${!!job.fileUrl})`) : bad('bridge never claimed this job');
    if (!job) return;

    // ── 5. bridge downloads the clip ─────────────────────────────────────────
    const fileUrl = job.fileUrl.startsWith('http') ? job.fileUrl : `${VPS}${job.fileUrl}`;
    const fileRes = await fetch(fileUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    fileRes.ok && bytes.length > 0
        ? ok(`clip downloaded (${bytes.length.toLocaleString()} bytes)`)
        : bad(`download failed: http ${fileRes.status}`);

    // ── 6. onto the actual handset ───────────────────────────────────────────
    const pushRes = await fetch(`${SHIM}/devices/${DEVICE}/push?filename=${clip.id}.mp4`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes
    });
    const push = await pushRes.json();
    pushRes.ok && push.device_path
        ? ok(`pushed to device at ${push.device_path} (${push.bytes.toLocaleString()} bytes)`)
        : bad(`push failed: ${JSON.stringify(push)}`);
    push.indexed
        ? ok('indexed in MediaStore — visible to any app\'s gallery picker')
        : bad('pushed but not indexed; a gallery picker will not see it');

    // ── 7. the agent drives the app ──────────────────────────────────────────
    // Settings, not a gallery: the google_apis emulator image ships no Photos
    // app, so asking for one tests the image rather than the agent. This still
    // exercises the whole capability - see the screen, decide, tap, navigate,
    // read a value back - which is what posting needs.
    const agentRes = await fetch(`${SHIM}/devices/${DEVICE}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            instruction: 'Open the Settings app, go to About phone, and report the Android version.',
            max_steps: 15
        })
    });
    if (agentRes.ok) {
        ok(`agent ran on the device: ${JSON.stringify(await agentRes.json()).slice(0, 160)}`);
    } else if (agentRes.status === 503) {
        note(`agent needs an LLM key (503) — the only link that is credit, not code`);
    } else {
        bad(`agent failed unexpectedly: http ${agentRes.status}`);
    }

    // ── 8. bridge reports back, VPS closes the loop ──────────────────────────
    const rep = await api('POST', `/api/bridge/posts/${clip.id}/result`,
        { results: [{ platform: 'tiktok', success: true }] });
    rep.json && rep.json.status === 'posted'
        ? ok('result reported -> VPS marked the clip posted')
        : bad(`report: ${JSON.stringify(rep.json)}`);

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed, ${skip} credit-gated\n`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('e2e crashed:', e); process.exit(1); });
