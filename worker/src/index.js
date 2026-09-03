// The goal parser, in public.
//
// The published page (GitHub Pages) is static, so the model half of the language
// layer had nowhere to run: the browser called 127.0.0.1:8000 — the VISITOR'S own
// machine — and nothing was listening. Anyone could open the link and use the
// app, but a sentence the keyword dictionary could not read got the offline
// fallback and a message saying so. This Worker is the missing half: one endpoint,
// same contract, no key in the bundle.
//
// WHAT MAKES THIS DIFFERENT FROM THE LOCAL BACKEND is that a public endpoint
// spends someone's money on every request and is reachable by anyone who reads
// the page source. So it does the smallest amount of work that answers the study's
// sentences, and refuses everything else:
//
//   - one route, POST /api/parse-goal, nothing else exists
//   - CORS limited to the published page and localhost, so it is not a free
//     Anthropic proxy for other sites (that is not real security — a script can
//     forge Origin — it is what stops casual reuse)
//   - hard caps on every field, so a 2 MB "sentence" cannot be sent through
//   - per-IP and whole-deployment daily budgets, so a bad day costs a known
//     amount rather than an unbounded one
//   - the reply is validated the same way the Python backend validates it, and
//     the frontend validates it a third time against the actual floor plan
//
// The prompt and schema come from shared/goal-contract.json, the same file
// backend/goal_parser.py reads, so the hosted route and the local one cannot
// answer in different vocabularies.

import CONTRACT from "../../shared/goal-contract.json" with { type: "json" };

// Caps. A study sentence is a sentence; anything past these is not a
// participant, and the cost of finding out is what we are avoiding.
const MAX_TEXT = 400;
const MAX_ROOMS = 24;
const MAX_ITEMS = 60;
const MAX_BODY_BYTES = 16 * 1024;

// Budgets. Per-IP stops one person looping; the global cap is the actual
// spending limit, because a hundred IPs at the per-IP limit is still a bill.
const PER_IP_PER_HOUR = 40;
const GLOBAL_PER_DAY = 4000;

// WHICH MODEL READS THE SENTENCE, as a deploy-time choice rather than a code
// change: set LLM_PROVIDER to "anthropic" (default) or "openai" in wrangler.toml
// and put the matching key in as a secret. Both are asked for the same schema
// and both go through the same id validation, so the objective vocabulary is
// identical either way and the page cannot tell them apart.
//
// Note for anyone reaching for a ChatGPT subscription: that is not this. The
// OpenAI API is billed separately from ChatGPT Plus, at platform.openai.com,
// and needs its own prepaid credit.
const OPENAI_MODEL_DEFAULT = "gpt-4.1-mini";

// The free route. Workers AI runs open models on Cloudflare's own edge with a
// daily free allocation (10,000 Neurons) and NO api key at all — it is a binding
// on this Worker, not an outbound call — so the published page can read
// sentences without anyone holding a funded account.
//
// The trade is quality: an 8B open model is a weaker reader than Haiku. That
// matters less here than it looks, because the model is only ever the FALLBACK
// (the keyword dictionary answers first, offline, and handles the phrasings the
// pilot produced), the reply is constrained by the same JSON schema, and every
// id it returns is validated against the actual floor plan before the solver
// sees it. A bad parse degrades to "I could not find a goal in that", which is
// the behaviour without any model at all.
const WORKERS_AI_MODEL_DEFAULT = "@cf/meta/llama-3.1-8b-instruct";

