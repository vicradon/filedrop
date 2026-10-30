# Drop

cl1p-style dropper on Cloudflare Workers + R2. Visit `/<name>`: if empty, upload a file or paste text; if taken, view or download it. Drops expire after 1 h, 1 day or 7 days, or can be one-time (deleted after the first download or view).

## Deploy

```bash
npm i -g wrangler
wrangler login
wrangler r2 bucket create drop-files
# safety net: R2 deletes anything older than 7 days on its own
wrangler r2 bucket lifecycle add drop-files expire-7d --expire-days 7
wrangler deploy
```

You get `https://drop.<your-subdomain>.workers.dev`. To use your own domain, add a route or custom domain in the Worker settings (e.g. `drop.osinachi.me`).

## CLI

```bash
curl -T notes.pdf "https://drop.<sub>.workers.dev/notes?ttl=1h&filename=notes.pdf"
curl -OJ https://drop.<sub>.workers.dev/notes      # download
```

## Notes

- No password: anyone who guesses a name can read it. One-time text is burned by the first visit, including link-preview bots in chat apps. Use random names for anything private.
- Max ~95 MB per file (Workers request body limit).
- Whole bucket capped at 500 MB; uploads past that get "Storage full" until something is deleted or expires.
- R2 free tier: 10 GB storage, no egress fees.

## Custom domain via Vercel

`vercel/` holds a config-only Vercel project (root directory `vercel`) that proxies every request to the Worker, so `drop.osinachi.me` gets SSL without moving DNS to Cloudflare. DNS: CNAME `drop` → `cname.vercel-dns.com` at Namecheap.
