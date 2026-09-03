// Exercise the public goal parser without deploying it and without an API key.
//
//     node worker/check_worker.mjs
//
// Anthropic is stubbed, so what this checks is everything that stands between a
// stranger on the internet and that upstream call: the routing, the caps, the
// budgets, the CORS headers, and the id validation that keeps a hallucinated
// room out of the solver. The one thing it cannot check is whether the real API
// likes the request body — that needs a key, and the Worker degrades to an error
// string either way.

import assert from "node:assert/strict";
import worker from "./src/index.js";
import CONTRACT from "../shared/goal-contract.json" with { type: "json" };

const ORIGIN = "https://josephleonard04.github.io";
const ROOMS = [
  { id: "bedroom", name: "Bedroom", type: "bedroom" },
  { id: "living", name: "Living room", type: "living" },
];

/** A KV stand-in, so the budget logic runs the way it will in production. */
function kv() {
  const store = new Map();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
  };
}

let lastUpstream = null;
function stubAnthropic(reply, { ok = true, status = 200 } = {}) {
  globalThis.fetch = async (_url, init) => {
    lastUpstream = JSON.parse(init.body);
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  };
}

const post = (body, { origin = ORIGIN, ip = "1.2.3.4" } = {}) =>
  new Request("https://parser.example/api/parse-goal", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin, "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });

const OK_REPLY = {
  stop_reason: "end_turn",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        objectives: [
          {
            scalar: "temperature",
            direction: "high",
            regionId: "bedroom",
            nearItem: null,
            sourceId: null,
            usedSketch: true,
          },
        ],
      }),
    },
  ],
};

const env = () => ({ ANTHROPIC_API_KEY: "sk-test", BUDGET: kv() });

// --- routing -------------------------------------------------------------

{
  const e = env();
  const res = await worker.fetch(new Request("https://p.example/", { method: "GET", headers: { Origin: ORIGIN } }), e);
  assert.equal(res.status, 404, "only the one route exists");
  const health = await worker.fetch(
    new Request("https://p.example/api/health", { method: "GET", headers: { Origin: ORIGIN } }),
    e,
  );
  assert.equal(health.status, 200);
  assert.equal((await health.json()).goalParser, true);
  console.log("ok  one route, plus a health check that spends nothing");
}

{
  const res = await worker.fetch(
    new Request("https://p.example/api/parse-goal", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
    env(),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  console.log("ok  preflight answers the published origin");
}

{
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }, { origin: "https://evil.example" }), env());
  assert.notEqual(res.headers.get("Access-Control-Allow-Origin"), "https://evil.example");
  console.log("ok  another site is not handed permission to use it");
}

// --- the key ---------------------------------------------------------------

{
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), { BUDGET: kv() });
  const body = await res.json();
  // The frontend matches on this exact string to tell a missing key from a
  // rejected one, and shows different advice for each.
  assert.match(body.error, /ANTHROPIC_API_KEY is not set/);
  console.log("ok  a missing key reports the string the frontend keys off");
}

// --- caps ------------------------------------------------------------------

{
  stubAnthropic(OK_REPLY);
  const res = await worker.fetch(post({ text: "x".repeat(401), rooms: ROOMS }), env());
  assert.match((await res.json()).error, /400 characters or fewer/);

  const empty = await worker.fetch(post({ text: "   ", rooms: ROOMS }), env());
  assert.deepEqual(await empty.json(), { objectives: [] }, "an empty sentence costs nothing");
  console.log("ok  an oversized or empty sentence never reaches the model");
}

{
  stubAnthropic(OK_REPLY);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, type: "room" }));
  await worker.fetch(post({ text: "warm it up", rooms: many, items: Array(200).fill("bed") }), env());
  const prompt = lastUpstream.messages[0].content;
  assert.equal((prompt.match(/ {2}- id=/g) ?? []).length, 24, "rooms are capped before they reach the prompt");
  console.log("ok  oversized room and item lists are trimmed, not forwarded");
}

// --- the drawn region ------------------------------------------------------

{
  stubAnthropic(OK_REPLY);
  const res = await worker.fetch(
    post({
      text: "make this bit warmer",
      rooms: ROOMS,
      items: ["bed"],
      outdoor_temp: 4,
      sketch_region: { roomId: "bedroom", roomName: "Bedroom", x: 1, z: 2, w: 1.2, d: 0.9 },
    }),
    env(),
  );
  const prompt = lastUpstream.messages[0].content;
  assert.match(prompt, /1\.2 x 0\.9 m/, "the box's size reaches the prompt");
  assert.match(prompt, /inside Bedroom/, "the box's room reaches the prompt");
  assert.equal((await res.json()).objectives[0].usedSketch, true);
  console.log("ok  a drawn region reaches the model, same as the local backend");
}

{
  stubAnthropic(OK_REPLY); // claims usedSketch even though nothing was drawn
  const res = await worker.fetch(post({ text: "make this bit warmer", rooms: ROOMS }), env());
  assert.equal((await res.json()).objectives[0].usedSketch, false);
  assert.match(lastUpstream.messages[0].content, /has not drawn anything/);
  console.log("ok  usedSketch cannot be claimed when nothing was drawn");
}

// --- validation ------------------------------------------------------------

{
  stubAnthropic({
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          objectives: [
            { scalar: "temperature", direction: "high", regionId: "conservatory", nearItem: "yacht", sourceId: null },
            { scalar: "vibes", direction: "high", regionId: "bedroom", nearItem: null, sourceId: null },
          ],
        }),
      },
    ],
  });
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS, items: ["bed"] }), env());
  const { objectives } = await res.json();
  assert.equal(objectives.length, 1, "an objective outside the vocabulary is dropped entirely");
  assert.equal(objectives[0].regionId, null, "a room that does not exist is dropped");
  assert.equal(objectives[0].nearItem, null, "an item that does not exist is dropped");
  console.log("ok  hallucinated rooms, items and scalars do not reach the solver");
}

