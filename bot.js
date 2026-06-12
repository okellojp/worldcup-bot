// ============================================================
//  World Cup Twitter Bot — Professional News Edition
//  Tweets real news WITH details, serious tone, no banter
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

// ─── RSS Feeds ─────────────────────────────────────────────

const RSS_FEEDS = [
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml",   source: "BBC Sport"   },
  { url: "https://www.espn.com/espn/rss/soccer/news",         source: "ESPN Soccer" },
  { url: "https://www.goal.com/feeds/en/news",                source: "Goal.com"    },
  { url: "https://www.skysports.com/rss/12040",               source: "Sky Sports"  },
  { url: "https://talksport.com/feed/",                       source: "TalkSPORT"   },
];

// Big accounts to quote tweet
const QUOTE_ACCOUNTS = [
  "433", "OptaJoe", "FabrizioRomano",
  "brfootball", "BBCSport", "ESPN_FC",
  "SkySportsNews", "goal", "TalkSPORT",
];

// Weighted pool — 50% news report, 30% analysis, 20% quote tweet
const TWEET_TYPES = [
  "news",     "news",     "news",     "news",     "news",
  "analysis", "analysis", "analysis",
  "quote",    "quote",
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
      res.on("data", chunk => (data += chunk));
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
    const opts   = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  { "Content-Length": Buffer.byteLength(data), ...headers },
    };
    const req = https.request(opts, (res) => {
      let resp = "";
      res.setEncoding("utf8");
      res.on("data", c => (resp += c));
      res.on("end", () => resolve({ status: res.statusCode, body: resp }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── RSS Parser — extracts title AND description ───────────

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block   = match[1];
    const title   = extractTag(block, "title");
    const desc    = extractTag(block, "description");
    const link    = extractTag(block, "link");
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
  const m = str.match(new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"
  ));
  return m ? m[1].trim() : null;
}

function cleanText(str) {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// ─── Fetch headlines with full descriptions ────────────────

async function getLatestHeadlines() {
  const allItems = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`📡 Fetching: ${feed.source}`);
      const { body } = await httpGet(feed.url);
      const items = parseRSS(body)
        .slice(0, 8)
        .map(item => ({ ...item, source: feed.source }));
      console.log(`   ✓ ${items.length} stories`);
      allItems.push(...items);
    } catch (e) {
      console.warn(`   ⚠️  ${feed.source} failed: ${e.message}`);
    }
  }

  if (allItems.length === 0) return [];

  // Sort newest first
  allItems.sort((a, b) => b.pubDate - a.pubDate);

  // Deduplicate
  const seen  = new Set();
  const fresh = [];
  for (const item of allItems) {
    const key = item.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); fresh.push(item); }
  }

  console.log(`📰 ${fresh.length} unique stories available`);
  return fresh.slice(0, 15);
}

// ─── Deduplication ─────────────────────────────────────────

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
    console.warn("⚠️  All headlines seen — using most recent");
    return headlines[0];
  }

  const pool = fresh.slice(0, 5);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  seen.push(pick.title);
  saveSeen(seen);
  return pick;
}

// ─── Prompts ───────────────────────────────────────────────

const PROMPTS = {

  // 50% — Straight news report with detail
  news: (title, description, source) =>
    `You are a professional football news Twitter account covering the World Cup and global football.

News from ${source}:
HEADLINE: "${title}"
DETAILS: "${description}"

Write ONE informative tweet that reports this news story with key details included.

Rules:
- Include the most important facts from both the headline AND the details
- Write in a clear, professional, journalistic tone — no jokes, no banter, no sarcasm
- Structure: state what happened, add 1 key detail or context that matters
- Use 1 relevant football emoji only if it adds clarity (⚽ 🏆 📋) — no party emojis, no laugh emojis
- Add 1-2 relevant hashtags e.g. #WorldCup #PremierLeague #UEFA
- Under 270 characters
- Do NOT just repeat the headline — expand on it with the detail provided
- No quotation marks around the tweet

Output the tweet text only. Nothing else.`,

  // 30% — Analytical take with context
  analysis: (title, description, source) =>
    `You are an experienced football analyst and journalist on Twitter.

News from ${source}:
HEADLINE: "${title}"
DETAILS: "${description}"

Write ONE analytical tweet that puts this news in context and explains why it matters.

Rules:
- Go beyond the headline — explain the significance or implication of this story
- Reference specific facts from the details provided
- Write like a knowledgeable football journalist giving informed commentary
- Serious, credible tone — no memes, no banter, no jokes
- Can include a stat, historical context, or tactical implication if relevant
- Use 1 relevant hashtag max
- No emojis unless absolutely necessary (e.g. ⚽ for football context only)
- Under 270 characters

Output the tweet text only. Nothing else.`,

  // 20% — Serious quote tweet reacting to a big account's news
  quotereact: (title, description, username) =>
    `You are a professional football journalist on Twitter.

@${username} just posted about this story:
HEADLINE: "${title}"
DETAILS: "${description}"

Write a quote tweet that adds journalistic value — extra context, a key stat, an important detail they may have missed, or a well-informed perspective.

Rules:
- Serious, professional tone — no jokes, no banter
- Add something of VALUE beyond what was already said
- Reference specific facts from the details
- Under 200 characters (quoted tweet takes up space)
- 1 hashtag max, no unnecessary emojis

Output the quote tweet text only. Nothing else.`,

};

