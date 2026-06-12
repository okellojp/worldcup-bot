// ============================================================
//  World Cup Twitter Bot — Breaking News Edition
//  Every tweet is anchored to REAL news happening today
//  AI: Groq (free tier) — llama-3.3-70b-versatile
//  Scheduler: GitHub Actions (free)
//  Posting: X/Twitter API (pay-per-use)
//
//  GitHub Secrets required:
//    GROQ_API_KEY
//    TWITTER_API_KEY
//    TWITTER_API_SECRET
//    TWITTER_ACCESS_TOKEN
//    TWITTER_ACCESS_SECRET
// ============================================================

const https   = require("https");
const http    = require("http");
const crypto  = require("crypto");
const fs      = require("fs");
const { URL } = require("url");

// ─── RSS Feeds — multiple sources for max coverage ─────────

const RSS_FEEDS = [
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml",      source: "BBC Sport"    },
  { url: "https://www.espn.com/espn/rss/soccer/news",            source: "ESPN Soccer"  },
  { url: "https://www.goal.com/feeds/en/news",                   source: "Goal.com"     },
  { url: "https://www.skysports.com/rss/12040",                  source: "Sky Sports"   },
  { url: "https://talksport.com/feed/",                          source: "TalkSPORT"    },
];

// Big accounts to quote tweet — used with hardcoded tweet URL format
const QUOTE_ACCOUNTS = [
  "433",
  "TrollFootball",
  "markgoldbridge",
  "brfootball",
  "OptaJoe",
  "FabrizioRomano",
  "UTDTrey",
  "WelBeast",
  "CFC_Janty",
  "ThaEuropeanLad",
  "ESPN_FC",
  "BBCSport",
];

// Weighted pool — 50% breaking news, 30% news banter, 20% quote tweet
const TWEET_TYPES = [
  "breaking", "breaking", "breaking", "breaking", "breaking",
  "newsbanter", "newsbanter", "newsbanter",
  "quote", "quote",
];

// ─── HTTP helpers ──────────────────────────────────────────

function httpGet(url, timeoutMs = 10000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        res.resume();
        return httpGet(next, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = typeof body === "string" ? body : JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  { "Content-Length": Buffer.byteLength(data), ...headers },
    };
    const req = https.request(options, (res) => {
      let resp = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (resp += c));
      res.on("end", () => resolve({ status: res.statusCode, body: resp }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── RSS Parser ────────────────────────────────────────────

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const desc  = extractTag(block, "description");
    const link  = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    if (title) items.push({
      title:       cleanText(title),
      description: cleanText(desc || ""),
      link:        link || "",
      pubDate:     pubDate ? new Date(pubDate) : new Date(),
    });
  }
  return items;
}

function extractTag(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function cleanText(str) {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// ─── Fetch & rank latest headlines ────────────────────────

async function getLatestHeadlines() {
  const allItems = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`📡 Fetching: ${feed.source}`);
      const { body } = await httpGet(feed.url);
      const items = parseRSS(body)
        .slice(0, 8)
        .map(item => ({ ...item, source: feed.source }));
      console.log(`   ✓ ${items.length} headlines`);
      allItems.push(...items);
    } catch (e) {
      console.warn(`   ⚠️  ${feed.source} failed: ${e.message}`);
    }
  }

  if (allItems.length === 0) return [];

  // Sort by most recent first
  allItems.sort((a, b) => b.pubDate - a.pubDate);

  // Deduplicate by similar titles
  const seen  = new Set();
  const fresh = [];
  for (const item of allItems) {
    const key = item.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); fresh.push(item); }
  }

  console.log(`📰 Total unique headlines: ${fresh.length}`);
  return fresh.slice(0, 15);
}

// ─── Deduplication — avoid repeating same news ─────────────

const SEEN_FILE = "/tmp/seen_headlines.json";

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch { return []; }
}

function saveSeen(arr) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr.slice(-80)));
}

function pickFreshHeadline(headlines) {
  const seen  = loadSeen();
  const fresh = headlines.filter(h => !seen.includes(h.title));

  if (fresh.length === 0) {
    console.warn("⚠️  All headlines already used — picking most recent anyway");
    return headlines[0];
  }

  // Pick from top 5 freshest
  const pool = fresh.slice(0, 5);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  seen.push(pick.title);
  saveSeen(seen);
  return pick;
}

// ─── Groq AI prompts ───────────────────────────────────────

