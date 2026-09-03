# The public goal parser

This makes the model half of the language layer work for **anyone with the
link** — <https://josephleonard04.github.io/interactive-airflow/> — instead of
only on a laptop running the local backend.

Without it the published page calls `http://127.0.0.1:8000`, which is *the
visitor's own machine*. Nothing is listening there, so any sentence the offline
keyword dictionary cannot read falls back to the task's own goals and the panel
says so. Everything else on the page — the solver, the sketching, the search,
the logging — is client-side and already works for everyone.

It is a Cloudflare Worker rather than the FastAPI backend redeployed because a
Worker stays warm on the free tier. A free-tier container that sleeps wakes up
on the first sentence of a study session, which is the worst possible moment to
spend thirty seconds.

## Putting it live

Two commands and one secret. **You have to run these** — they need your
Cloudflare account and your Anthropic key, and I never handle either.

```sh
cd worker
npm install
npx wrangler login
```

Create the KV namespace that holds the spending caps, and paste the id it prints
into the commented-out `[[kv_namespaces]]` block in `wrangler.toml`:

```sh
npx wrangler kv namespace create BUDGET
```

> Skipping this leaves the Worker running with **no spending cap**. It is the
> one step worth not skipping.

Then set the key and deploy:

```sh
npx wrangler secret put ANTHROPIC_API_KEY     # paste your key at the prompt
npx wrangler deploy
```

`deploy` prints a URL like `https://interactive-airflow-goal-parser.<you>.workers.dev`.
Check it before wiring it up:

```sh
curl https://interactive-airflow-goal-parser.<you>.workers.dev/api/health
# {"ok":true,"goalParser":true,"model":"claude-haiku-4-5"}
```

Finally, tell the published page where it lives — a repository **variable**, not
a secret, because it is a public URL and secrets are not available to forks:

**Settings → Secrets and variables → Actions → Variables → New repository variable**

| | |
|---|---|
| Name | `GOAL_PARSER_URL` |
| Value | `https://interactive-airflow-goal-parser.<you>.workers.dev` |

Push anything to `main` (or run the Pages workflow by hand) and the next build
bakes that URL in. The key stays on Cloudflare; it is never in the bundle.

## What it costs, and what stops it running away

Every request spends your Anthropic credit, and the endpoint is discoverable by
anyone who reads the page source. So:

| Guard | Limit | Why |
|---|---|---|
| Per IP | 40 sentences / hour | One person cannot loop it |
| Whole deployment | 4,000 sentences / day | A hundred IPs at the per-IP limit is still a bill |
| Sentence length | 400 characters | A study sentence is a sentence |
| Rooms / items | 24 / 60 | Trimmed before the prompt, not forwarded |
| Body | 16 KB | Rejected before it is parsed |
| Routes | `POST /api/parse-goal`, `GET /api/health` | Nothing else exists |
| CORS | the published page and localhost | Stops casual reuse as a free proxy |

The caps are in `src/index.js` as `PER_IP_PER_HOUR` and `GLOBAL_PER_DAY`; raise
them once you know what a session actually uses. Cloudflare's free tier covers
100,000 Worker requests a day, so the model is the only real cost.

**The model is Claude Haiku 4.5** ($1 / $5 per million tokens in / out), set in
`../shared/goal-contract.json`. Mapping one sentence onto three scalars against
a strict schema is not work that repays a frontier model, and every request here
is spent on a stranger. A parse is a few hundred tokens in and a few dozen out,
so the 4,000-a-day cap bounds the day at small change rather than at a number
worth worrying about.

**A throttled visitor is not a broken app.** They get the offline dictionary and
a message saying the shared reader is busy — which is why the caps can be tight
without ruining a session.

The key is a Worker secret, so it is not in the repository, not in the built
page, and not visible to anyone opening the link. What a determined visitor
*can* do is spend your quota through the endpoint; that is what the budgets
bound. If you would rather it not be open at all, the alternative is running the
local backend during sessions — see the root README.

### Using OpenAI instead

`LLM_PROVIDER = "openai"` in `wrangler.toml` plus an `OPENAI_API_KEY` secret
switches routes; `OPENAI_MODEL` picks the model (default `gpt-4.1-mini`). The
same schema serves both — it was written strict-mode-clean for Anthropic and is
exactly what OpenAI's strict mode requires.

**This is not a ChatGPT subscription.** ChatGPT Free and Plus grant no API
access at all; the OpenAI API is billed separately at platform.openai.com and
needs its own prepaid credit. There is no free API tier.

## Keeping the two routes honest

The prompt, the schema and the objective vocabulary live in
`../shared/goal-contract.json`, which `backend/goal_parser.py` reads too. Edit
that file, not this one, or the hosted route and the local route start answering
in different vocabularies — which would quietly invalidate any comparison
between sessions run on each.

```sh
node worker/check_worker.mjs      # routing, caps, budgets, CORS, validation
python backend/check_goal_parser.py
```

Both run with no key, no model and no network.

## Local development

```sh
npx wrangler dev            # http://localhost:8787
```

Point the dev frontend at it with `VITE_GOAL_PARSER_URL=http://localhost:8787`
in `frontend/.env.local`.
