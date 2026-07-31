# Google Search Console — Platform Properties Analytics

> **Status:** Documented. No code needed — Claude's /analyze and existing analytics
> infrastructure cover this. Platform properties just became available July 2026.

## What It Is

Google Search Console now supports **platform properties** — you can add your
Instagram, TikTok, X, and YouTube accounts as properties and track how your
social content performs in Google Search, Discover, and News.

**Docs:**
- Blog: https://developers.google.com/search/blog/2026/07/platform-properties-social-video-guide
- Setup: https://support.google.com/webmasters/answer/17148418?hl=en

## Supported Platforms

Instagram, TikTok, X, YouTube

## What You Can Track

- Clicks from Google Search to your social content
- Impressions in Google Search, Discover, and News
- CTR and average position
- Top search queries driving traffic to your clips
- Top content pages

## Setup (one-time, manual)

1. Go to Google Cloud Console → create service account → enable Search Console API
2. Add each social account as a platform property in Search Console:
   - Instagram account URL
   - TikTok account URL
   - YouTube channel URL
   - X profile URL
3. Add the service account email as a user for each property
4. Verify ownership (follow Search Console prompts)
5. Wait a few days for data to accumulate

## How to Use (no code needed)

- **Claude /analyze:** Point Claude at Search Console data via MCP or API key.
  It can pull performance, compare across platforms, identify top queries.
- **Hermes cron jobs:** Schedule a daily/weekly analytics pull → summarize →
  deliver to Telegram. No code — just a cron prompt that fetches and reports.
- **Pi:** For custom dashboards or alerts when specific metrics cross thresholds.

## Why No Code

Clip4Clicks already has:
- Analytics queue (worker)
- Whop integration (revenue tracking)
- Mobile-Use (engagement metrics)
- MCP server (agent-driven control)

Adding a Search Console API client would be redundant when Claude can analyze
the same data via /analyze or an MCP server. The value is in the **workflow**,
not the integration code.

## Workflow (how to operate)

### Daily
1. Hermes cron job → pulls Search Console data via API → summarizes in Telegram
   - "Yesterday's Google Search performance: 2,340 impressions, 187 clicks,
     top query: 'wolof fabric buy'"
2. Compare with platform metrics (TikTok views, IG engagement)

### Weekly
1. Pi or Claude → analyze trends across platforms + Google Search
2. Identify which clips rank in Google → double down on that content type
3. Check Discover performance — viral clips often surface there first

### Monthly
1. Full report for done-for-you clients: platform + Google Search performance
2. Show which content drives both platform engagement AND organic search traffic
3. Adjust content strategy based on what Google indexes well

## Value Proposition for Clients

"Your clips don't just get views on TikTok — they get discovered in Google
Search. We track both and optimize for both. Here's your monthly report
showing 2,340 Google impressions on top of 50K TikTok views."

This is a signal most content operations don't track yet. First-mover advantage.