{
  stubAnthropic({ error: { message: "invalid x-api-key" } }, { ok: false, status: 401 });
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), env());
  assert.equal(res.status, 200, "an upstream failure must not look like a network failure");
  assert.match((await res.json()).error, /invalid x-api-key/);
  console.log("ok  a rejected key degrades to a message, not a dead fetch");
}

{
  stubAnthropic({ stop_reason: "refusal", content: [] });
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), env());
  assert.match((await res.json()).error, /declined/);
  console.log("ok  a refusal says so rather than reporting 'no goal'");
}

// --- the Anthropic request shape -------------------------------------------

{
  stubAnthropic(OK_REPLY);
  await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), env());

  // Exact id, no date suffix — a suffixed variant is a 404 at request time and
  // there is no way to notice that from here except by asserting it.
  assert.equal(lastUpstream.model, "claude-haiku-4-5");
  assert.equal(lastUpstream.model, CONTRACT.model, "the worker sends what the contract says");

  // Haiku 4.5 predates adaptive thinking and `effort`, and rejects both. It is
  // the right model for mapping one sentence onto three scalars, but only if we
  // do not send it the newer models' parameters.
  assert.equal(lastUpstream.thinking, undefined, "no thinking param on a pre-4.6 model");
  assert.equal(lastUpstream.output_config?.effort, undefined, "no effort param on a pre-4.6 model");

  // Structured outputs live under output_config.format; `output_format` is the
  // deprecated spelling.
  assert.equal(lastUpstream.output_config.format.type, "json_schema");
  assert.equal(lastUpstream.output_format, undefined, "the deprecated parameter is not used");
  console.log("ok  the Anthropic request matches what Haiku 4.5 accepts");
}

// --- the OpenAI provider ---------------------------------------------------

{
  // Same objective vocabulary, different wire shape: chat completions puts the
  // JSON in choices[0].message.content rather than in a content block.
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                objectives: [
                  { scalar: "draft", direction: "low", regionId: "living", nearItem: null, sourceId: null, usedSketch: false },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const e = { OPENAI_API_KEY: "sk-openai-test", LLM_PROVIDER: "openai", BUDGET: kv() };
  const res = await worker.fetch(post({ text: "no wind on me please", rooms: ROOMS }), e);
  const body = await res.json();

  assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
  assert.match(seen.headers.authorization, /^Bearer sk-openai-test$/);
  assert.equal(seen.body.model, "gpt-4.1-mini", "a sensible default model");
  assert.equal(seen.body.response_format.type, "json_schema");
  assert.equal(seen.body.response_format.json_schema.strict, true);
  assert.equal(seen.body.messages[0].role, "system");
  assert.deepEqual(body.objectives[0], {
    scalar: "draft", direction: "low", regionId: "living", nearItem: null, sourceId: null, usedSketch: false,
  });
  console.log("ok  the OpenAI route answers in the same objective vocabulary");
}

{
  // Strict mode requires this of every object in the schema, and OpenAI rejects
  // the request outright if it is missing — so assert it rather than discover it
  // on the first live call.
  const items = CONTRACT.schema.properties.objectives.items;
  assert.equal(CONTRACT.schema.additionalProperties, false);
  assert.equal(items.additionalProperties, false);
  assert.deepEqual(
    [...items.required].sort(),
    Object.keys(items.properties).sort(),
    "strict mode needs every property listed in required",
  );
  console.log("ok  the shared schema satisfies OpenAI strict mode");
}

{
  const e = { LLM_PROVIDER: "openai", BUDGET: kv() };
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), e);
  assert.match((await res.json()).error, /OPENAI_API_KEY is not set/, "names the key the deploy is missing");
  console.log("ok  a missing OpenAI key names OPENAI_API_KEY, not the Anthropic one");
}

{
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { refusal: "no" } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  const e = { OPENAI_API_KEY: "sk-test", LLM_PROVIDER: "openai", BUDGET: kv() };
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), e);
  assert.match((await res.json()).error, /declined/, "a strict-schema refusal is its own field");
  console.log("ok  an OpenAI refusal is read from message.refusal");
}

// --- budgets ---------------------------------------------------------------

{
  stubAnthropic(OK_REPLY);
  const e = env();
  let limited = null;
  for (let i = 0; i < 45; i++) {
    const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }, { ip: "9.9.9.9" }), e);
    const body = await res.json();
    if (body.error) { limited = { at: i, error: body.error }; break; }
  }
  assert.ok(limited, "one IP must eventually be throttled");
  assert.equal(limited.at, 40, "throttled at the per-IP hourly cap");
  assert.match(limited.error, /built-in word list/, "and told the app still works without it");

  // A different visitor is unaffected by that one.
  const other = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }, { ip: "8.8.8.8" }), e);
  assert.ok((await other.json()).objectives, "a different visitor is not caught by someone else's limit");
  console.log("ok  per-IP budget throttles one visitor without blocking the rest");
}

{
  stubAnthropic(OK_REPLY);
  const e = env();
  const day = new Date().toISOString().slice(0, 10);
  await e.BUDGET.put(`all:${day}`, "4000");
  const res = await worker.fetch(post({ text: "warm it up", rooms: ROOMS }), e);
  assert.match((await res.json()).error, /today's limit/);
  console.log("ok  the whole-deployment daily cap stops a runaway bill");
}

console.log("\nworker checks passed");
