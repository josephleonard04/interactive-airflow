# The public goal parser (Cloudflare Worker)

The study app is published to GitHub Pages and opened by participants on their
own computers. The FastAPI backend in `backend/` holds the Anthropic key and
runs on **your laptop** at `127.0.0.1:8000` — which no participant's browser can
reach. So the free-text goal parser, the whole point of the intent layer, was
only ever available to you.

This Worker is that same endpoint at a public URL. **The API key stays on
Cloudflare** — it is a secret there, never in this repo and never in the
browser. The page only knows the Worker's address.

The wire contract is identical to `backend/app.py`'s `/api/parse-goal`, so the
frontend cannot tell which one it is talking to and local development is
unchanged.

---

## Deploy it (once)

Everything below runs from this directory:

```bash
cd C:\Users\dohun\interactive_airflow\worker
```

**1. Install.**

```bash
npm install
```

**2. Log in to Cloudflare.** Opens a browser; a free account is enough.

```bash
npx wrangler login
```

**3. Store the API key as a secret.** It is prompted for, not typed as an
argument, so it never lands in your shell history.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

**4. Deploy.**

```bash
npx wrangler deploy
```

The last command prints the URL — something like
`https://airflow-goal-parser.<your-subdomain>.workers.dev`. Copy it.

**5. Check it answers.** Replace the URL with yours; `goalLlm` should be `true`.

```bash
curl https://airflow-goal-parser.YOUR-SUBDOMAIN.workers.dev/api/health
```

**6. Confirm it actually parses.** This should return an `objectives` array, not
an `error`:

```bash
Invoke-RestMethod -Uri https://airflow-goal-parser.YOUR-SUBDOMAIN.workers.dev/api/parse-goal -Method Post -ContentType application/json -Body '{"text":"i want the bed area to be nice to sleep","rooms":[{"id":"studio","name":"Studio","type":"bedroom"}]}' | ConvertTo-Json -Depth 5
```

---

## Point the published app at it

The frontend reads `VITE_GOAL_PARSER_URL` at build time. Set it as a repository
**variable** (not a secret — it is a public address and ends up in the bundle
either way):

GitHub → your repo → **Settings → Secrets and variables → Actions → Variables →
New repository variable**

- Name: `GOAL_PARSER_URL`
- Value: your Worker URL, no trailing slash

Push anything to `main` (or re-run the Pages workflow) and the deployed app will
use it. Unset, the published app runs on the offline keyword parser alone —
which is a valid way to ship, not a broken one.

---

## Lock it down before the study

By default any origin may call the Worker. Once the Pages URL is known, restrict
it — edit `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy:

```toml
ALLOWED_ORIGINS = "https://josephleonard04.github.io,http://localhost:5173"
```

Without this the endpoint is a general-purpose way for anyone who finds the URL
to spend your tokens. The input caps in `src/index.ts` (500 characters, 20
rooms) bound the damage per call but do not bound the number of calls.

---

## Local development

Nothing here is needed for `npm run dev` in `frontend/` — with no
`VITE_GOAL_PARSER_URL` set, the app falls back to `127.0.0.1:8000` (the Python
backend) and then to the offline keyword parser. Both still work exactly as
before.

To run the Worker itself locally, put the key in a `.dev.vars` file — it is
gitignored, and `wrangler dev` reads it automatically:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-YOUR-KEY" > .dev.vars
```

```bash
npm run dev
```

Then point the frontend at it for a session:

```bash
$env:VITE_GOAL_PARSER_URL = "http://127.0.0.1:8787"
```

---

## What it costs

Each parse is roughly 500 input tokens and 50 output tokens on Claude Sonnet 5 —
about **$0.0015**, or half a dollar for a 16-participant study. Cloudflare's free
tier covers 100,000 Worker requests a day; a session makes a handful.

## Files

| | |
|---|---|
| `src/index.ts` | The Worker. Same request/response shape as `backend/app.py`. |
| `wrangler.toml` | Deploy config. Holds no secrets — the key is set with `wrangler secret put`. |
| `.dev.vars` | Local-only key for `wrangler dev`. Gitignored. Never commit. |