const PROMPTS = {

  // 50% — Sharp breaking news reaction
  breaking: (headline, source) => `You are a sharp, opinionated football Twitter account that reacts to breaking news in real time.
BREAKING NEWS from ${source}: "${headline}"

Write ONE punchy tweet reacting to this news RIGHT NOW.
Rules:
- Start with energy — this is BREAKING, make it feel urgent and exciting
- Add a strong opinion, prediction, or hot take about this news
- Sound like a passionate football fan who just read this headline
- Max 2 relevant hashtags e.g. #WorldCup #FIFA #PremierLeague
- Always include 1-2 fitting emojis (🚨 ⚽ 🔥 👀 💥 😤 🤯)
- Under 230 characters
- NO generic reactions — be SPECIFIC to this exact headline
- No quotation marks around the tweet
Output the tweet text only. Nothing else.`,

  // 30% — Funny news-based banter anchored to real headline
  newsbanter: (headline, source) => `You are a savage football banter account that makes people laugh about real football news.
TODAY'S NEWS from ${source}: "${headline}"

Write ONE funny banter tweet inspired by this specific news story.
Rules:
- Be funny, savage, or sarcastically react to this specific news
- Mock outrage, exaggeration, or roasting based on WHAT ACTUALLY HAPPENED
- Feel like a real fan venting or celebrating about this specific story
- Caps on 1-2 words for emphasis
- Always include 1-2 emojis (😂 💀 😭 🔥 ⚽ 🤣 👀)
- Under 230 characters
- Must reference something SPECIFIC from the headline — no generic football banter
- No hashtags needed
Output the tweet text only. Nothing else.`,

  // 20% — Quote tweet a big account with news-based banter
  quotebanter: (headline, username) => `You are a football banter account reacting to what @${username} just posted about this news: "${headline}"

Write a quote tweet adding your own savage, funny, or hyped reaction ON TOP of their take.
Rules:
- React as if you just saw their tweet and have something to add
- Can agree with extra hype, disagree with a roast, or add a funnier angle
- Reference the actual news story — be SPECIFIC not generic
- Always include 1-2 emojis (😂 🔥 💀 👀 ⚽ 😭 🤣)
- Under 200 characters (quote tweet link takes up space)
- No hashtags
Output the quote tweet text only. Nothing else.`,

};

// ─── Groq API call ─────────────────────────────────────────

async function generateTweet(promptText) {
  console.log(`🤖 Calling Groq (llama-3.3-70b-versatile)...`);

  const res = await httpsPost(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model:       "llama-3.3-70b-versatile",
      max_tokens:  160,
      temperature: 0.85,
      messages:    [{ role: "user", content: promptText }],
    },
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    }
  );

  if (res.status !== 200) throw new Error(`Groq API error ${res.status}: ${res.body}`);

  const data = JSON.parse(res.body);
  if (!data.choices?.[0]?.message?.content) {
    throw new Error(`Unexpected Groq response: ${JSON.stringify(data)}`);
  }

  return data.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
}

// ─── Twitter OAuth 1.0a ────────────────────────────────────

function oauthSign(method, url, params, consumerSecret, tokenSecret) {
  const encode      = (s) => encodeURIComponent(String(s));
  const paramString = Object.keys(params).sort()
    .map(k => `${encode(k)}=${encode(params[k])}`).join("&");
  const baseString  = [method.toUpperCase(), encode(url), encode(paramString)].join("&");
  const signingKey  = `${encode(consumerSecret)}&${encode(tokenSecret)}`;
  return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function buildAuthHeader(method, url, queryParams = {}) {
  const o = {
    oauth_consumer_key:     process.env.TWITTER_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            process.env.TWITTER_ACCESS_TOKEN,
    oauth_version:          "1.0",
  };
  const sigParams = method === "GET" ? { ...o, ...queryParams } : { ...o };
  o.oauth_signature = oauthSign(method, url, sigParams,
    process.env.TWITTER_API_SECRET, process.env.TWITTER_ACCESS_SECRET);
  return "OAuth " + Object.keys(o).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(o[k])}"`)
    .join(", ");
}

// ─── Fetch latest tweet ID from a big account ─────────────

