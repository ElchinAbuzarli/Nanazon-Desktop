// =============================================================================
// Puppeteer Service for Tauri (exact mirror of nanazon-app/puppeteerService.js)
// Communication: JSON over stdin/stdout instead of direct function calls
// =============================================================================

let puppeteer;
let stealthLoaded = false;
try {
  puppeteer = require("puppeteer-extra");
  const stealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteer.use(stealthPlugin());
  stealthLoaded = true;
  process.stderr.write("[puppeteer] ✅ Stealth plugin loaded\n");
} catch (err) {
  process.stderr.write(`[puppeteer] ⚠️ Stealth plugin failed, falling back to puppeteer: ${err.message}\n`);
  try {
    puppeteer = require("puppeteer");
  } catch {
    puppeteer = require("puppeteer-core");
  }
}
const chromePaths = require("chrome-paths");
const { exec } = require("child_process");
const readline = require("readline");

// --- Shared state (mirrors nanazon-app/sharedState.js) ---
let userId = null;
let token = null;
let packages = new Map();

function normalizeDomain(input) {
  try {
    const url = input.includes("://") ? new URL(input) : new URL("https://" + input);
    let hostname = url.hostname.replace(/^www\./, "").trim().toLowerCase();
    const parts = hostname.split(".");
    if (parts.length >= 2) hostname = parts.slice(-2).join(".");
    return hostname;
  } catch {
    const parts = input.replace(/^www\./, "").trim().toLowerCase().split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : parts.join(".");
  }
}

function setPackages(packageList = []) {
  packages.clear();
  packageList.forEach((group) => {
    const pkgArray = Array.isArray(group.packages) ? group.packages : [group];
    pkgArray.forEach((pkg) => {
      if (!pkg || !pkg.url) return;
      const domain = normalizeDomain(pkg.url);
      if (!domain) return;
      const existing = packages.get(domain) || { domain, items: [] };
      existing.items.push({
        id: pkg.id,
        limit: Number(pkg.limit) || 0,
        totalDownloaded: Number(pkg.totallimitdown) || 0,
      });
      packages.set(domain, existing);
    });
  });
}

function getPackages() { return Array.from(packages.values()); }

function incrementDownload(domain, packageId) {
  domain = normalizeDomain(domain);
  const entry = packages.get(domain);
  if (!entry) return 0;
  if (packageId) {
    const pkg = entry.items.find((p) => p.id === packageId);
    if (pkg) { pkg.totalDownloaded += 1; return pkg.totalDownloaded; }
  } else {
    if (entry.items.length > 0) { entry.items[0].totalDownloaded += 1; return entry.items[0].totalDownloaded; }
  }
  return 0;
}

function getDownloadCount(domain) {
  domain = normalizeDomain(domain);
  const entry = packages.get(domain);
  if (!entry || !Array.isArray(entry.items)) return 0;
  return entry.items.reduce((sum, item) => sum + (Number(item.totalDownloaded) || 0), 0);
}

function getDownloadLimit(domain) {
  domain = normalizeDomain(domain);
  const entry = packages.get(domain);
  if (!entry || !Array.isArray(entry.items)) return 0;
  return entry.items.reduce((sum, item) => sum + (Number(item.limit) || 0), 0);
}

function hasExceededLimit(domain) {
  domain = normalizeDomain(domain);
  const entry = packages.get(domain);
  if (!entry) return false;
  return entry.items.some((pkg) => pkg.limit > 0 && pkg.totalDownloaded >= pkg.limit);
}

// --- Communication helpers ---
const rl = readline.createInterface({ input: process.stdin });

function respond(id, data) {
  process.stdout.write(JSON.stringify({ id, ...data }) + "\n");
}

function emitEvent(event, data) {
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n");
}

// --- Browser state ---
let browser = null;
let pages = {};
let pageCounter = 0;
let isLaunching = false;

