// Guided setup for the public goal parser.
//
//     cd worker && npm install && node setup.mjs
//
// Runs the wrangler steps in order, and does the two fiddly bits for you: it
// creates the KV namespace and writes its id into wrangler.toml (rather than
// leaving you to paste a hex string into a commented-out block), then checks
// the deployed endpoint actually answers before telling you it worked.
//
// TWO THINGS IT CANNOT DO FOR YOU, because they need credentials only you have:
// signing in to Cloudflare (it opens a browser and waits), and your Anthropic
// key (wrangler prompts for it and stores it on Cloudflare — the key never goes
// into this repo, this script, or the built page).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const CONFIG = new URL("./wrangler.toml", import.meta.url);
const rl = createInterface({ input: stdin, output: stdout });

const say = (...a) => console.log(...a);
const step = (n, title) => say(`\n[1m[${n}/5] ${title}[0m`);

/** Run a command with the terminal attached, so wrangler's prompts work. */
function run(args, { capture = false } = {}) {
  const res = spawnSync("npx", ["wrangler", ...args], {
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  return { code: res.status, out: res.stdout ?? "" };
}

function readConfig() {
  return readFileSync(CONFIG, "utf8");
}

/** True when a real KV id is already wired in (not the commented placeholder). */
function hasKvId(toml) {
  const live = toml
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  return /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"[0-9a-f]{8,}"/.test(live);
}

function writeKvId(id) {
  const toml = readConfig();
  // Match the file's own line endings. wrangler.toml is CRLF on Windows, and a
  // \n-only pattern does not fail loudly — it just misses, appends a second
  // block, and leaves the commented one sitting confusingly above it.
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const block = ["[[kv_namespaces]]", 'binding = "BUDGET"', `id = "${id}"`].join(eol);
  const commented = /#[ ]*\[\[kv_namespaces\]\]\r?\n#[ ]*binding = "BUDGET"\r?\n#[ ]*id = "paste-the-id-here"/;
  const next = commented.test(toml)
    ? toml.replace(commented, block)
    : `${toml.trimEnd()}${eol}${eol}${block}${eol}`;
  writeFileSync(CONFIG, next);
}

try {
  say("[1mSetting up the public goal parser.[0m");
  say("This puts the sentence-reader online so anyone with your link can use it.\n");
  say("You will need:");
  say("  1. A Cloudflare account (free — it will open a browser to sign in or sign up)");
  say("  2. An Anthropic API key from https://console.anthropic.com  (Settings -> API keys)");
  say("     with a little credit on it. A parse costs a fraction of a cent.\n");
  const go = await rl.question("Ready? [Y/n] ");
  if (go.trim().toLowerCase() === "n") {
    say("Nothing done.");
    process.exit(0);
  }

  // 1 ---------------------------------------------------------------------
  step(1, "Signing in to Cloudflare");
  const who = run(["whoami"], { capture: true });
  if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
    say("Opening a browser to sign in…");
    if (run(["login"]).code !== 0) throw new Error("Cloudflare sign-in did not complete.");
  } else {
    say("Already signed in.");
  }

  // 2 ---------------------------------------------------------------------
  step(2, "Creating the spending cap store");
  if (hasKvId(readConfig())) {
    say("Already configured — skipping.");
  } else {
    const kvOut = run(["kv", "namespace", "create", "BUDGET"], { capture: true }).out;
    const id = kvOut.match(/id\s*=\s*"([0-9a-f]{8,})"/i)?.[1];
    if (!id) {
      say(kvOut);
      throw new Error("Could not read the namespace id from wrangler's output. Paste it into wrangler.toml by hand.");
    }
    writeKvId(id);
    say(`Created, and written into wrangler.toml (id ${id.slice(0, 8)}…).`);
    say("This is what stops a runaway bill: 40 sentences per visitor per hour, 4,000 a day.");
  }

  // 3 ---------------------------------------------------------------------
  step(3, "Storing your Anthropic key");
  say("Paste your key at the prompt. It is stored on Cloudflare — never in this");
  say("repository, and never in the page anyone downloads.\n");
  if (run(["secret", "put", "ANTHROPIC_API_KEY"]).code !== 0) {
    throw new Error("Storing the key did not complete.");
  }

  // 4 ---------------------------------------------------------------------
  step(4, "Deploying");
  const deploy = run(["deploy"], { capture: true });
  say(deploy.out);
  if (deploy.code !== 0) throw new Error("Deploy failed — the output above says why.");
  const url = deploy.out.match(/https:\/\/[a-z0-9.-]*workers\.dev/i)?.[0];
  if (!url) throw new Error("Deployed, but could not find the URL in wrangler's output. Look for it above.");

  // 5 ---------------------------------------------------------------------
  step(5, "Checking it answers");
  const health = await fetch(`${url}/api/health`).then((r) => r.json());
  say(JSON.stringify(health));
  if (!health.goalParser) {
    throw new Error("It deployed but reports no key. Re-run and paste the key again at step 3.");
  }
  say(`Reading sentences with ${health.model}.`);

  say("\n[1mOne step left, and it is on github.com.[0m");
  say("The published page needs to be told where this lives:\n");
  say("  1. Open https://github.com/josephleonard04/interactive-airflow/settings/variables/actions");
  say("  2. Click 'New repository variable'");
  say("  3. Name:  GOAL_PARSER_URL");
  say(`  4. Value: ${url}`);
  say("  5. Click 'Add variable'\n");
  say("Then push any commit (or re-run the Pages workflow) and the site rebuilds");
  say("with the parser wired in. That is it.");
} catch (err) {
  console.error(`\n[31m${err.message}[0m`);
  console.error("Nothing is half-configured — re-running this script is safe.");
  process.exitCode = 1;
} finally {
  rl.close();
}
