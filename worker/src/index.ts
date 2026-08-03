import Anthropic from "@anthropic-ai/sdk";

// The plain-language goal parser, reachable from the deployed app.
//
// WHY THIS EXISTS. The study app is published to GitHub Pages and opened by
// participants on their own computers. The local FastAPI backend that holds the
// API key runs on the researcher's laptop at 127.0.0.1:8000, which no
// participant's browser can reach — so the free-text parser, the whole point of
// the intent layer, was only ever available to the researcher. This Worker is
// the same endpoint at a public URL, with the key held server-side.
//
// The key never reaches the browser. Cloudflare stores it as a secret; the page
// only ever knows this Worker's address.
//
// The contract is deliberately identical to backend/app.py's /api/parse-goal —
// same request shape, same response shape, same error field — so the frontend
// cannot tell which one it is talking to, and the local backend remains usable
// for development with nothing to switch.

// Claude Sonnet 5 — strong at strict JSON, and fast enough to sit in front of a
// participant waiting for a result. Thinking is OFF and effort is low: this is
// a short, fully-specified extraction against a fixed schema, and the latency a
// person feels here matters more than reasoning depth.
const MODEL = "claude-sonnet-5";

/** The objective vocabulary, mirroring frontend/src/intent/objectives.ts and
 *  backend/goal_llm.py. Three enums; it has not changed since the solver was
 *  written. Whatever comes back is in this vocabulary, so it is still checkable
 *  against the simulation rather than being free-form text. */
const SCALARS = ["temperature", "contaminant", "draft"] as const;
const DIRECTIONS = ["low", "high"] as const;

const SCHEMA = {
  type: "object",
  properties: {
    objectives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scalar: { type: "string", enum: [...SCALARS] },
          direction: { type: "string", enum: [...DIRECTIONS] },
          regionId: {
            type: ["string", "null"],
            description: "id of the room the goal is ABOUT, or null if unclear",
          },
          sourceId: {
            type: ["string", "null"],
            description: "for smell goals: id of the room the smell comes from",
          },
        },
        required: ["scalar", "direction", "regionId", "sourceId"],
        additionalProperties: false,
      },
    },
  },
  required: ["objectives"],
  additionalProperties: false,
};

const SYSTEM = `You translate a non-expert's everyday comfort wish into a small fixed \
set of physical objectives an airflow simulator can score.

scalar:
  temperature  — how warm or cool somewhere is
  contaminant  — smell, odour, stale or stuffy air
  draft        — moving air you can feel on you

direction: "low" means minimise it, "high" means maximise it.
  "keep the bedroom cool"        -> temperature / low
  "warm up the living room"      -> temperature / high
  "no kitchen smell in the bed"  -> contaminant / low, region=bedroom, source=kitchen
  "don't blow air on the bed"    -> draft / low
  "get some fresh air in here"   -> contaminant / low

Rules:
- Use ONLY the room ids given to you. If the wish names no room you can identify,
  set regionId to null rather than guessing.
- sourceId is only for smell goals that name where the smell comes from;
  otherwise null.
- One wish can carry more than one objective ("cool but no draft on the bed").
- If the sentence expresses no comfort goal at all, return an empty list.`;

interface Room {
  id: string;
  name: string;
  type: string;
}

interface Env {
  /** Cloudflare secret — set with `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY?: string;
  /** Comma-separated origins allowed to call this Worker. Empty = allow any. */
  ALLOWED_ORIGINS?: string;
}

/** A participant types one sentence at a time; anything longer than this is not
 *  a comfort wish, and the cap is what stops a public endpoint from being a way
 *  to spend someone else's tokens. */
const MAX_TEXT_CHARS = 500;
const MAX_ROOMS = 20;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // No list configured = allow any origin. With a list, echo the caller's origin
  // only when it is on it — never "*" plus credentials, and never a bare echo.
  const ok = allowed.length === 0 || (origin !== null && allowed.includes(origin));
  return {
    "access-control-allow-origin": ok ? (origin ?? "*") : "null",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Mirrors the local backend's /api/health so the same probe works against
    // either one. `goalLlm` reports whether a key is present — not whether it is
    // valid; a rejected key still shows up as true here and as an error on the
    // first real parse, which is exactly how the local backend behaves.
    if (url.pathname === "/api/health") {
      return json({ goalLlm: Boolean(env.ANTHROPIC_API_KEY), model: MODEL }, 200, cors);
    }

    if (url.pathname !== "/api/parse-goal") return json({ error: "not found" }, 404, cors);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) {
      return json({ objectives: [], error: "no ANTHROPIC_API_KEY set on the backend" }, 200, cors);
    }

    let body: { text?: unknown; rooms?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ objectives: [], error: "body was not JSON" }, 200, cors);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const rooms: Room[] = Array.isArray(body.rooms)
      ? (body.rooms as Room[])
          .filter((r) => r && typeof r.id === "string")
          .slice(0, MAX_ROOMS)
          .map((r) => ({ id: r.id, name: String(r.name ?? ""), type: String(r.type ?? "") }))
      : [];

    if (!text) return json({ objectives: [] }, 200, cors);
    if (text.length > MAX_TEXT_CHARS) {
      return json({ objectives: [], error: "text too long" }, 200, cors);
    }

    const listing = rooms.map((r) => `- id=${JSON.stringify(r.id)} name=${JSON.stringify(r.name)} type=${JSON.stringify(r.type)}`).join("\n");

    let raw: string;
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM,
        thinking: { type: "disabled" },
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [
          { role: "user", content: `Rooms in this home:\n${listing}\n\nThe person said:\n${text}` },
        ],
      });
      // A refusal returns 200 with no text block, so check before reading.
      if (response.stop_reason === "refusal") {
        return json({ objectives: [], error: "refused" }, 200, cors);
      }
      const block = response.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        return json({ objectives: [], error: "empty response" }, 200, cors);
      }
      raw = block.text;
    } catch (e) {
      // Network, auth, rate limit — all non-fatal here. The frontend reads the
      // message to tell "the key was rejected" apart from "it did not
      // understand", so pass it through rather than flattening it.
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return json({ objectives: [], error: msg }, 200, cors);
    }

    let parsed: { objectives?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ objectives: [], error: "response was not JSON" }, 200, cors);
    }

    // Trust the schema for shape, but not the room ids — the model can still
    // name a room that isn't in this plan, and a bogus id would silently score
    // against nothing.
    const valid = new Set(rooms.map((r) => r.id));
    const objectives = (parsed.objectives ?? [])
      .filter(
        (o) =>
          SCALARS.includes(o.scalar as (typeof SCALARS)[number]) &&
          DIRECTIONS.includes(o.direction as (typeof DIRECTIONS)[number]),
      )
      .map((o) => ({
        scalar: o.scalar,
        direction: o.direction,
        regionId: typeof o.regionId === "string" && valid.has(o.regionId) ? o.regionId : null,
        sourceId: typeof o.sourceId === "string" && valid.has(o.sourceId) ? o.sourceId : null,
      }));

    return json({ objectives, model: MODEL }, 200, cors);
  },
};
