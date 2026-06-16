// ============================================================
//  @oj_pulse — Crypto News Thread Bot
//  Posts full Twitter threads: hook → explain → implications
//  → how to capitalise → affiliate CTA
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

// ─── Affiliate Links ───────────────────────────────────────
const AFFILIATE = {
  binance: "https://www.binance.com/referral/earn-together/refer2earn-usdc/claim?hl=en&ref=GRO_28502_49PKK",
  bybit:   "https://www.bybit.com/invite?ref=9Z9QRPA",
};

// ─── RSS Feeds ─────────────────────────────────────────────
const RSS_FEEDS = [
  { url: "https://cointelegraph.com/rss",                source: "CoinTelegraph"   },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk"        },
  { url: "https://decrypt.co/feed",                     source: "Decrypt"         },
  { url: "https://bitcoinmagazine.com/.rss/full/",      source: "Bitcoin Magazine" },
  { url: "https://thedefiant.io/feed",                  source: "The Defiant"     },
];

// ─── Quote tweet accounts ──────────────────────────────────
const QUOTE_ACCOUNTS = [
  // Media
  "CoinDesk", "Cointelegraph", "DocumentingBTC",
  "BitcoinMagazine", "WatcherGuru", "DecryptMedia",
  "thedefiant", "binance", "bybit_official",
  // Whales
  "saylor", "VitalikButerin", "cz_binance",
  "APompliano", "RaoulGMI", "CathieDWood",
  "aantonop", "naval", "woonomic", "100trillionUSD",
];

// ─── Content categories ────────────────────────────────────
const CATEGORIES = {
  bitcoin:    ["Bitcoin", "BTC", "Lightning Network", "Bitcoin ETF", "Satoshi", "GBTC"],
  ethereum:   ["Ethereum", "ETH", "Vitalik", "EIP", "Ethereum upgrade"],
  altcoins:   ["Solana", "XRP", "BNB", "Cardano", "Avalanche", "Polygon", "altcoin"],
  defi:       ["DeFi", "DEX", "liquidity pool", "yield farming", "TVL", "protocol"],
  nfts:       ["NFT", "OpenSea", "digital art", "collection", "mint"],
  regulation: ["SEC", "regulation", "crypto law", "CBDC", "crypto ban", "crypto bill"],
  africa:     ["Africa", "Uganda", "Kenya", "Nigeria", "Ghana", "crypto adoption"],
};

// Weighted pool — 70% threads, 30% single quote tweets
const TWEET_TYPES = [
  "thread", "thread", "thread", "thread", "thread",
  "thread", "thread",
  "quote",  "quote",  "quote",
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

// ─── RSS Parser ────────────────────────────────────────────

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
      description: cleanText(desc || "").slice(0, 500),
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

function detectCategory(title) {
  const t = title.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => t.includes(k.toLowerCase()))) return cat;
  }
  return "bitcoin";
}

// ─── Fetch headlines ───────────────────────────────────────

async function getLatestHeadlines() {
  const allItems = [];
  for (const feed of RSS_FEEDS) {
    try {
      console.log(`📡 Fetching: ${feed.source}`);
      const { body } = await httpGet(feed.url);
      const items = parseRSS(body).slice(0, 8)
        .map(item => ({ ...item, source: feed.source, category: detectCategory(item.title) }));
      console.log(`   ✓ ${items.length} stories`);
      allItems.push(...items);
    } catch (e) {
      console.warn(`   ⚠️  ${feed.source} failed: ${e.message}`);
    }
  }
  if (allItems.length === 0) return [];
  allItems.sort((a, b) => b.pubDate - a.pubDate);
  const seen  = new Set();
  const fresh = [];
  for (const item of allItems) {
    const key = item.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); fresh.push(item); }
  }
  console.log(`📰 ${fresh.length} unique stories`);
  return fresh.slice(0, 20);
}

// ─── Deduplication ─────────────────────────────────────────

const SEEN_FILE  = "/tmp/seen_crypto.json";
const COUNT_FILE = "/tmp/tweet_count.json";

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch { return []; }
}
function saveSeen(arr) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr.slice(-100)));
}
function loadCount() {
  try { return JSON.parse(fs.readFileSync(COUNT_FILE, "utf8")).count || 0; }
  catch { return 0; }
}
function saveCount(n) {
  fs.writeFileSync(COUNT_FILE, JSON.stringify({ count: n }));
}
function pickFreshHeadline(headlines) {
  const seen  = loadSeen();
  const fresh = headlines.filter(h => !seen.includes(h.title));
  if (fresh.length === 0) return headlines[0];
  const pool = fresh.slice(0, 5);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  seen.push(pick.title);
  saveSeen(seen);
  return pick;
}

