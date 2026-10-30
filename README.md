# Drop

cl1p-style dropper on Cloudflare Workers + R2. Visit `/<name>`: if empty, upload a file or paste text; if taken, view or download it. Drops expire after 1 h, 1 day or 7 days.

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
curl -X DELETE https://drop.<sub>.workers.dev/notes
```

## Notes

- No password: anyone who guesses a name can read or delete it. Use random names for anything private.
- Max ~95 MB per file (Workers request body limit).
- R2 free tier: 10 GB storage, no egress fees.