async function isBrowserAvailable() {
  try {
    if (!browser) return false;
    if (!browser.isConnected()) { browser = null; return false; }
    await browser.version();
    return true;
  } catch (err) {
    process.stderr.write(`⚠️ Browser bağlantısı kopmuş: ${err.message}\n`);
    browser = null;
    return false;
  }
}

// --- Main launch (exact copy of nanazon-app/puppeteerService.js launchAndOpenPage) ---
async function handleLaunch(id, opts) {
  const {
    url, proxy, headless = false, userAgent, username, password,
    cookies, puppeterConfig
  } = opts;

  // Race condition prevention (same as nanazon-app)
  let waitCount = 0;
  while (isLaunching && waitCount < 20) {
    process.stderr.write("⏳ Browser açma işlemi devam ediyor, bekleniyor...\n");
    await new Promise(resolve => setTimeout(resolve, 500));
    waitCount++;
  }

  const browserAvailable = await isBrowserAvailable();

  if (!browserAvailable) {
    isLaunching = true;
    try {
      process.stderr.write("🌐 Yeni browser açılıyor...\n");
      const chromeArgs = puppeterConfig ? JSON.parse(puppeterConfig) : [];

      // Turkey fingerprint args (exact same as nanazon-app)
      const turkeyFingerprintArgs = [
        "--timezone-id=Europe/Istanbul",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--force-webrtc-ip-handling-policy",
      ];
      const mergedArgs = [...chromeArgs, ...turkeyFingerprintArgs];

      const chromeOptions = {
        headless,
        ignoreDefaultArgs: ["--disable-extensions"],
        ignoreHTTPSErrors: true,
        args: mergedArgs,
        executablePath: chromePaths.chrome,
        env: { ...process.env, TZ: "Europe/Istanbul" },
      };

      browser = await puppeteer.launch(chromeOptions);
      browser.on("disconnected", () => {
        process.stderr.write("🛑 Tarayıcı kapandı.\n");
        browser = null;
        isLaunching = false;
        pages = {};
      });
      process.stderr.write("✅ Browser başarıyla açıldı.\n");
    } catch (err) {
      process.stderr.write(`❌ Browser açma hatası: ${err.message}\n`);
      browser = null;
      respond(id, { ok: false, error: err.message });
      return;
    } finally {
      isLaunching = false;
    }
  } else {
    process.stderr.write("✅ Mövcud browser istifadə olunur, yalnız yeni tab açılır...\n");
  }

  process.stderr.write("📄 Yeni sekme açılıyor...\n");
  let page;
  try {
    page = await browser.newPage();
    const pageId = ++pageCounter;

    // Close default about:blank tab
    try {
      const allPages = await browser.pages();
      for (const p of allPages) {
        if (p !== page && p.url() === "about:blank") {
          await p.close();
        }
      }
    } catch {}

    try {
      await page.emulateTimezone("Europe/Istanbul");
    } catch (e) {
      const cdp = await page.target().createCDPSession();
      await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Istanbul" });
    }

    // Force Turkey timezone in all JS APIs (same as nanazon-app)
    await page.evaluateOnNewDocument(() => {
      const TZ = "Europe/Istanbul";
      const OFFSET = -180;

      const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
      Date.prototype.getTimezoneOffset = function () { return OFFSET; };

      const origToString = Date.prototype.toString;
      Date.prototype.toString = function () {
        return origToString.call(this)
          .replace(/GMT[+-]\d{4}/, "GMT+0300")
          .replace(/\(.*\)/, "(Turkey Standard Time)");
      };

      const origToTimeString = Date.prototype.toTimeString;
      Date.prototype.toTimeString = function () {
        return origToTimeString.call(this)
          .replace(/GMT[+-]\d{4}/, "GMT+0300")
          .replace(/\(.*\)/, "(Turkey Standard Time)");
      };

      const origDateString = Date.prototype.toDateString;

      const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        const o = origResolvedOptions.call(this);
        o.timeZone = TZ;
        return o;
      };
    });

    // WebRTC: hide only host candidates (same as nanazon-app)
    await page.evaluateOnNewDocument(() => {
      const Native = window.RTCPeerConnection;
      if (!Native) return;
      window.RTCPeerConnection = function (...args) {
        const pc = new Native(...args);
        const origOnIce = pc.onicecandidate;
        pc.onicecandidate = (e) => {
          if (e.candidate && e.candidate.candidate) {
            const typ = (e.candidate.type || "").toLowerCase();
            if (typ === "host") return;
          }
          if (origOnIce) origOnIce.call(pc, e);
        };
        return pc;
      };
      window.RTCPeerConnection.prototype = Native.prototype;
    });

    await page.setJavaScriptEnabled(true);
    await page.setDefaultNavigationTimeout(0);

    const client = await page.target().createCDPSession();
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Istanbul" });

    // --- Download tracking (same as nanazon-app) ---
    let globalLimitExceeded = false;

    client.on("Page.downloadWillBegin", async (event) => {
      const domain = normalizeDomain(event.url);
      const pkgEntry = getPackages().find(p => p.domain === domain);
      if (!pkgEntry) return;

      const item = pkgEntry.items.find(i => i.totalDownloaded < i.limit);
      if (!item) {
        process.stderr.write(`⚠️ ${domain} için indirme limiti aşıldı: ${event.url}\n`);
        emitEvent("downloadLimitExceeded", { domain });
        return;
      }

      const updatedCount = incrementDownload(domain, item.id);
      process.stderr.write(`📈 [Puppeteer] ${domain} indirme sayısı: ${updatedCount}/${item.limit}\n`);

      // Send download count update to Tauri frontend (mirrors socketHelper.emitSecure)
      emitEvent("downloadCount", {
        userId,
        token,
        domain,
        package: item,
        currentDownloadCount: updatedCount,
        downloadLimit: item.limit,
      });

      if (hasExceededLimit(domain)) {
        process.stderr.write(`🛑 ${domain} için limit doldu!\n`);
        emitEvent("downloadLimitExceeded", { domain });
      }
    });

    // User agent + Client Hints (same as nanazon-app)
    if (userAgent) {
      const macMatch = userAgent.match(/Mac OS X (\d+[._]\d+[._]?\d*)/);
      const winMatch = userAgent.match(/Windows NT ([\d.]+)/);
      const chromeMatch = userAgent.match(/Chrome\/([\d.]+)/);
      const brandVersion = chromeMatch ? chromeMatch[1].split(".")[0] : "145";
      const fullVersion = chromeMatch ? chromeMatch[1] : "145.0.0.0";

      let platform = "macOS";
      let platformVersion = "10.15.7";
      if (macMatch) {
        platformVersion = macMatch[1].replace(/_/g, ".");
      } else if (winMatch) {
        platform = "Windows";
        platformVersion = winMatch[1];
      }

      await client.send("Network.setUserAgentOverride", {
        userAgent,
        platform: platform === "macOS" ? "MacIntel" : "Win32",
        userAgentMetadata: {
          brands: [
            { brand: "Google Chrome", version: brandVersion },
            { brand: "Chromium", version: brandVersion },
            { brand: "Not-A.Brand", version: "99" },
          ],
          fullVersionList: [
            { brand: "Google Chrome", version: fullVersion },
            { brand: "Chromium", version: fullVersion },
            { brand: "Not-A.Brand", version: "99.0.0.0" },
          ],
          platform,
          platformVersion,
          architecture: platform === "macOS" ? "arm" : "x86",
          model: "",
          mobile: false,
          bitness: "64",
          wow64: false,
        },
      });
    }

    if (username && password) await page.authenticate({ username, password });
    if (cookies) await page.setCookie(...JSON.parse(cookies));

    await page.goto(url);
    process.stderr.write("✅ Yeni tab başarıyla açıldı ve sayfa yüklendi.\n");
    pages[pageId] = page;
    respond(id, { ok: true, pageId });
  } catch (err) {
    process.stderr.write(`❌ Tab açma hatası: ${err.message}\n`);
    // Retry on connection lost (same as nanazon-app)
    if (err.message.includes("Target closed") || err.message.includes("Session closed")) {
      process.stderr.write("🔄 Browser bağlantısı kopmuş, yeniden açılıyor...\n");
      browser = null;
      return await handleLaunch(id, opts);
    }
    respond(id, { ok: false, error: err.message });
  }
}

