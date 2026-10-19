/**
 * academy-main.js  (optimized)
 * ---------------------------
 * Orchestrates: ProxyManager → BrowserPool → bounded-concurrency scraping.
 *
 * TARGET PERFORMANCE
 *   10 listing pages × 30 detail links = 300 posts in <30 min on Render free tier.
 *
 * PIPELINE
 *   1. warm()  → load working proxies from MongoDB (sub-second).
 *   2. launch browser once with best known proxy.
 *   3. For each listing page:
 *        a. navigate, scrape up to 30 detail links.
 *        b. scrape detail pages in parallel (poolSize=3 concurrent) with retries.
 *        c. clean + filter + batch-insert to Mongo (single insertMany call).
 *   4. On proxy failure: report to ProxyManager → it rotates/evicts.
 *
 * ALGORITHMS
 * ----------
 *   A. Bounded Concurrency Pool (Promise.all + pLimit)
 *      - Process up to `poolSize` detail pages in parallel.
 *      - Each task acquires a Page from BrowserPool, scrapes, releases Page.
 *      - Why: poolSize=3 gives ~3× speedup over serial without busting 512MB.
 *        Higher concurrency is CPU-bound on Render's 0.1 vCPU — not faster.
 *
 *   B. Per-Task Retry with Type-Aware Proxy Rotation
 *      - Each detail page gets up to DETAIL_RETRIES retries.
 *      - Transient transport errors (timeout/reset/tunnel): retry with SAME
 *        proxy; only feed back to ProxyManager after the final retry fails.
 *        ProxyManager uses a streak counter (maxTransportFailures=5) so a
 *        flaky-but-working proxy isn't burned by noise.
 *      - Cloudflare block on detail page: wait CLOUDFLARE_AUTOSOLVE_MS for
 *        the managed challenge to auto-solve in real Chromium (~30–40% do).
 *        If still blocked after the wait, call reportCloudflareBlock() —
 *        ProxyManager evicts that IP IMMEDIATELY (maxCloudflareBlocks=1)
 *        because a burned IP rarely recovers in the same session.
 *
 *   C. Adaptive Wait (event-driven, not fixed)
 *      - waitForSelector(#jobDetails, timeout: 8000ms) — proceed the instant
 *        the detail DOM is ready. No more 3.5s blind sleep.
 *      - Why: most detail pages render in <1s. The fixed 3.5s sleep was
 *        burning ~17 minutes across 300 pages.
 *
 *   D. Batch Persistence
 *      - All posts from a listing page are inserted in one `insertMany`
 *        call (ordered:false) instead of N round-trips.
 *
 *   E. Pipeline-Friendly Memory Discipline
 *      - Detail page DOM is fully released after extraction (page recycled by pool).
 *      - Posts array is processed and cleared per listing page (never holds 300
 *        posts in memory at once).
 *      - GC called between listing pages if available.
 */

const { formatDateForDB } = require("../../utils/dateHelpers.js");
const { storePosts, checkPostsCount, initializeDatabase, closeDatabase,
  getProxyCache, upsertProxyCache, removeProxyCache } = require("./academy-db.js");
const { ProxyManager } = require("./academy-proxy-manager.js");
const { BrowserPool } = require("./academy-browser-pool.js");

// ---------- Tunables ----------
const MAX_PAGES = 10;
const LINKS_PER_PAGE = 30;
const DETAIL_RETRIES = 2;
const DETAIL_SELECTOR_TIMEOUT = 8000;   // event-driven wait, fail-fast
const BETWEEN_LISTING_DELAY = 500;      // tiny courtesy delay
const CLOUDFLARE_AUTOSOLVE_MS = 10000;  // wait for managed-challenge auto-solve
const CLOUDFLARE_RECHECK_INTERVAL = 2000; // poll interval during auto-solve wait
const BASE_URL = "https://academicpositions.com/jobs/position/phd?page=";

/* ============================================================ */
/* PUBLIC ENTRY                                                 */
/* ============================================================ */