const ALLOWED_ORIGINS = [
  "https://josephleonard04.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // A health route, so "is the parser up?" can be answered without spending a
    // token. The page does not need it; a researcher before a session does.
    if (request.method === "GET" && url.pathname === "/api/health") {
      const p = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
      return json(
        { ok: true, provider: p, goalParser: !whatIsMissing(env, p), model: modelFor(env, p) },
        200,
        cors,
      );
    }

    if (request.method !== "POST" || url.pathname !== "/api/parse-goal") {
      return json({ error: "Not found." }, 404, cors);
    }

    const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
    const missing = whatIsMissing(env, provider);
    if (missing) {
      // The key names are spelled exactly as the Python backend spells them,
      // because the frontend matches on those strings to tell a missing
      // credential from a rejected one and gives different advice for each.
      return json({ error: missing }, 200, cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "Request too large." }, 413, cors);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Body must be JSON." }, 400, cors);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ objectives: [] }, 200, cors);
    if (text.length > MAX_TEXT) {
      return json({ error: `Say it in ${MAX_TEXT} characters or fewer.` }, 200, cors);
    }

    const limited = await checkBudget(env, request);
    if (limited) return json({ error: limited }, 200, cors);

    const rooms = Array.isArray(body.rooms) ? body.rooms.slice(0, MAX_ROOMS) : [];
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS).map(String) : [];
    const outdoorTemp = typeof body.outdoor_temp === "number" ? body.outdoor_temp : null;
    const sketch = body.sketch_region && typeof body.sketch_region === "object" ? body.sketch_region : null;

    const prompt = buildPrompt(text, rooms, items, outdoorTemp, sketch);
    const result =
      provider === "openai"
        ? await callOpenAI(env, prompt)
        : provider === "workers-ai"
          ? await callWorkersAI(env, prompt)
          : await callAnthropic(env, prompt);
    if (result.error) return json({ error: result.error }, 200, cors);

    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return json({ error: "The model's reply was not valid JSON." }, 200, cors);
    }

    // Same validation the Python route does. Trust the schema for shape, never
    // for the ids: a hallucinated room would ground a goal to a room that does
    // not exist, and the search would then optimise part of a home nobody
    // mentioned.
    const roomIds = new Set(rooms.map((r) => r?.id).filter(Boolean));
    const itemTypes = new Set(items);
    const objectives = (parsed.objectives ?? [])
      .filter((o) => CONTRACT.scalars.includes(o?.scalar) && CONTRACT.directions.includes(o?.direction))
      .map((o) => ({
        scalar: o.scalar,
        direction: o.direction,
        regionId: roomIds.has(o.regionId) ? o.regionId : null,
        nearItem: itemTypes.has(o.nearItem) ? o.nearItem : null,
        sourceId: roomIds.has(o.sourceId) ? o.sourceId : null,
        usedSketch: Boolean(o.usedSketch) && sketch !== null,
      }));

    return json({ objectives }, 200, cors);
  },
};

/** Anthropic. Returns {text} or {error}; never throws. */
async function callAnthropic(env, prompt) {
  let data;
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CONTRACT.model,
        max_tokens: 2048,
        system: CONTRACT.system,
        output_config: { format: { type: "json_schema", schema: CONTRACT.schema } },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    data = await upstream.json();
    // A 401 reaches the frontend as "bad-key" and a 429 as a rate limit; both
    // degrade to the dictionary, which is why these come back as 200s with a
    // message rather than a status the browser's fetch treats as a dead network.
    if (!upstream.ok) return { error: data?.error?.message ?? `Upstream HTTP ${upstream.status}` };
  } catch (err) {
    return { error: `Upstream request failed: ${err}` };
  }

  if (data.stop_reason === "refusal") return { error: "The model declined to answer this request." };
  const text = (data.content ?? []).find((b) => b.type === "text")?.text;
  return text ? { text } : { error: "Empty response from the model." };
}

/** OpenAI, via chat completions with a strict JSON schema.
 *
 *  The same schema object serves both providers: strict mode requires every
 *  object to set additionalProperties false and to list every property in
 *  required, which the contract already does — it was written that way for
 *  Anthropic and happens to be exactly what OpenAI enforces.
 *
 *  NOT A CHATGPT SUBSCRIPTION. This wants an API key from platform.openai.com
 *  with credit on it; ChatGPT Free and Plus grant no API access.
 */
async function callOpenAI(env, prompt) {
  let data;
  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT,
        messages: [
          { role: "system", content: CONTRACT.system },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "objectives", strict: true, schema: CONTRACT.schema },
        },
      }),
    });
    data = await upstream.json();
    if (!upstream.ok) return { error: data?.error?.message ?? `Upstream HTTP ${upstream.status}` };
  } catch (err) {
    return { error: `Upstream request failed: ${err}` };
  }

  const choice = data.choices?.[0];
  // A strict-schema refusal is its own field, not an empty message.
  if (choice?.message?.refusal) return { error: "The model declined to answer this request." };
  const text = choice?.message?.content;
  return text ? { text } : { error: "Empty response from the model." };
}

/** Cloudflare's own models, over the AI binding. No key, no outbound request.
 *
 *  JSON mode here takes the schema DIRECTLY under `json_schema` — not wrapped in
 *  {name, strict, schema} the way OpenAI wants it — and returns the parsed object
 *  on `.response` rather than a string. Cloudflare is explicit that schema
 *  compliance is not guaranteed, which is why the reply still goes through the
 *  same id validation as every other route.
 */