// ─── Groq API ──────────────────────────────────────────────

async function generateTweet(promptText) {
  console.log(`🤖 Calling Groq (llama-3.3-70b-versatile)...`);

  const res = await httpsPost(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model:       "llama-3.3-70b-versatile",
      max_tokens:  180,
      temperature: 0.6,   // lower = more focused, professional
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
  const encode      = s => encodeURIComponent(String(s));
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

// ─── Fetch latest tweet ID from account ───────────────────

async function getLatestTweetId(username) {
  console.log(`🔍 Fetching latest tweet from @${username}...`);

  const userUrl = `https://api.twitter.com/2/users/by/username/${username}`;
  const userRes = await new Promise((resolve, reject) => {
    const parsed = new URL(userUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   "GET",
      headers:  { Authorization: buildAuthHeader("GET", userUrl) },
    }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  if (userRes.status !== 200) throw new Error(`User lookup failed: ${userRes.status}`);
  const userId = JSON.parse(userRes.body).data?.id;
  if (!userId) throw new Error(`No user ID for @${username}`);

  const tlUrl = `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&exclude=retweets,replies`;
  const tlRes = await new Promise((resolve, reject) => {
    const parsed  = new URL(tlUrl);
    const qParams = Object.fromEntries(parsed.searchParams);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  { Authorization: buildAuthHeader("GET",
        `${parsed.protocol}//${parsed.host}${parsed.pathname}`, qParams) },
    }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  if (tlRes.status !== 200) throw new Error(`Timeline failed: ${tlRes.status}`);
  const tweets = JSON.parse(tlRes.body).data;
  if (!tweets?.length) throw new Error(`No tweets for @${username}`);

  console.log(`   ✓ Tweet ID: ${tweets[0].id}`);
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
    {
      Authorization:  buildAuthHeader("POST", TWEET_URL),
      "Content-Type": "application/json",
    }
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
  console.log("⚽ World Cup Bot — Professional News Edition starting...");

  const required = [
    "GROQ_API_KEY","TWITTER_API_KEY","TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN","TWITTER_ACCESS_SECRET",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing secret: ${key}`);
  }
  console.log("✅ All secrets present");

  // Fetch real news — always the anchor
  const headlines = await getLatestHeadlines();
  if (headlines.length === 0) throw new Error("All RSS feeds failed — no headlines available");

  const story = pickFreshHeadline(headlines);
  console.log(`📰 Story: "${story.title}"`);
  console.log(`📝 Details: "${story.description.slice(0, 100)}..."`);

  // Pick tweet type
  const type = TWEET_TYPES[Math.floor(Math.random() * TWEET_TYPES.length)];
  console.log(`📝 Tweet type: ${type}`);

  // ── Quote tweet flow ──
  if (type === "quote") {
    const username = QUOTE_ACCOUNTS[Math.floor(Math.random() * QUOTE_ACCOUNTS.length)];
    console.log(`🎯 Quote target: @${username}`);

    try {
      const tweetId   = await getLatestTweetId(username);
      const prompt    = PROMPTS.quotereact(story.title, story.description, username);
      const tweetText = await generateTweet(prompt);

      console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);
      if (tweetText.length > 280) throw new Error(`Too long: ${tweetText.length} chars`);

      await postTweet(tweetText, tweetId);

    } catch (e) {
      console.warn(`⚠️  Quote tweet failed (${e.message}) — falling back to news`);
      const prompt    = PROMPTS.news(story.title, story.description, story.source);
      const tweetText = await generateTweet(prompt);
      console.log(`✍️  Fallback (${tweetText.length} chars): ${tweetText}`);
      await postTweet(tweetText);
    }
    return;
  }

  // ── News or analysis flow ──
  const prompt = type === "news"
    ? PROMPTS.news(story.title, story.description, story.source)
    : PROMPTS.analysis(story.title, story.description, story.source);

  const tweetText = await generateTweet(prompt);
  console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);

  if (tweetText.length > 280) throw new Error(`Tweet too long: ${tweetText.length} chars`);

  await postTweet(tweetText);
}

main().catch(err => {
  console.error("❌ Bot failed:", err.message);
  process.exit(1);
});