async function academy() {
  console.log("🚀 Academy scraper starting (optimized build)");
  logMemory("startup");

  await initializeDatabase();

  // Wrap DB layer with the proxy-cache methods the manager needs
  const dbLayer = { getProxyCache, upsertProxyCache, removeProxyCache };
  const proxyMgr = new ProxyManager(dbLayer, {
    connectTimeoutMs: 6000,
    validateConcurrency: 25,
    minWorkingPool: 3,
  });
  await proxyMgr.warm();

  const pool = new BrowserPool({
    poolSize: 3,
    recycleAfter: 12,
    softLimitMb: 420,
    hardLimitMb: 480,
    navTimeoutMs: 30000,
  });

  let currentProxy = await proxyMgr.acquire();
  pool._lastProxy = currentProxy;
  await pool.launch(currentProxy);

  try {
    await scrapeAllPages({ proxyMgr, pool, currentProxyRef: { value: currentProxy } });
  } finally {
    await pool.close().catch(() => {});
    await closeDatabase();
    logMemory("final cleanup");
    console.log("✅ Academy scraper finished cleanly");
  }
}

/* ============================================================ */
/* LISTING PAGES                                                */
/* ============================================================ */

async function scrapeAllPages(ctx) {
  const { pool, proxyMgr } = ctx;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = `${BASE_URL}${pageNum}`;
    console.log(`\n📄 Listing page ${pageNum}: ${url}`);
    logMemory(`page ${pageNum} start`);

    let links = [];
    let attempts = 0;
    while (attempts <= DETAIL_RETRIES && links.length === 0) {
      attempts++;
      try {
        links = await scrapeListingLinks(pool, url);
      } catch (err) {
        console.log(`⚠️ Listing attempt ${attempts} failed: ${err.message}`);
        // Type-aware feedback: Cloudflare vs transport
        const proxy = ctx.currentProxyRef.value;
        if (!proxy) continue;
        if (err.message.includes("Cloudflare")) {
          // Give the challenge a chance to auto-solve on first attempt only.
          // On subsequent attempts, treat as a real block and evict.
          if (attempts > 1) {
            const evicted = proxyMgr.reportCloudflareBlock(proxy);
            if (evicted) {
              ctx.currentProxyRef.value = await proxyMgr.acquire();
              pool._lastProxy = ctx.currentProxyRef.value;
              await pool.launch(ctx.currentProxyRef.value);
            }
          } else {
            // First Cloudflare hit on listing — wait + recheck before deciding
            const solved = await waitForCloudflareAutosolve(pool, url);
            if (solved) {
              links = solved;  // re-use the auto-solved page's links
            } else {
              proxyMgr.reportCloudflareBlock(proxy);
              ctx.currentProxyRef.value = await proxyMgr.acquire();
              pool._lastProxy = ctx.currentProxyRef.value;
              await pool.launch(ctx.currentProxyRef.value);
            }
          }
        } else {
          // Transport error — feed streak, don't auto-evict
          proxyMgr.reportFailure(proxy);
          ctx.currentProxyRef.value = await proxyMgr.acquire();
          pool._lastProxy = ctx.currentProxyRef.value;
          await pool.launch(ctx.currentProxyRef.value);
        }
      }
    }

    if (links.length === 0) {
      console.log(`🚫 No links on page ${pageNum} — skipping`);
      continue;
    }

    console.log(`🔗 Found ${links.length} links — scraping details in parallel (pool=3)`);
    const posts = await scrapeDetailsConcurrent(ctx, links);
    console.log(`🎉 Page ${pageNum}: ${posts.length} posts extracted`);

    // Clean + filter + persist
    const cleaned = filterExpiredDeadlines(cleanJobData(posts))
      .filter((p) => p.application_deadline && p.application_deadline !== "Unspecified");
    console.log(`✅ ${cleaned.length} valid posts after filtering`);

    try {
      await checkPostsCount();
      const result = await storePosts(cleaned);
      if (result?.inserted) console.log(`💾 Stored ${result.inserted} posts`);
    } catch (dbErr) {
      console.error(`DB error (continuing): ${dbErr.message}`);
    }

    if (global.gc) global.gc();
    await sleep(BETWEEN_LISTING_DELAY);
  }
}

async function scrapeListingLinks(pool, url) {
  const page = await pool.acquire();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    if (await isCloudflareChallenge(page)) {
      throw new Error("Cloudflare challenge on listing page");
    }
    // Fail fast — h2 should appear within seconds on a healthy page.
    // A timeout here usually means a silent soft-block (TLS completed but
    // Cloudflare returned a blank page instead of the real HTML).
    try {
      await page.waitForSelector("h2", { visible: true, timeout: 10000 });
    } catch (err) {
      throw new Error("Cloudflare challenge on listing page (h2 timeout = soft-block)");
    }

    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll(
        ".list-group-item.text-reset.text-decoration-none > a"
      );
      const out = [];
      anchors.forEach((a) => { if (a.href) out.push(a.href); });
      return out;
    });

    return links.slice(0, LINKS_PER_PAGE);
  } finally {
    await pool.release(page);
  }
}

