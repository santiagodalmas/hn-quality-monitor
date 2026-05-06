// Cross-layer check: HN's homepage and Firebase API agree on top stories.
//
// Strict ordering between the cached HTML page and the API can drift by a
// few positions due to caching, so the contract here is set-based:
// every story shown in the UI's top N must appear somewhere in the API's
// top M of /topstories.json. With sane choices of N/M this catches real
// disagreements (e.g. a story that's on the homepage but not in the API
// list, or vice versa) while tolerating natural ranking lag.
//
// Run: node src/crosscheck/ui-vs-api.js [--headless]
// Auto-headless when CI=true.

const { chromium, request } = require("playwright");

const UI_TOP_N = 10; // top N stories visible on /news
const API_TOP_M = 50; // expected to appear within top M of /topstories.json
const REQUEST_TIMEOUT_MS = 15_000;

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function header(title) {
  const line = "━".repeat(60);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`  ${c.bold}${title}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);
}

async function fetchApiTopIds() {
  const api = await request.newContext({ timeout: REQUEST_TIMEOUT_MS });
  const res = await api.get("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!res.ok()) {
    await api.dispose();
    throw new Error(`Firebase API returned HTTP ${res.status()}`);
  }
  const ids = await res.json();
  await api.dispose();
  if (!Array.isArray(ids)) throw new Error("topstories.json did not return an array");
  return ids;
}

async function fetchUiTopIds(headless) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("https://news.ycombinator.com/news", { waitUntil: "domcontentloaded" });
  // Sanity: page must contain article rows. Otherwise we're looking at a rate-limit page.
  const count = await page.locator("tr.athing").count();
  if (count === 0) {
    await browser.close();
    throw new Error("homepage returned no article rows — likely rate-limited");
  }
  const ids = await page.$$eval("tr.athing", (rows) =>
    rows.map((row) => ({
      id: Number(row.id),
      title: row.querySelector(".titleline > a")?.textContent?.trim() ?? "",
    })),
  );
  await browser.close();
  return ids;
}

async function main() {
  const startedAt = Date.now();
  header("Cross-check: HN UI vs Firebase API");

  const headless = process.argv.includes("--headless") || process.env.CI === "true";

  console.log(`  ${c.dim}Fetching /topstories.json from Firebase API...${c.reset}`);
  const apiIds = await fetchApiTopIds();
  const apiTopSet = new Set(apiIds.slice(0, API_TOP_M));
  console.log(`  got ${apiIds.length} ids; using top ${API_TOP_M} as the agreement window\n`);

  console.log(`  ${c.dim}Fetching /news from the website...${c.reset}`);
  const uiItems = await fetchUiTopIds(headless);
  const uiTop = uiItems.slice(0, UI_TOP_N);
  console.log(`  got ${uiItems.length} stories on the homepage; checking the top ${UI_TOP_N}\n`);

  const disagreements = uiTop.filter((item) => !apiTopSet.has(item.id));

  if (disagreements.length === 0) {
    console.log(
      `${c.green}${c.bold}✓ All ${UI_TOP_N} top UI stories appear within the API's top ${API_TOP_M}.${c.reset}\n`,
    );
    console.log(`  ${c.dim}Sample agreement:${c.reset}`);
    for (const item of uiTop.slice(0, 3)) {
      console.log(`    id=${item.id}  "${item.title}"`);
    }
    console.log(`\n${c.dim}Finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.${c.reset}\n`);
    process.exit(0);
  }

  console.log(
    `${c.red}${c.bold}✗ ${disagreements.length} of ${UI_TOP_N} UI stories not found in API's top ${API_TOP_M}:${c.reset}\n`,
  );
  for (const item of disagreements) {
    console.log(`  id=${item.id}  "${item.title}"`);
  }
  console.log(
    `\n  ${c.yellow}Possible explanations:${c.reset} caching lag, ranking-algorithm divergence, ` +
      `or a real contract violation between the surfaces. Investigate before treating as a defect.\n`,
  );
  console.log(`${c.dim}Finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.${c.reset}\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n${c.red}${c.bold}✗ Unhandled error:${c.reset} ${err.message}\n`);
  process.exit(1);
});
