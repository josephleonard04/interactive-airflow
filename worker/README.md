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

## Which model reads the sentence

Three options. The default is the free one.

| | Cost | Needs | Quality |
|---|---|---|---|
| **Workers AI** (default) | **Free** — 10,000 Neurons/day | Nothing but a Cloudflare account | An 8B open model. Weaker reader. |
| Anthropic | $1 / $5 per MTok | Credit on an Anthropic account | Best. Claude Haiku 4.5. |
| OpenAI | Varies | An OpenAI **API** key (not ChatGPT) | Good. `gpt-4.1-mini` by default. |

**The free route is a smaller model, and that matters less than it sounds.** The
model is only ever the *fallback*: the offline keyword dictionary answers first
and handles the phrasings the pilot produced. Whatever the model returns is
constrained by the same JSON schema and every room and item id in it is checked
against the actual floor plan before the solver sees it — so a bad parse
degrades to "I could not find a goal in that", which is the behaviour with no
model at all. What you lose on the free route is *coverage* of unusual wording,
not correctness.

Switch with `LLM_PROVIDER` in `wrangler.toml`.

> **An OpenAI API key is not a ChatGPT subscription.** ChatGPT Free and Plus
> grant no API access; the API is billed separately at platform.openai.com and
> has no free tier.

## Putting it live

```sh
cd worker
npm install
node setup.mjs
```

That walks the whole thing: signs you in to Cloudflare, creates the spending-cap
store and writes its id into `wrangler.toml` for you, takes your Anthropic key,
deploys, checks the endpoint actually answers, and prints the one remaining step.
Re-running it is safe — it skips whatever is already done.

**You need two accounts before you start:**

1. **Cloudflare** — free, no card. The script opens a browser to sign in or sign up.
2. **Anthropic** — <https://console.anthropic.com> → *Settings* → *API keys* →
   *Create key*. Put a little credit on it; a parse costs a fraction of a cent,
   and the caps below bound a worst-case day at small change.

The key is typed into wrangler's prompt and stored on Cloudflare. It never enters
this repository, this script, or the page anyone downloads.

### The last step, on github.com

The script prints this with your URL filled in, but for reference — the published
page has to be told where the parser lives:

1. <https://github.com/josephleonard04/interactive-airflow/settings/variables/actions>
2. **New repository variable**
3. Name `GOAL_PARSER_URL`, value the `https://....workers.dev` URL the script printed
4. **Add variable**, then push any commit so Pages rebuilds

It is a *variable*, not a secret, because it is a public URL — and secrets are not
available to forks.

### If you would rather not pay at all

Set `LLM_PROVIDER = "workers-ai"` in `wrangler.toml` and skip the Anthropic key
entirely: Cloudflare's own models, 10,000 Neurons a day free, no key of any kind.
An 8B open model reads less well than Haiku — see the table above for what that
does and does not cost you.

### Doing it by hand

```sh
npx wrangler login
npx wrangler kv namespace create BUDGET     # paste the id into wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
curl https://<your-worker>.workers.dev/api/health
# {"ok":true,"provider":"anthropic","goalParser":true,"model":"claude-haiku-4-5"}
```

## What it costs, and what stops it running away

On a paid provider every request spends your credit, and the endpoint is
discoverable by anyone who reads the page source. On the free provider the same
guards keep you inside the daily allocation instead. Either way:

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

**On the Anthropic route the model is Claude Haiku 4.5** ($1 / $5 per million
tokens in / out), set in `../shared/goal-contract.json`. Mapping one sentence
onto three scalars against a strict schema is not work that repays a frontier
model, and every request here is spent on a stranger. A parse is a few hundred
tokens in and a few dozen out, so the 4,000-a-day cap bounds a worst-case day at
small change rather than at a number worth worrying about.

**A throttled visitor is not a broken app.** They get the offline dictionary and
a message saying the shared reader is busy — which is why the caps can be tight
without ruining a session.

The key is a Worker secret, so it is not in the repository, not in the built
page, and not visible to anyone opening the link. What a determined visitor
*can* do is spend your quota through the endpoint; that is what the budgets
bound. If you would rather it not be open at all, the alternative is running the
local backend during sessions — see the root README.

## Keeping the two routes honest

The prompt, the schema and the objective vocabulary live in
`../shared/goal-contract.json`, which `backend/goal_parser.py` reads too. Edit
that file, not this one, or the routes start answering in different
vocabularies — which would quietly invalidate any comparison
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