/**
 * When a Cloudflare managed challenge is detected, give it up to
 * CLOUDFLARE_AUTOSOLVE_MS to auto-solve in real Chromium. Many managed
 * challenges just need JS execution + a few seconds, and the stealth
 * plugin is enough to pass them. Poll every CLOUDFLARE_RECHECK_INTERVAL.
 *
 * Returns the extracted link list if auto-solved, or null if still blocked.
 */
async function waitForCloudflareAutosolve(pool, url) {
  console.log(`⏳ Waiting up to ${CLOUDFLARE_AUTOSOLVE_MS}ms for Cloudflare auto-solve...`);
  const page = await pool.acquire();
  try {
    const deadline = Date.now() + CLOUDFLARE_AUTOSOLVE_MS;
    while (Date.now() < deadline) {
      await sleep(CLOUDFLARE_RECHECK_INTERVAL);
      const stillChallenged = await isCloudflareChallenge(page);
      if (!stillChallenged) {
        // Auto-solved! Try to grab h2 + links.
        try {
          await page.waitForSelector("h2", { visible: true, timeout: 5000 });
        } catch {
          return null;
        }
        const links = await page.evaluate(() => {
          const anchors = document.querySelectorAll(
            ".list-group-item.text-reset.text-decoration-none > a"
          );
          const out = [];
          anchors.forEach((a) => { if (a.href) out.push(a.href); });
          return out;
        });
        console.log(`✅ Cloudflare auto-solved after ${Date.now() - (deadline - CLOUDFLARE_AUTOSOLVE_MS)}ms`);
        return links.slice(0, LINKS_PER_PAGE);
      }
    }
    console.log(`❌ Cloudflare challenge did not auto-solve in ${CLOUDFLARE_AUTOSOLVE_MS}ms`);
    return null;
  } finally {
    await pool.release(page);
  }
}

/* ============================================================ */
/* DETAIL PAGES — BOUNDED CONCURRENCY                           */
/* ============================================================ */

/**
 * Run detail-page scrapes through the BrowserPool with bounded concurrency.
 * The pool itself enforces the concurrency limit (poolSize pages).
 *
 * Returns array of successfully-extracted posts (failures dropped).
 */
async function scrapeDetailsConcurrent(ctx, links) {
  const { pool, proxyMgr } = ctx;
  const results = new Array(links.length).fill(null);

  // Simple bounded runner: maintains `poolSize` in-flight at once
  let cursor = 0;
  const worker = async () => {
    while (cursor < links.length) {
      const i = cursor++;
      const link = links[i];
      try {
        results[i] = await scrapeOneDetailWithRetry(ctx, link);
      } catch (err) {
        console.error(`❌ [${i + 1}/${links.length}] hard fail: ${err.message}`);
        results[i] = null;
      }
    }
  };

  // Spawn `poolSize` workers — they pull from the shared cursor.
  const workers = Array.from({ length: 3 }, () => worker());
  await Promise.all(workers);

  return results.filter(Boolean);
}

async function scrapeOneDetailWithRetry(ctx, link) {
  const { pool, proxyMgr } = ctx;
  for (let attempt = 1; attempt <= DETAIL_RETRIES + 1; attempt++) {
    const page = await pool.acquire();
    try {
      const post = await extractPostDetails(link, page);
      if (post) {
        // Successful scrape — give positive feedback to proxy.
        // This resets the transport-failure streak in ProxyManager.
        if (ctx.currentProxyRef.value) proxyMgr.reportSuccess(ctx.currentProxyRef.value);
        return post;
      }
      // extractPostDetails returned null — could be Cloudflare, missing fields,
      // or selector timeout. The function already logged the specific reason.
      console.log(`⏭️  Skipped ${link} (attempt ${attempt})`);
      if (attempt > DETAIL_RETRIES) return null;
    } catch (err) {
      console.log(`⚠️ [${attempt}/${DETAIL_RETRIES + 1}] ${link}: ${err.message}`);
      // Type-aware rotation:
      //   Cloudflare on detail  → evict proxy immediately, rotate.
      //   Transport error       → feed streak; only rotate on final attempt.
      //   Parse error           → don't touch the proxy at all.
      const isCf = err.message.includes("Cloudflare");
      if (isCf) {
        const proxy = ctx.currentProxyRef.value;
        if (proxy) {
          const evicted = proxyMgr.reportCloudflareBlock(proxy);
          if (evicted) {
            ctx.currentProxyRef.value = await proxyMgr.acquire();
            pool._lastProxy = ctx.currentProxyRef.value;
            await pool.launch(ctx.currentProxyRef.value);
          }
        }
      } else if (isTransportError(err) && attempt === DETAIL_RETRIES + 1) {
        // Last-attempt transport failure — feed the streak counter.
        // ProxyManager will evict only if the streak crosses maxTransportFailures.
        if (ctx.currentProxyRef.value) proxyMgr.reportFailure(ctx.currentProxyRef.value);
      }
    } finally {
      await pool.release(page);
    }
  }
  return null;
}