async function getLatestTweetId(username) {
  console.log(`🔍 Fetching latest tweet from @${username}...`);

  // Get user ID
  const userUrl = `https://api.twitter.com/2/users/by/username/${username}`;
  const userRes = await new Promise((resolve, reject) => {
    const parsed  = new URL(userUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   "GET",
      headers:  { Authorization: buildAuthHeader("GET", userUrl) },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  if (userRes.status !== 200) throw new Error(`User lookup failed: ${userRes.status} ${userRes.body}`);
  const userId = JSON.parse(userRes.body).data?.id;
  if (!userId) throw new Error(`No user ID for @${username}`);

  // Get their latest tweet
  const tlUrl  = `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&exclude=retweets,replies`;
  const tlRes  = await new Promise((resolve, reject) => {
    const parsed  = new URL(tlUrl);
    const qParams = Object.fromEntries(parsed.searchParams);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  { Authorization: buildAuthHeader("GET", `${parsed.protocol}//${parsed.host}${parsed.pathname}`, qParams) },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  if (tlRes.status !== 200) throw new Error(`Timeline fetch failed: ${tlRes.status} ${tlRes.body}`);
  const tweets = JSON.parse(tlRes.body).data;
  if (!tweets || tweets.length === 0) throw new Error(`No tweets for @${username}`);

  console.log(`   ✓ Got tweet ID: ${tweets[0].id}`);
  return tweets[0].id;
}

// ─── Post tweet ────────────────────────────────────────────

async function postTweet(text, quoteTweetId = null) {
  const TWEET_URL = "https://api.twitter.com/2/tweets";
  const payload   = quoteTweetId ? { text, quote_tweet_id: quoteTweetId } : { text };

  console.log(quoteTweetId ? `🔁 Posting quote tweet...` : `🐦 Posting tweet...`);

  const res = await httpsPost(
    TWEET_URL,
    JSON.stringify(payload),
    { Authorization: buildAuthHeader("POST", TWEET_URL), "Content-Type": "application/json" }
  );

  console.log(`   Twitter response: ${res.status}`);

  if (res.status === 201) {
    const data = JSON.parse(res.body);
    console.log(`✅ Posted! ID: ${data.data.id}`);
    console.log(`   "${text}"`);
    return data;
  } else {
    throw new Error(`Twitter API error ${res.status}: ${res.body}`);
  }
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log("⚽ World Cup Bot — Breaking News Edition starting...");

  // Validate secrets
  const required = ["GROQ_API_KEY","TWITTER_API_KEY","TWITTER_API_SECRET","TWITTER_ACCESS_TOKEN","TWITTER_ACCESS_SECRET"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing secret: ${key}`);
  }
  console.log("✅ All secrets present");

  // Always fetch real news first — everything is anchored to it
  const headlines = await getLatestHeadlines();
  if (headlines.length === 0) throw new Error("No headlines fetched — all RSS feeds failed");

  const headline = pickFreshHeadline(headlines);
  console.log(`📰 Today's anchor: "${headline.title}" — ${headline.source}`);

  // Pick tweet type
  const type = TWEET_TYPES[Math.floor(Math.random() * TWEET_TYPES.length)];
  console.log(`📝 Tweet type: ${type}`);

  // ── Quote tweet flow ──
  if (type === "quote") {
    const username = QUOTE_ACCOUNTS[Math.floor(Math.random() * QUOTE_ACCOUNTS.length)];
    console.log(`🎯 Quote target: @${username}`);

    try {
      const tweetId   = await getLatestTweetId(username);
      const prompt    = PROMPTS.quotebanter(headline.title, username);
      const tweetText = await generateTweet(prompt);

      console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);
      if (tweetText.length > 280) throw new Error(`Too long: ${tweetText.length} chars`);

      await postTweet(tweetText, tweetId);

    } catch (e) {
      // Fallback to breaking news if quote tweet fails
      console.warn(`⚠️  Quote tweet failed (${e.message}) — falling back to breaking news`);
      const prompt    = PROMPTS.breaking(headline.title, headline.source);
      const tweetText = await generateTweet(prompt);
      console.log(`✍️  Fallback (${tweetText.length} chars): ${tweetText}`);
      await postTweet(tweetText);
    }
    return;
  }

  // ── Original tweet flow (breaking or newsbanter) ──
  const prompt    = type === "breaking"
    ? PROMPTS.breaking(headline.title, headline.source)
    : PROMPTS.newsbanter(headline.title, headline.source);

  const tweetText = await generateTweet(prompt);
  console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);

  if (tweetText.length > 280) throw new Error(`Tweet too long: ${tweetText.length} chars`);

  await postTweet(tweetText);
}

main().catch((err) => {
  console.error("❌ Bot failed:", err.message);
  process.exit(1);
});
