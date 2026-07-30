# Clip4Clips — marketing landing

The public face for ClipForge (the service) with a CLIPTI Trident teaser. This is
the **public** layer and is completely separate from the private ops API (which
stays Tailscale-only). Nothing here talks to the API.

## What it is

A single self-contained `index.html`. No build step, no external assets:
- Inline CSS + JS, hand-written WebGL hero (a raymarched titanium CLIPTI ring with
  a living, pointer-reactive energy halo), data-URI favicon.
- "Tally" identity: warm graphite, tally-red accent, mono film-slate headlines.
- Spring-physics motion (orchestrated load, magnetic buttons), theme-aware,
  `prefers-reduced-motion` safe.

## Edit it

Open `index.html` and edit directly — it's one file. Common changes:
- Contact email: search `hello@clip4clicks.com` (final CTA + footer note).
- Gallery demos: the `clips` array in the `<script>` (caption, platform, views).
- Ticker copy: the `.ticker .track` spans (keep the two spans identical).

## Deploy — Cloudflare Pages (preferred)

Better than GitHub Pages for this project for three concrete reasons: far stronger
edge presence in the Gulf/MENA/Africa markets we route products to; Pages Functions
(so the "send me 3 clips" CTA can actually capture leads into KV/D1 without a
third-party form service); and native apex-domain + cache/WAF control.

**Git integration (no token needed):** Cloudflare dashboard → Workers & Pages →
Create → Pages → Connect to Git → repo `MouhamedN96/Clip4Clips`, branch `main`,
**build command: none**, **build output directory: `landing`**. Every push that
touches `landing/` redeploys. Then retire `.github/workflows/deploy-landing.yml`.

**Or from the CLI:**
```bash
npx wrangler pages deploy landing --project-name clip4clicks
```
Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. If the token has an IP
allowlist you'll get `code: 9109` — add the machine's IP or drop the restriction.

`landing/_headers` ships security headers + no-cache on the HTML (honored by
Cloudflare Pages and Netlify; ignored by GitHub Pages). The CSP is strict because
the page makes zero external requests.

**Custom domain:** add it on the Pages project; if the domain's nameservers are on
Cloudflare, apex works natively — no A records to hardcode.

## Deploy — GitHub Pages (currently live)

This is the deploy in use. `.github/workflows/deploy-landing.yml` publishes this
folder to GitHub Pages on every push to `main` that touches `landing/`. Edit
`index.html`, push, and it redeploys automatically.

- Live: https://mouhamedn96.github.io/Clip4Clips/
- Free, HTTPS-enforced, on GitHub's CDN. Off the VPS entirely.

### Custom (Porkbun) domain

1. Add a `CNAME` file in this folder containing just the domain (e.g. `clip4clicks.com`).
2. Porkbun DNS:
   - apex (`clip4clicks.com`): four **A** records → `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
   - or a subdomain (`www`): one **CNAME** → `mouhamedn96.github.io`.
3. Push. GitHub verifies the domain and issues TLS.

## Alternative — Coolify (Dockerfile)

`landing/Dockerfile` (nginx static) is kept for hosting on the box's Coolify
instead: New Resource → repo `MouhamedN96/Clip4Clips`, build pack **Dockerfile**,
base directory `landing/`, set the domain, Coolify does TLS. Use this only if you
want it on the VPS; GitHub Pages is simpler and keeps load off the box.