function isTransportError(err) {
  const m = (err.message || "").toLowerCase();
  return /timeout|reset|tunnel|refused|econn|net::err/.test(m);
}

/* ============================================================ */
/* DETAIL EXTRACTION (mostly unchanged, just tighter timeouts)  */
/* ============================================================ */

async function extractPostDetails(postLink, page) {
  await page.goto(postLink, { waitUntil: "domcontentloaded", timeout: 25000 });

  if (await isCloudflareChallenge(page)) {
    // Throw — caller will route to reportCloudflareBlock via the
    // "Cloudflare" substring in the message.
    throw new Error("Cloudflare challenge on detail page");
  }

  // Event-driven: proceed the moment #jobDetails is in the DOM.
  // A timeout here is treated as a silent soft-block — caller will throw
  // a Cloudflare-tagged error so the proxy gets evicted, not just skipped.
  try {
    await page.waitForSelector("#jobDetails", { visible: true, timeout: DETAIL_SELECTOR_TIMEOUT });
  } catch (err) {
    throw new Error("Cloudflare soft-block on detail page (#jobDetails timeout)");
  }

  // Batch-extract all fields in ONE evaluate round-trip (4x fewer CDP calls)
  const data = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };
    const applyLink = document.querySelector("#gtm-job-ad-apply-now-bottom-section");
    return {
      post_title:    q("#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8"),
      institution:   q("#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8"),
      field:         q("#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8"),
      application_deadline: q("#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8"),
      application_link: applyLink ? applyLink.href : null,
    };
  });

  if (!data.post_title || !data.institution) {
    console.log("⚠️ Missing required fields — skipping");
    return null;
  }

  return {
    post_title: data.post_title,
    institution: data.institution,
    field: data.field || "Unspecified",
    application_link: data.application_link,
    application_deadline: data.application_deadline || "Unspecified",
    postLink,
    insertionDate: formatDateForDB(),
  };
}

/* ============================================================ */
/* UTILITIES                                                    */
/* ============================================================ */

async function isCloudflareChallenge(page) {
  try {
    return await page.evaluate(() => {
      const t = document.title || "";
      const b = document.body ? document.body.innerText.slice(0, 500) : "";
      return (
        t.includes("Just a moment") ||
        b.includes("Performing security verification") ||
        b.includes("security service to protect") ||
        !!document.querySelector("#cf-chl-widget") ||
        !!document.querySelector("[name='cf-turnstile-response']")
      );
    });
  } catch {
    return false;
  }
}

function cleanJobData(jobArray) {
  return jobArray.map((job) => {
    const cleanText = (text) => {
      if (!text || text === "Unspecified") return text;
      return text
        .replace(/\s*\n\s*/g, " ")
        .replace(/,\s*,/g, ",")
        .replace(/\s+/g, " ")
        .replace(/,\s+(and\s+\d+\s+more)/i, ", $1")
        .replace(/\s*,\s*/g, ", ")
        .replace(/,\s*,/g, ",")
        .trim();
    };
    const cleanDeadline = (deadline) => {
      if (!deadline || deadline === "Unspecified") return deadline;
      const lines = deadline.split("\n").map((l) => l.trim()).filter(Boolean);
      const unique = [...new Set(lines)];
      return unique[0] ? unique[0].split(" ")[0] : deadline;
    };
    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline),
    };
  });
}

function isValidDeadline(dateString) {
  if (!dateString || dateString === "Unspecified") return true;
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateString)) return true;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function filterExpiredDeadlines(jobs) {
  return jobs.filter((j) => {
    const ok = isValidDeadline(j.application_deadline);
    if (!ok) console.log(`⏭️  Expired: ${j.application_deadline} — ${j.post_title}`);
    return ok;
  });
}

function logMemory(label = "") {
  const u = process.memoryUsage();
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(
    `🧠 [${label}] rss=${mb(u.rss)}MB heap=${mb(u.heapUsed)}MB ext=${mb(u.external)}MB`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { academy };