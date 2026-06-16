// ============================================================
//  @oj_pulse — Crypto News Bot
//  Covers: Bitcoin, Ethereum, Altcoins, DeFi, NFTs, Regulation
//  Tone: Professional + Informative + African Crypto Angle
//  Affiliate: Binance + Bybit (links in every relevant tweet)
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
//
//  IMPORTANT: Replace the affiliate links below with YOUR
//  actual Binance and Bybit affiliate links before deploying
// ============================================================

const https   = require("https");
const http    = require("http");
const crypto  = require("crypto");
const fs      = require("fs");
const { URL } = require("url");

// ─── YOUR AFFILIATE LINKS — replace with your actual links ─
const AFFILIATE = {
  binance: "https://www.binance.com/referral/earn-together/refer2earn-usdc/claim?hl=en&ref=GRO_28502_49PKK",
  bybit:   "https://www.bybit.com/invite?ref=9Z9QRPA",
};

// ─── RSS Feeds — Crypto News Sources ──────────────────────

const RSS_FEEDS = [
  { url: "https://cointelegraph.com/rss",                        source: "CoinTelegraph"   },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/",         source: "CoinDesk"        },
  { url: "https://decrypt.co/feed",                             source: "Decrypt"         },
  { url: "https://bitcoinmagazine.com/.rss/full/",              source: "Bitcoin Magazine" },
  { url: "https://thedefiant.io/feed",                          source: "The Defiant"     },
];

// Big crypto accounts to quote tweet
const QUOTE_ACCOUNTS = [
  // Media accounts
  "CoinDesk",
  "Cointelegraph",
  "DocumentingBTC",
  "BitcoinMagazine",
  "WatcherGuru",
  "crypto",
  "DecryptMedia",
  "thedefiant",
  "binance",
  "bybit_official",
  // Crypto whales
  "saylor",
  "VitalikButerin",
  "cz_binance",
  "APompliano",
  "RaoulGMI",
  "CathieDWood",
  "aantonop",
  "naval",
  "woonomic",
  "100trillionUSD",
];

// Content categories for variety
const CATEGORIES = {
  bitcoin:    ["Bitcoin", "BTC", "Lightning Network", "Bitcoin ETF", "Satoshi"],
  ethereum:   ["Ethereum", "ETH", "Vitalik", "EIP", "Ethereum upgrade"],
  altcoins:   ["Solana", "XRP", "BNB", "Cardano", "Avalanche", "Polygon", "altcoin"],
  defi:       ["DeFi", "DEX", "liquidity pool", "yield farming", "TVL", "protocol"],
  nfts:       ["NFT", "OpenSea", "digital art", "collection", "mint"],
  regulation: ["SEC", "regulation", "crypto law", "CBDC", "crypto ban", "crypto bill"],
  africa:     ["Africa", "Uganda", "Kenya", "Nigeria", "Ghana", "crypto adoption", "M-Pesa"],
};

// Weighted pool
// 40% breaking news, 25% analysis, 20% bullish hype, 15% quote tweet
const TWEET_TYPES = [
  "breaking",  "breaking",  "breaking",  "breaking",
  "analysis",  "analysis",  "analysis",  "analysis",  "analysis",
  "hype",      "hype",      "hype",      "hype",
  "quote",     "quote",     "quote",
];

// Affiliate push — every 3rd tweet subtly pushes an affiliate
// This is handled in the prompt logic below
let tweetCount = 0;

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
      description: cleanText(desc || "").slice(0, 300),
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

// ─── Detect content category from headline ─────────────────

function detectCategory(title) {
  const t = title.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => t.includes(k.toLowerCase()))) return cat;
  }
  return "bitcoin"; // default
}

// ─── Fetch latest headlines ────────────────────────────────

async function getLatestHeadlines() {
  const allItems = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`📡 Fetching: ${feed.source}`);
      const { body } = await httpGet(feed.url);
      const items = parseRSS(body)
        .slice(0, 8)
        .map(item => ({ ...item, source: feed.source, category: detectCategory(item.title) }));
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

// ─── Affiliate link selector ───────────────────────────────
// Rotates between Binance and Bybit every other affiliate push

function getAffiliateLink(count) {
  return count % 2 === 0 ? AFFILIATE.binance : AFFILIATE.bybit;
}

function getAffiliateName(count) {
  return count % 2 === 0 ? "Binance" : "Bybit";
}

// ─── Prompts ───────────────────────────────────────────────