// --- Cookie launch (same as nanazon-app launchAndOpenPageCookies) ---
async function handleLaunchCookies(id, opts) {
  const realUrl = opts.url;
  opts.url = "about:blank";
  const cookies = opts.cookies;

  await handleLaunch(id + "_inner", opts);

  const lastPageId = pageCounter;
  const page = pages[lastPageId];
  if (!page) {
    respond(id, { ok: false, error: "No page found after launch" });
    return;
  }

  await page.goto("about:blank");
  if (cookies) await page.setCookie(...JSON.parse(cookies));
  await page.goto(realUrl);

  process.stderr.write(`[puppeteer] Page navigated with cookies: ${realUrl}\n`);
  respond(id, { ok: true, pageId: lastPageId });
}

// --- Get cookies (same as nanazon-app getCookies) ---
async function handleGetCookies(id, { pageId }) {
  const page = pages[pageId || pageCounter];
  if (!page) {
    respond(id, { ok: true, cookies: null, message: "❌ No page found!" });
    return;
  }

  let cookies = await page.cookies();
  const futureSec = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  cookies = cookies.map(c => {
    if (c.expires === -1 || c.expires < futureSec) c.expires = futureSec;
    return c;
  });
  await page.setCookie(...cookies);

  // Close page but keep browser open (same as nanazon-app)
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (err) {
    process.stderr.write(`⚠️ Page bağlanarkən xəta: ${err.message}\n`);
  }
  delete pages[pageId || pageCounter];

  respond(id, { ok: true, cookies: JSON.stringify(cookies), message: true });
}