// ─── Thread prompt ─────────────────────────────────────────

function buildThreadPrompt(title, description, source) {
  return `You are @oj_pulse, a professional crypto news account with an African perspective. You break down crypto news in a way that educates both beginners and experienced traders.

BREAKING NEWS from ${source}:
HEADLINE: "${title}"
DETAILS: "${description}"

Write a 5-tweet Twitter thread breaking down this news story. Follow this EXACT structure:

TWEET 1 — THE HOOK (breaking news, grabs attention):
- Start with "🚨 BREAKING:" or "📢" to signal urgency
- State the news clearly and concisely
- End with "🧵 Thread 👇" to signal more is coming
- Max 240 characters
- 2-3 relevant hashtags e.g. #Bitcoin #Crypto #Ethereum

TWEET 2 — PLAIN ENGLISH (explain to a complete beginner):
- Start with "What does this mean? 🤔"
- Explain the news in simple terms a non-crypto person understands
- No jargon — use analogies if needed
- Max 260 characters

TWEET 3 — THE IMPLICATIONS (what happens next):
- Start with "Why this matters 📊"
- Explain impact on the market, prices, or crypto ecosystem
- Connect to African crypto holders where relevant
- Max 260 characters

TWEET 4 — HOW TO CAPITALISE (actionable advice):
- Start with "How to play this 💡"
- Give specific, actionable steps for investors/traders
- Be practical — what should someone do RIGHT NOW
- Max 260 characters

TWEET 5 — ENGAGEMENT QUESTION (spark conversation):
- Ask a thought-provoking question to get followers talking about this news
- Make it debatable — there should be no obvious single answer
- Relate it to the news story AND to everyday crypto holders or African investors
- Examples of good formats: "Are you buying the dip or waiting for lower? 👇", "Do you think this is bullish or bearish long term?", "How is this affecting your portfolio strategy?"
- End with 2-3 relevant hashtags e.g. #Bitcoin #Crypto #BTC #Ethereum
- Use 1-2 engaging emojis (👇 🤔 💬 📊 🌍)
- Max 240 characters
- Do NOT include any links

IMPORTANT RULES:
- Each tweet must be separated by "---TWEET---" on its own line
- Keep each tweet under its character limit
- Make it feel human, engaging and educational
- Vary emoji use — don't repeat the same emoji in consecutive tweets
- The thread should flow naturally from one tweet to the next
- Do NOT number the tweets (no "1/5", "2/5" etc)

Output all 5 tweets separated by ---TWEET--- only. Nothing else.`;
}

// ─── Quote tweet prompt ────────────────────────────────────

function buildQuotePrompt(title, description, username) {
  return `You are @oj_pulse, a professional crypto news account with an African perspective.

@${username} just posted about: "${title}"
Details: "${description}"

Write a quote tweet that adds valuable context or an African crypto angle.
Rules:
- Add something of VALUE beyond what was already said
- Mix of professional and enthusiastic tone
- Use 1-2 emojis (🌍 📈 ₿ 🔥 ⚡)
- Under 200 characters
- No links, no affiliate mentions — pure value only
- End with 1 relevant hashtag

Output the quote tweet text only. Nothing else.`;
}

// ─── Groq API ──────────────────────────────────────────────

