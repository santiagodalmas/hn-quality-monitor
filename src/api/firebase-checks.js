// Hacker News Firebase API — Contract Checks
// Validates the documented behavior of https://hacker-news.firebaseio.com/v0/
// against the API spec at https://github.com/HackerNews/API.
//
// Run: node src/api/firebase-checks.js
// Exits 0 on all-pass, 1 if any check fails.

const { request } = require("playwright");

const BASE = "https://hacker-news.firebaseio.com/v0";
const REQUEST_TIMEOUT_MS = 10_000;
const MEDIAN_RESPONSE_THRESHOLD_MS = 2_000;
const MAX_LIST_LENGTH = 500; // documented cap on topstories/newstories/etc.

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function header(title) {
  const line = "━".repeat(60);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`  ${c.bold}${title}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);
}

function pass(label, detail) {
  const tail = detail ? `  ${c.dim}— ${detail}${c.reset}` : "";
  console.log(`  ${c.green}✓${c.reset} ${label}${tail}`);
  return { passed: true, label, detail };
}

function fail(label, reason) {
  console.log(`  ${c.red}✗${c.reset} ${label}  ${c.red}— ${reason}${c.reset}`);
  return { passed: false, label, reason };
}

async function getJSON(api, path) {
  const t0 = Date.now();
  const res = await api.get(`${BASE}${path}`);
  const elapsed = Date.now() - t0;
  if (!res.ok()) {
    return { ok: false, status: res.status(), elapsed };
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, status: res.status(), elapsed, parseError: e.message };
  }
  return { ok: true, status: res.status(), elapsed, body };
}

async function checkList(api, path) {
  const r = await getJSON(api, path);
  if (!r.ok) return fail(path, `HTTP ${r.status}${r.parseError ? " — " + r.parseError : ""}`);
  if (!Array.isArray(r.body)) return fail(path, `expected array, got ${typeof r.body}`);
  if (r.body.length === 0) return fail(path, "empty list");
  if (r.body.length > MAX_LIST_LENGTH) {
    return fail(path, `expected ≤${MAX_LIST_LENGTH} ids, got ${r.body.length}`);
  }
  if (!r.body.every(Number.isInteger)) {
    return fail(path, "expected array of integers");
  }
  return pass(path, `${r.body.length} ids in ${r.elapsed}ms`);
}

async function checkMaxItem(api) {
  const r = await getJSON(api, "/maxitem.json");
  if (!r.ok) return fail("/maxitem.json", `HTTP ${r.status}`);
  if (!Number.isInteger(r.body) || r.body <= 0) {
    return fail("/maxitem.json", `expected positive integer, got ${r.body}`);
  }
  return pass("/maxitem.json", `current max id = ${r.body} (${r.elapsed}ms)`);
}

async function checkItemSchema(api, id) {
  const r = await getJSON(api, `/item/${id}.json`);
  if (!r.ok) return fail(`/item/${id}.json`, `HTTP ${r.status}`);
  if (!r.body) return fail(`/item/${id}.json`, "null body — item may be deleted/missing");
  // Per HN API spec, every item has id, type, time, by (unless deleted/dead).
  // type-specific required fields below.
  const required = ["id", "type", "time"];
  const missing = required.filter((f) => !(f in r.body));
  if (missing.length) return fail(`/item/${id}.json`, `missing required fields: ${missing.join(", ")}`);
  if (r.body.id !== id) return fail(`/item/${id}.json`, `id mismatch: requested ${id}, got ${r.body.id}`);
  if (typeof r.body.time !== "number") return fail(`/item/${id}.json`, `time should be number, got ${typeof r.body.time}`);
  if (typeof r.body.type !== "string") return fail(`/item/${id}.json`, `type should be string, got ${typeof r.body.type}`);
  // Stories specifically: should have title and (score or descendants).
  if (r.body.type === "story") {
    if (typeof r.body.title !== "string" || r.body.title.length === 0) {
      return fail(`/item/${id}.json`, "story missing title");
    }
  }
  return pass(`/item/${id}.json`, `type=${r.body.type}, time=${new Date(r.body.time * 1000).toISOString().slice(0, 19)}Z`);
}

async function checkResponseTime(api, samples = 5) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const r = await getJSON(api, "/topstories.json");
    if (!r.ok) return fail("response time", `sample ${i + 1} failed with HTTP ${r.status}`);
    times.push(r.elapsed);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median > MEDIAN_RESPONSE_THRESHOLD_MS) {
    return fail(
      "response time",
      `median=${median}ms exceeds ${MEDIAN_RESPONSE_THRESHOLD_MS}ms threshold (samples: ${times.join("ms, ")}ms)`,
    );
  }
  return pass("response time", `median=${median}ms across ${samples} samples`);
}

async function checkUserShape(api, username) {
  const r = await getJSON(api, `/user/${username}.json`);
  if (!r.ok) return fail(`/user/${username}.json`, `HTTP ${r.status}`);
  if (!r.body) return fail(`/user/${username}.json`, "null body");
  const required = ["id", "created", "karma"];
  const missing = required.filter((f) => !(f in r.body));
  if (missing.length) return fail(`/user/${username}.json`, `missing fields: ${missing.join(", ")}`);
  if (r.body.id !== username) return fail(`/user/${username}.json`, `id mismatch`);
  return pass(`/user/${username}.json`, `karma=${r.body.karma}`);
}

async function main() {
  const startedAt = Date.now();
  header("HN Firebase API — Contract Checks");

  const api = await request.newContext({ timeout: REQUEST_TIMEOUT_MS });
  const results = [];

  results.push(await checkList(api, "/topstories.json"));
  results.push(await checkList(api, "/newstories.json"));
  results.push(await checkList(api, "/beststories.json"));
  results.push(await checkMaxItem(api));

  // Sample one item from topstories for schema validation.
  const topRes = await getJSON(api, "/topstories.json");
  if (topRes.ok && Array.isArray(topRes.body) && topRes.body.length > 0) {
    results.push(await checkItemSchema(api, topRes.body[0]));
  } else {
    results.push(fail("item schema", "couldn't fetch a sample id from /topstories.json"));
  }

  // Sample a well-known stable user account for /user/ schema.
  results.push(await checkUserShape(api, "pg"));

  results.push(await checkResponseTime(api));

  await api.dispose();

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const elapsed = Date.now() - startedAt;

  console.log("");
  if (passed === total) {
    console.log(`${c.green}${c.bold}✓ ${passed}/${total} API checks passed.${c.reset}`);
  } else {
    console.log(`${c.red}${c.bold}✗ ${passed}/${total} API checks passed.${c.reset}`);
  }
  console.log(`${c.dim}Finished in ${(elapsed / 1000).toFixed(1)}s.${c.reset}\n`);

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${c.red}${c.bold}✗ Unhandled error:${c.reset} ${err.message}\n`);
  process.exit(1);
});
