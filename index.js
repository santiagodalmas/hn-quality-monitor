// Hacker News /newest — Sort Validator
// Validates that the first 100 articles on https://news.ycombinator.com/newest
// are sorted from newest to oldest.
//
// Setup: npm install && npx playwright install chromium
// Run:   node index.js              (headed — good for demos)
//        node index.js --headless   (headless — good for CI)
// Auto-headless when CI=true.
// Exits with code 0 on success, 1 on failure.

const { chromium } = require("playwright");

const TARGET_COUNT = 100;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const MAX_PAGINATION_CLICKS = 10; // 30 items per page; 4 is enough, 10 is generous
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 10_000;
const POLITE_DELAY_MS = 1_500; // brief pause between successful page loads

// Minimal ANSI colors — no dependency, degrades gracefully in plain terminals.
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

function fmtDate(d) {
  // YYYY-MM-DD HH:mm:ss UTC
  const iso = d.toISOString(); // 2026-05-05T16:42:33.000Z
  return iso.slice(0, 10) + " " + iso.slice(11, 19) + " UTC";
}

function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// HN's <span class="age" title="..."> contains either an ISO-like string,
// or "ISO unix" (recent format). Unix is the most reliable, so prefer it.
function parseHNTimestamp(title) {
  if (!title) return null;
  const parts = title.trim().split(/\s+/);
  if (parts.length >= 2) {
    const unix = Number(parts[1]);
    if (Number.isFinite(unix)) return new Date(unix * 1000);
  }
  // Fallback: ISO without timezone — HN reports UTC, so append Z.
  const d = new Date(parts[0] + "Z");
  return isNaN(d.getTime()) ? null : d;
}

// Returns { healthy: bool, reason: string } describing whether the current
// page is a usable HN listing. Treats anything without article rows — empty
// pages, Cloudflare challenges, HN's own apology — as unhealthy so we can
// retry.
async function pageHealth(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (/not able to serve your requests/i.test(body)) {
    return { healthy: false, reason: "HN rate-limit apology" };
  }
  if (/just a moment|attention required|cloudflare/i.test(body)) {
    return { healthy: false, reason: "Cloudflare challenge" };
  }
  const athingCount = await page.locator("tr.athing").count();
  if (athingCount === 0) {
    return { healthy: false, reason: "no article rows on page" };
  }
  return { healthy: true, reason: "ok" };
}

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
    const health = await pageHealth(page);
    if (health.healthy) return;
    const waitMs = RATE_LIMIT_BACKOFF_MS * attempt;
    console.log(
      `  ${c.yellow}page unhealthy (${health.reason}), retrying in ${waitMs / 1000}s ` +
        `(attempt ${attempt}/${RATE_LIMIT_MAX_RETRIES})${c.reset}`,
    );
    await page.waitForTimeout(waitMs);
  }
  throw new Error(`Gave up loading ${url} — page never became healthy.`);
}

async function recoverIfUnhealthy(page, label) {
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const health = await pageHealth(page);
    if (health.healthy) return true;
    const waitMs = RATE_LIMIT_BACKOFF_MS * attempt;
    console.log(
      `  ${c.yellow}${label} unhealthy (${health.reason}), backing off ${waitMs / 1000}s ` +
        `and reloading (attempt ${attempt}/${RATE_LIMIT_MAX_RETRIES})${c.reset}`,
    );
    await page.waitForTimeout(waitMs);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }
  return false;
}

async function collectArticlesOnPage(page) {
  return page.$$eval("tr.athing", (rows) =>
    rows.map((row, idx) => {
      const titleLink = row.querySelector(".titleline > a");
      const title = titleLink ? titleLink.textContent.trim() : "(untitled)";
      const id = row.id;
      const ageSpan = row.nextElementSibling
        ? row.nextElementSibling.querySelector("span.age")
        : null;
      const ageTitle = ageSpan ? ageSpan.getAttribute("title") : null;
      const ageText = ageSpan ? ageSpan.textContent.trim() : null;
      return { id, title, ageTitle, ageText, indexOnPage: idx };
    }),
  );
}

async function fetchFirstNArticles(page, n) {
  await gotoWithRetry(page, "https://news.ycombinator.com/newest");

  const collected = [];
  let pageNum = 1;
  console.log(`  ${c.dim}page ${pageNum}${c.reset} loaded — collecting articles...`);
  collected.push(...(await collectArticlesOnPage(page)));
  console.log(`  collected ${collected.length} so far`);

  while (collected.length < n && pageNum <= MAX_PAGINATION_CLICKS) {
    // Be polite — HN rate-limits aggressively, especially against cloud IPs.
    await page.waitForTimeout(POLITE_DELAY_MS);

    const moreLink = page.locator("a.morelink");
    if ((await moreLink.count()) === 0) {
      throw new Error(
        `"More" link not found on page ${pageNum}; cannot reach ${n} articles ` +
          `(only got ${collected.length}).`,
      );
    }
    pageNum += 1;
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      moreLink.first().click(),
    ]);

    if (!(await recoverIfUnhealthy(page, `page ${pageNum}`))) {
      throw new Error(
        `Page ${pageNum} stayed unhealthy after ${RATE_LIMIT_MAX_RETRIES} retries — ` +
          `Hacker News appears to be rate-limiting this client.`,
      );
    }

    console.log(`  ${c.dim}page ${pageNum}${c.reset} loaded — collecting articles...`);
    const before = collected.length;
    collected.push(...(await collectArticlesOnPage(page)));
    if (collected.length === before) {
      throw new Error(
        `Page ${pageNum} loaded but contained no articles after retries — aborting.`,
      );
    }
    console.log(`  collected ${collected.length} so far`);
  }

  if (collected.length < n) {
    throw new Error(
      `Only collected ${collected.length} articles after ${pageNum} pages; expected ${n}.`,
    );
  }
  return collected.slice(0, n);
}