async function callGroq(promptText, maxTokens = 800) {
  console.log(`🤖 Calling Groq...`);
  const res = await httpsPost(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model:       "llama-3.3-70b-versatile",
      max_tokens:  maxTokens,
      temperature: 0.7,
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
  return data.choices[0].message.content.trim();
}

// ─── Parse thread from Groq response ──────────────────────

function parseThread(rawText) {
  const tweets = rawText
    .split("---TWEET---")
    .map(t => t.trim().replace(/^["']|["']$/g, ""))
    .filter(t => t.length > 0);

  if (tweets.length < 3) {
    throw new Error(`Thread parsing failed — only got ${tweets.length} tweets`);
  }

  // Validate each tweet length
  for (let i = 0; i < tweets.length; i++) {
    if (tweets[i].length > 280) {
      console.warn(`⚠️  Tweet ${i + 1} is ${tweets[i].length} chars — trimming`);
      tweets[i] = tweets[i].slice(0, 277) + "...";
    }
  }

  return tweets;
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

// ─── Post single tweet ─────────────────────────────────────

async function postTweet(text, replyToId = null, quoteTweetId = null) {
  const TWEET_URL = "https://api.twitter.com/2/tweets";
  const payload   = { text };
  if (replyToId)    payload.reply        = { in_reply_to_tweet_id: replyToId };
  if (quoteTweetId) payload.quote_tweet_id = quoteTweetId;

  const res = await httpsPost(
    TWEET_URL,
    JSON.stringify(payload),
    {
      Authorization:  buildAuthHeader("POST", TWEET_URL),
      "Content-Type": "application/json",
    }
  );

  if (res.status === 201) {
    const data = JSON.parse(res.body);
    console.log(`   ✅ Posted tweet ID: ${data.data.id}`);
    return data.data.id;
  } else {
    throw new Error(`Twitter API error ${res.status}: ${res.body}`);
  }
}

// ─── Post full thread ──────────────────────────────────────

async function postThread(tweets) {
  console.log(`🧵 Posting thread of ${tweets.length} tweets...`);
  let lastTweetId = null;

  for (let i = 0; i < tweets.length; i++) {
    console.log(`   Posting tweet ${i + 1}/${tweets.length} (${tweets[i].length} chars)`);
    console.log(`   "${tweets[i].slice(0, 80)}..."`);

    lastTweetId = await postTweet(tweets[i], lastTweetId);

    // Small delay between tweets to avoid rate limiting
    if (i < tweets.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`✅ Full thread posted successfully!`);
}

// ─── Fetch latest tweet ID from account ───────────────────

async function getLatestTweetId(username) {
  console.log(`🔍 Fetching tweet from @${username}...`);

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

  console.log(`   ✓ Got tweet ID: ${tweets[0].id}`);
  return tweets[0].id;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log("🚀 @oj_pulse Crypto Thread Bot starting...");

  const required = [
    "GROQ_API_KEY","TWITTER_API_KEY","TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN","TWITTER_ACCESS_SECRET",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing secret: ${key}`);
  }
  console.log("✅ All secrets present");

  // Rotate affiliate between Binance and Bybit
  const count        = loadCount();
  const newCount     = count + 1;
  saveCount(newCount);
  const affiliateName = newCount % 2 === 0 ? "Bybit" : "Binance";
  const affiliateLink = newCount % 2 === 0 ? AFFILIATE.bybit : AFFILIATE.binance;
  console.log(`💰 Affiliate this run: ${affiliateName}`);

  // Fetch latest crypto news
  const headlines = await getLatestHeadlines();
  if (headlines.length === 0) throw new Error("All RSS feeds failed");

  const story = pickFreshHeadline(headlines);
  console.log(`📰 Story: "${story.title}" [${story.category}]`);

  // Pick tweet type
  const type = TWEET_TYPES[Math.floor(Math.random() * TWEET_TYPES.length)];
  console.log(`📝 Type: ${type}`);

  // ── Quote tweet flow ──
  if (type === "quote") {
    const username = QUOTE_ACCOUNTS[Math.floor(Math.random() * QUOTE_ACCOUNTS.length)];
    console.log(`🎯 Quote target: @${username}`);

    try {
      const tweetId   = await getLatestTweetId(username);
      const prompt    = buildQuotePrompt(story.title, story.description, username);
      const rawText   = await callGroq(prompt, 200);
      const tweetText = rawText.trim().replace(/^["']|["']$/g, "");

      console.log(`✍️  Quote tweet (${tweetText.length} chars): ${tweetText}`);
      if (tweetText.length > 280) throw new Error(`Too long: ${tweetText.length} chars`);
      await postTweet(tweetText, null, tweetId);

    } catch (e) {
      console.warn(`⚠️  Quote tweet failed (${e.message}) — falling back to thread`);
      const prompt  = buildThreadPrompt(story.title, story.description, story.source);
      const rawText = await callGroq(prompt, 800);
      const tweets  = parseThread(rawText);
      await postThread(tweets);
    }
    return;
  }

  // ── Thread flow ──
  const prompt  = buildThreadPrompt(story.title, story.description, story.source);
  const rawText = await callGroq(prompt, 800);
  const tweets  = parseThread(rawText);

  tweets.forEach((t, i) => {
    console.log(`\n📌 Tweet ${i + 1} (${t.length} chars):\n${t}`);
  });

  await postThread(tweets);
}

main().catch(err => {
  console.error("❌ Bot failed:", err.message);
  process.exit(1);
});
