const puppeteer = require("puppeteer-core");
const readline = require("readline");

let browser = null;
let pages = {};
let pageCounter = 0;

// Find Chrome executable
function findChrome() {
  const fs = require("fs");
  const candidates = [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Try chrome-paths if available
  try {
    const cp = require("chrome-paths");
    if (cp.chrome) return cp.chrome;
  } catch {}
  return null;
}

// Read JSON commands from stdin, one per line
const rl = readline.createInterface({ input: process.stdin });

function respond(id, data) {
  const msg = JSON.stringify({ id, ...data });
  process.stdout.write(msg + "\n");
}

async function isBrowserAvailable() {
  try {
    if (!browser) return false;
    if (!browser.isConnected()) { browser = null; return false; }
    await browser.version();
    return true;
  } catch {
    browser = null;
    return false;
  }
}

async function handleLaunch(id, opts) {
  const {
    url, proxy, headless = false, userAgent, username, password,
    cookies, puppeterConfig
  } = opts;

  const browserAvailable = await isBrowserAvailable();

  if (!browserAvailable) {
    const chromeArgs = puppeterConfig ? JSON.parse(puppeterConfig) : [];

    const turkeyFingerprintArgs = [
      "--timezone-id=Europe/Istanbul",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy",
      "--window-size=1280,900",
      "--window-position=100,50",
    ];
    const mergedArgs = [...chromeArgs, ...turkeyFingerprintArgs];

    const execPath = findChrome();
    if (!execPath) {
      respond(id, { ok: false, error: "Chrome not found" });
      return;
    }

    const chromeOptions = {
      headless,
      ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
      ignoreHTTPSErrors: true,
      args: [...mergedArgs, "--disable-blink-features=AutomationControlled"],
      executablePath: execPath,
      env: { ...process.env, TZ: "Europe/Istanbul" },
    };

    browser = await puppeteer.launch(chromeOptions);
    browser.on("disconnected", () => {
      browser = null;
      pages = {};
    });
    process.stderr.write("[puppeteer] Browser launched\n");
  }

  const page = await browser.newPage();
  const pageId = ++pageCounter;

  try {
    await page.emulateTimezone("Europe/Istanbul");
  } catch {
    const cdp = await page.target().createCDPSession();
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Istanbul" });
  }

  // Timezone spoof
  await page.evaluateOnNewDocument(() => {
    const TZ = "Europe/Istanbul";
    const OFFSET = -180;
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
    const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      const o = origResolvedOptions.call(this);
      o.timeZone = TZ;
      return o;
    };
  });

  // WebRTC spoof
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

  // Stealth: navigator patches
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["tr-TR", "tr", "en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  await page.setJavaScriptEnabled(true);
  await page.setDefaultNavigationTimeout(0);

  const client = await page.target().createCDPSession();
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Istanbul" });

  // User agent + Client Hints
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
  process.stderr.write(`[puppeteer] Page opened: ${url}\n`);

  pages[pageId] = page;
  respond(id, { ok: true, pageId });
}

async function handleLaunchCookies(id, opts) {
  const realUrl = opts.url;
  opts.url = "about:blank";
  const cookies = opts.cookies;

  // Launch with about:blank
  await handleLaunch(id + "_inner", opts);

  // Find last page
  const lastPageId = pageCounter;
  const page = pages[lastPageId];
  if (!page) {
    respond(id, { ok: false, error: "No page found after launch" });
    return;
  }

  if (cookies) await page.setCookie(...JSON.parse(cookies));

  // Close the extra about:blank tab that browser opens by default
  try {
    const allPages = await browser.pages();
    for (const p of allPages) {
      if (p !== page && p.url() === "about:blank") {
        await p.close();
      }
    }
  } catch {}

  await page.goto(realUrl);
  process.stderr.write(`[puppeteer] Page navigated with cookies: ${realUrl}\n`);

  respond(id, { ok: true, pageId: lastPageId });
}

async function handleGetCookies(id, { pageId }) {
  const page = pages[pageId || pageCounter];
  if (!page) {
    respond(id, { ok: true, cookies: null });
    return;
  }

  let cookies = await page.cookies();
  const futureSec = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  cookies = cookies.map(c => {
    if (c.expires === -1 || c.expires < futureSec) c.expires = futureSec;
    return c;
  });
  await page.setCookie(...cookies);

  try {
    if (!page.isClosed()) await page.close();
  } catch {}
  delete pages[pageId || pageCounter];

  respond(id, { ok: true, cookies: JSON.stringify(cookies) });
}

async function handleClose(id) {
  pages = {};
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
  respond(id, { ok: true });
}

rl.on("line", async (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

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
        await handleClose(id);
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