function validateSortOrder(articles) {
  // Newest-to-oldest means each timestamp must be >= the next one.
  // Equal timestamps are allowed (HN posts can share a minute).
  const parsed = articles.map((a, i) => {
    const date = parseHNTimestamp(a.ageTitle);
    return { ...a, position: i + 1, date };
  });

  const unparsable = parsed.filter((a) => !a.date);
  const inversions = [];
  for (let i = 0; i < parsed.length - 1; i++) {
    const prev = parsed[i];
    const next = parsed[i + 1];
    if (!prev.date || !next.date) continue;
    if (prev.date.getTime() < next.date.getTime()) {
      inversions.push({ prev, next });
    }
  }
  return { parsed, unparsable, inversions };
}

function printSuccessReport(parsed) {
  const newest = parsed[0];
  const oldest = parsed[parsed.length - 1];
  const spanMs = newest.date.getTime() - oldest.date.getTime();

  console.log(`${c.green}${c.bold}✓ All 100 articles are sorted newest → oldest.${c.reset}\n`);
  console.log(`  ${c.dim}Newest:${c.reset} ${fmtDate(newest.date)}  ${c.dim}—${c.reset} "${newest.title}"`);
  console.log(`  ${c.dim}Oldest:${c.reset} ${fmtDate(oldest.date)}  ${c.dim}—${c.reset} "${oldest.title}"`);
  console.log(`  ${c.dim}Span:  ${c.reset} ${fmtDuration(spanMs)}\n`);
}

function printFailureReport(parsed, unparsable, inversions) {
  console.log(`${c.red}${c.bold}✗ Sort order is broken.${c.reset}\n`);

  if (unparsable.length) {
    console.log(`  ${c.yellow}${unparsable.length} article(s) had unparsable timestamps:${c.reset}`);
    for (const a of unparsable.slice(0, 5)) {
      console.log(`    #${a.position}  id=${a.id}  title="${a.title}"  raw="${a.ageTitle}"`);
    }
    if (unparsable.length > 5) console.log(`    ...and ${unparsable.length - 5} more`);
    console.log("");
  }

  if (inversions.length) {
    console.log(`  ${c.red}${inversions.length} out-of-order pair(s):${c.reset}`);
    const limit = Math.min(inversions.length, 10);
    for (let i = 0; i < limit; i++) {
      const { prev, next } = inversions[i];
      console.log(
        `    #${String(prev.position).padStart(3)}  ${fmtDate(prev.date)}  "${prev.title}"`,
      );
      console.log(
        `    #${String(next.position).padStart(3)}  ${fmtDate(next.date)}  "${next.title}"  ` +
          `${c.red}← newer than #${prev.position}${c.reset}`,
      );
      console.log("");
    }
    if (inversions.length > limit) {
      console.log(`    ...and ${inversions.length - limit} more inversion(s)`);
    }
  }
}

async function sortHackerNewsArticles() {
  const startedAt = Date.now();
  header("Hacker News /newest — Sort Validation");

  const headless = process.argv.includes("--headless") || process.env.CI === "true";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  let exitCode = 0;
  try {
    const articles = await fetchFirstNArticles(page, TARGET_COUNT);

    if (articles.length !== TARGET_COUNT) {
      throw new Error(`Expected exactly ${TARGET_COUNT} articles, got ${articles.length}.`);
    }

    console.log(`\nValidating sort order across ${articles.length} articles...\n`);
    const { parsed, unparsable, inversions } = validateSortOrder(articles);

    if (inversions.length === 0 && unparsable.length === 0) {
      printSuccessReport(parsed);
    } else {
      printFailureReport(parsed, unparsable, inversions);
      exitCode = 1;
    }
  } catch (err) {
    console.error(`\n${c.red}${c.bold}✗ Run failed:${c.reset} ${err.message}\n`);
    exitCode = 1;
  } finally {
    await browser.close();
    console.log(`${c.dim}Finished in ${fmtDuration(Date.now() - startedAt)}.${c.reset}\n`);
    process.exit(exitCode);
  }
}

(async () => {
  await sortHackerNewsArticles();
})();