async function callWorkersAI(env, prompt) {
  let out;
  try {
    out = await env.AI.run(env.WORKERS_AI_MODEL || WORKERS_AI_MODEL_DEFAULT, {
      messages: [
        // The format rule is the one written for small local models, and an 8B
        // model on the edge needs it for the same reason: it will otherwise wrap
        // perfectly good JSON in an explanation.
        { role: "system", content: `${CONTRACT.system}

${CONTRACT.localFormatRule}` },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_schema", json_schema: CONTRACT.schema },
    });
  } catch (err) {
    return { error: `Workers AI request failed: ${err}` };
  }

  const reply = out?.response;
  if (reply === undefined || reply === null || reply === "") {
    return { error: "Empty response from the model." };
  }
  // In JSON mode this is already an object; without it, or when the model
  // ignores the mode, it is a string that may be fenced or prefaced.
  return typeof reply === "string" ? { text: unwrapJson(reply) } : { text: JSON.stringify(reply) };
}

/** Pull the JSON object out of a reply that may be fenced or prefaced. */
function unwrapJson(text) {
  let body = text.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/** What this deploy is missing for the provider it selected, or null. */
function whatIsMissing(env, provider) {
  if (provider === "workers-ai") {
    return env.AI ? null : "The Workers AI binding is not configured on the backend.";
  }
  if (provider === "openai") {
    return env.OPENAI_API_KEY ? null : "OPENAI_API_KEY is not set on the backend.";
  }
  return env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY is not set on the backend.";
}

function modelFor(env, provider) {
  if (provider === "workers-ai") return env.WORKERS_AI_MODEL || WORKERS_AI_MODEL_DEFAULT;
  if (provider === "openai") return env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT;
  return CONTRACT.model;
}

function buildPrompt(text, rooms, items, outdoorTemp, sketch) {
  const roomLines = rooms
    .map((r) => `  - id=${JSON.stringify(r?.id)} name=${JSON.stringify(r?.name)} type=${JSON.stringify(r?.type)}`)
    .join("\n");
  const weather =
    outdoorTemp === null ? "The outdoor temperature is unknown." : `It is ${Math.round(outdoorTemp)} °C outside.`;
  const drawn = sketch
    ? `The person has ALSO drawn a box on the floor plan, ${Number(sketch.w ?? 0).toFixed(1)} x ` +
      `${Number(sketch.d ?? 0).toFixed(1)} m, inside ${sketch.roomName ?? sketch.roomId ?? "the home"} ` +
      `(room id ${JSON.stringify(sketch.roomId ?? null)}). See rule 6.\n\n`
    : "The person has not drawn anything on the plan.\n\n";
  const itemList = [...new Set(items)].sort().join(", ") || "(none)";

  return (
    `Rooms in this home:\n${roomLines}\n\n` +
    `Item types standing in it: ${itemList}\n\n` +
    `${weather}\n\n` +
    drawn +
    `The person typed:\n${JSON.stringify(text)}`
  );
}

/** Per-IP and whole-deployment budgets. Returns a message when spent, else null. */
async function checkBudget(env, request) {
  if (!env.BUDGET) return null; // no KV bound — caps are off, see worker/README.md

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hour = new Date().toISOString().slice(0, 13); // yyyy-mm-ddThh
  const day = hour.slice(0, 10);
  const ipKey = `ip:${ip}:${hour}`;
  const dayKey = `all:${day}`;

  const [ipCount, dayCount] = await Promise.all([
    env.BUDGET.get(ipKey).then((v) => Number(v) || 0),
    env.BUDGET.get(dayKey).then((v) => Number(v) || 0),
  ]);

  if (dayCount >= GLOBAL_PER_DAY) {
    return "The shared parser has hit today's limit. Your typed goals still work — the built-in word list reads them offline.";
  }
  if (ipCount >= PER_IP_PER_HOUR) {
    return "That is a lot of sentences in one hour. Try again shortly — the built-in word list still works in the meantime.";
  }

  // Counted before the call, not after: an overspend that only registers on
  // success is not a budget. KV is eventually consistent, so treat these as
  // approximate — they exist to bound a runaway, not to bill anyone.
  await Promise.all([
    env.BUDGET.put(ipKey, String(ipCount + 1), { expirationTtl: 7200 }),
    env.BUDGET.put(dayKey, String(dayCount + 1), { expirationTtl: 172800 }),
  ]);
  return null;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