// --- Close browser (same as nanazon-app closeBrowser) ---
async function handleClose(id, { force } = {}) {
  try {
    const browserAvailable = await isBrowserAvailable();
    if (browserAvailable) {
      process.stderr.write("🧹 Tarayıcı kapatılıyor...\n");
      await browser.close();
      process.stderr.write("✅ Tarayıcı kapatıldı.\n");
    } else if (force) {
      process.stderr.write("⚠️ Tarayıcı yok ama kapatma zorlandı (force).\n");
      try {
        if (process.platform === "win32") exec("taskkill /IM chrome.exe /F");
        else exec("pkill -f '(chrome|chromium|Google Chrome Helper)'");
      } catch {}
    } else {
      process.stderr.write("❌ Tarayıcı bulunamadı!\n");
    }
  } catch (err) {
    process.stderr.write(`⚠️ Tarayıcı kapatma hatası: ${err.message}\n`);
  } finally {
    browser = null;
    pages = {};
  }
  respond(id, { ok: true, message: "Browser closed (forced or normal)" });
}

// --- Command router ---
rl.on("line", async (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch { return; }

  const { id, action, ...params } = cmd;

  try {
    switch (action) {
      case "launch":
        await handleLaunch(id, params);
        break;
      case "launchCookies":
        await handleLaunchCookies(id, params);
        break;
      case "getCookies":
        await handleGetCookies(id, params);
        break;
      case "close":
        await handleClose(id, params);
        break;
      case "setPackages":
        setPackages(params.packages || []);
        process.stderr.write(`📦 Packages updated: ${packages.size} domains\n`);
        respond(id, { ok: true });
        break;
      case "setAuth":
        userId = params.userId || null;
        token = params.token || null;
        process.stderr.write(`🔑 Auth updated: userId=${userId}\n`);
        respond(id, { ok: true });
        break;
      default:
        respond(id, { ok: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    process.stderr.write(`[puppeteer] Error: ${err.message}\n`);
    respond(id, { ok: false, error: err.message });
  }
});

rl.on("close", async () => {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
});

process.stderr.write("[puppeteer] Service ready\n");