const PROMPTS = {

  // 40% — Breaking news with detail
  breaking: (title, description, source, addAffiliate, affiliateName, affiliateLink) =>
    `You are @oj_pulse, a professional crypto news Twitter account covering Bitcoin, Ethereum, DeFi, NFTs, altcoins and blockchain regulation. You have an African perspective and a mix of professional, informative, and bullish tones.

BREAKING NEWS from ${source}:
HEADLINE: "${title}"
DETAILS: "${description}"

Write ONE informative tweet reporting this breaking crypto news with key details.

Rules:
- Report the news clearly and factually — headline + most important detail from the description
- Professional but with energy — this is BREAKING news in crypto
- Include price context or percentage if mentioned in the details
- Use 1-2 relevant crypto emojis only (₿ 🔥 📈 📉 🚨 ⚡ 🏦 🌍)
- Add 2-3 relevant hashtags e.g. #Bitcoin #Crypto #DeFi #Ethereum #Web3 #BTC
- Under 260 characters${addAffiliate ? `
- End with: "Trade on ${affiliateName}: ${affiliateLink}"` : ""}
- No jokes, no banter
- Do NOT just repeat the headline — add detail

Output the tweet text only. Nothing else.`,

  // 25% — Deep analytical take
  analysis: (title, description, source, addAffiliate, affiliateName, affiliateLink) =>
    `You are @oj_pulse, an experienced crypto analyst and journalist on Twitter with an African perspective.

News from ${source}:
HEADLINE: "${title}"
DETAILS: "${description}"

Write ONE analytical tweet explaining what this news means for the crypto market and investors.

Rules:
- Go beyond the headline — explain significance, implications, or what to watch next
- Can reference price impact, market sentiment, or what this means for African crypto holders
- Credible, knowledgeable tone — like an analyst who understands the market
- Use 1 emoji max (📊 📈 💡 🔍 ⚡)
- 1-2 hashtags max
- Under 260 characters${addAffiliate ? `
- End with: "Start trading on ${affiliateName}: ${affiliateLink}"` : ""}

Output the tweet text only. Nothing else.`,

  // 20% — Bullish hype with African angle
  hype: (title, description, source, addAffiliate, affiliateName, affiliateLink) =>
    `You are @oj_pulse, a bullish crypto enthusiast with a strong African perspective. You believe crypto is transforming Africa's financial future.

News from ${source}:
HEADLINE: "${title}"
DETAILS: "${description}"

Write ONE bullish, energetic tweet reacting to this news with an African/global crypto perspective.

Rules:
- Be enthusiastic and bullish — crypto is the future and this news proves it
- Connect to African context where possible (financial freedom, remittances, unbanked population)
- Inspire followers to get involved in crypto
- Use 2-3 emojis that match the hype (🚀 🌍 💰 🔥 ₿ 📈 ⚡ 🙌)
- 2-3 hashtags including #Africa or #CryptoAfrica where relevant
- Under 260 characters${addAffiliate ? `
- End with: "Get started on ${affiliateName}: ${affiliateLink}"` : ""}

Output the tweet text only. Nothing else.`,

  // 15% — Quote tweet a big crypto account
  quote: (title, description, username, addAffiliate, affiliateName, affiliateLink) =>
    `You are @oj_pulse, a professional crypto news account with an African perspective.

@${username} just posted about this crypto story:
HEADLINE: "${title}"
DETAILS: "${description}"

Write a quote tweet adding valuable context, analysis, or an African crypto perspective on top of their post.

Rules:
- Add something of VALUE — extra context, implication for African markets, or key detail
- Mix of professional and enthusiastic tone
- Reference specific facts from the details
- Use 1-2 emojis (🌍 📈 ₿ 🔥 ⚡)
- Under 200 characters (quoted tweet takes space)
- 1 hashtag max${addAffiliate ? `
- End with: "${affiliateName}: ${affiliateLink}"` : ""}

Output the quote tweet text only. Nothing else.`,

};

// ─── Groq API ──────────────────────────────────────────────

async function generateTweet(promptText) {
  console.log(`🤖 Calling Groq (llama-3.3-70b-versatile)...`);

  const res = await httpsPost(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model:       "llama-3.3-70b-versatile",
      max_tokens:  200,
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

// ─── Fetch latest tweet ID ─────────────────────────────────

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
  console.log("🚀 @oj_pulse Crypto Bot starting...");

  const required = [
    "GROQ_API_KEY","TWITTER_API_KEY","TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN","TWITTER_ACCESS_SECRET",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing secret: ${key}`);
  }
  console.log("✅ All secrets present");

  // Load and increment tweet count (controls affiliate frequency)
  const count       = loadCount();
  const newCount    = count + 1;
  saveCount(newCount);

  // Push affiliate link every 3rd tweet
  const addAffiliate   = newCount % 3 === 0;
  const affiliateName  = getAffiliateName(newCount);
  const affiliateLink  = getAffiliateLink(newCount);

  console.log(`📊 Tweet count: ${newCount} | Affiliate push: ${addAffiliate ? affiliateName : "No"}`);

  // Fetch latest crypto news
  const headlines = await getLatestHeadlines();
  if (headlines.length === 0) throw new Error("All RSS feeds failed — no headlines");

  const story = pickFreshHeadline(headlines);
  console.log(`📰 Story: "${story.title}" [${story.category}]`);
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
      const prompt    = PROMPTS.quote(
        story.title, story.description, username,
        addAffiliate, affiliateName, affiliateLink
      );
      const tweetText = await generateTweet(prompt);
      console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);
      if (tweetText.length > 280) throw new Error(`Too long: ${tweetText.length} chars`);
      await postTweet(tweetText, tweetId);

    } catch (e) {
      console.warn(`⚠️  Quote tweet failed (${e.message}) — falling back to breaking news`);
      const prompt    = PROMPTS.breaking(
        story.title, story.description, story.source,
        addAffiliate, affiliateName, affiliateLink
      );
      const tweetText = await generateTweet(prompt);
      console.log(`✍️  Fallback (${tweetText.length} chars): ${tweetText}`);
      await postTweet(tweetText);
    }
    return;
  }

  // ── Original tweet flow ──
  let prompt;
  if (type === "breaking") {
    prompt = PROMPTS.breaking(story.title, story.description, story.source, addAffiliate, affiliateName, affiliateLink);
  } else if (type === "analysis") {
    prompt = PROMPTS.analysis(story.title, story.description, story.source, addAffiliate, affiliateName, affiliateLink);
  } else {
    prompt = PROMPTS.hype(story.title, story.description, story.source, addAffiliate, affiliateName, affiliateLink);
  }

  const tweetText = await generateTweet(prompt);
  console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);

  if (tweetText.length > 280) throw new Error(`Tweet too long: ${tweetText.length} chars`);

  await postTweet(tweetText);
}

main().catch(err => {
  console.error("❌ Bot failed:", err.message);
  process.exit(1);
});
