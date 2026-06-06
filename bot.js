// ============================================================
//  World Cup Twitter Bot — Complete Production Script
//  Stack: Node.js 20+, zero dependencies (stdlib only)
//  Env vars required (set as GitHub Secrets):
//    ANTHROPIC_API_KEY
//    TWITTER_API_KEY
//    TWITTER_API_SECRET
//    TWITTER_ACCESS_TOKEN
//    TWITTER_ACCESS_SECRET
// ============================================================

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

// ─── Config ────────────────────────────────────────────────

const RSS_FEEDS = [
  "http://feeds.bbci.co.uk/sport/football/rss.xml",
  "https://www.espn.com/espn/rss/soccer/news",
  "https://www.goal.com/feeds/en/news",
];

const BANTER_TOPICS = [
  "VAR decisions ruining football",
  "Mbappe vs Ronaldo vs Messi GOAT debate",
  "Argentina defending their World Cup title",
  "African teams at the World Cup",
  "penalty shootouts being pure chaos",
  "managers losing their minds on the touchline",
  "surprise upsets at the World Cup",
  "the best World Cup goals of all time",
  "fans who never touched a ball giving tactics advice",
  "that one teammate who always blames the keeper",
];

const AFRICA_TOPICS = [
  "African teams making the World Cup knockouts",
  "AFCON being underrated by European media",
  "African players dominating European leagues",
  "the passion of African football fans",
  "East Africa's growing football scene",
];

// Weighted type selection — news & banter post most often
const TWEET_TYPES = [
  "news", "news", "news",
  "banter", "banter", "banter",
  "hottake", "hottake",
  "africa", "africa",
];

// ─── HTTP helper (no axios needed) ────────────────────────

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      // Follow single redirect
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Length": Buffer.byteLength(data), ...headers },
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

// ─── RSS Parser (no cheerio/xml libs needed) ───────────────

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link  = extractTag(block, "link");
    const desc  = extractTag(block, "description");
    if (title) items.push({ title: cleanText(title), link, description: cleanText(desc || "") });
  }
  return items;
}

function extractTag(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function cleanText(str) {
  return str
    .replace(/<[^>]+>/g, "")        // strip HTML tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getLatestHeadlines() {
  const headlines = [];
  for (const feed of RSS_FEEDS) {
    try {
      const { body } = await httpGet(feed);
      const items = parseRSS(body).slice(0, 5);
      headlines.push(...items.map((i) => i.title));
    } catch (e) {
      console.warn(`RSS fetch failed for ${feed}:`, e.message);
    }
  }
  // Deduplicate and return up to 10
  return [...new Set(headlines)].slice(0, 10);
}

// ─── Claude AI — Tweet Generator ──────────────────────────

const PROMPTS = {
  news: (headline) => `You are a witty, punchy World Cup Twitter account with a sharp football brain.
Headline: "${headline}"
Write ONE tweet reacting to this news. Rules:
- Under 230 characters
- Add a hot take, sarcastic comment, or hype reaction
- Max 2 relevant hashtags (e.g. #WorldCup #FIFA)
- Sound like a real football fan, NOT a robot
- No quotation marks around the tweet
Output the tweet text only.`,

  banter: (topic) => `You are a football banter account loved for being funny, relatable, and a little savage.
Topic: "${topic}"
Write ONE banter tweet. Rules:
- Under 230 characters  
- Use football fan humor — mock outrage, exaggeration, or roasting
- Keep it tasteful (no slurs, no personal attacks)
- Feel free to use caps for emphasis on 1-2 words
- No hashtags needed
Output the tweet text only.`,

  hottake: (topic) => `You are a football pundit known for controversial but intelligent opinions.
Topic: "${topic}"
Write ONE hot take tweet. Structure:
1. Bold controversial claim (first sentence)
2. One-line justification
3. End with a question to spark debate
Rules: under 220 characters, no hashtags, must be defensible not just trolling.
Output the tweet text only.`,

  africa: (topic) => `You are a football Twitter account that celebrates African football with pride and humor.
Topic: "${topic}"
Write ONE tweet. Rules:
- Under 230 characters
- Mix pride, humor, and passion
- Relatable to East African / African football fans
- Can use 1-2 relevant hashtags like #AFCON or #WorldCup
Output the tweet text only.`,
};

async function generateTweet(type, context) {
  const prompt = PROMPTS[type](context);
  const res = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5",
      max_tokens: 120,
      messages: [{ role: "user", content: prompt }],
    },
    {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    }
  );

  if (res.status !== 200) {
    throw new Error(`Anthropic API error ${res.status}: ${res.body}`);
  }
  const data = JSON.parse(res.body);
  return data.content[0].text.trim().replace(/^["']|["']$/g, ""); // strip wrapping quotes if any
}

// ─── Twitter OAuth 1.0a Signing ────────────────────────────

function oauthSign(method, url, params, consumerKey, consumerSecret, tokenSecret) {
  // 1. Collect all params and percent-encode keys + values
  const encode = (s) => encodeURIComponent(String(s));

  const allParams = { ...params };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${encode(k)}=${encode(allParams[k])}`)
    .join("&");

  // 2. Build signature base string
  const baseString = [method.toUpperCase(), encode(url), encode(paramString)].join("&");

  // 3. Build signing key
  const signingKey = `${encode(consumerSecret)}&${encode(tokenSecret)}`;

  // 4. HMAC-SHA1
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  return signature;
}

function buildAuthHeader(method, url, bodyParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     process.env.TWITTER_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            process.env.TWITTER_ACCESS_TOKEN,
    oauth_version:          "1.0",
  };

  // Include body params in signature calculation
  const allParams = { ...oauthParams, ...bodyParams };

  oauthParams.oauth_signature = oauthSign(
    method,
    url,
    allParams,
    process.env.TWITTER_API_KEY,
    process.env.TWITTER_API_SECRET,
    process.env.TWITTER_ACCESS_SECRET
  );

  // Build Authorization header (only oauth_ params, NOT body params)
  const headerValue =
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(", ");

  return headerValue;
}

// ─── Post Tweet ────────────────────────────────────────────

async function postTweet(text) {
  const TWEET_URL = "https://api.twitter.com/2/tweets";
  const body = JSON.stringify({ text });
  const authHeader = buildAuthHeader("POST", TWEET_URL);

  const res = await httpsPost(TWEET_URL, body, {
    Authorization:   authHeader,
    "Content-Type":  "application/json",
  });

  if (res.status === 201) {
    const data = JSON.parse(res.body);
    console.log(`✅ Tweet posted! ID: ${data.data.id}`);
    console.log(`   Text: ${text}`);
    return data;
  } else {
    throw new Error(`Twitter API error ${res.status}: ${res.body}`);
  }
}

// ─── Deduplication (via GitHub Actions cache file) ─────────

const SEEN_FILE = "/tmp/seen_headlines.json";
const fs = require("fs");

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch { return []; }
}

function saveSeen(arr) {
  // Keep last 50 only
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr.slice(-50)));
}

function pickFreshHeadline(headlines) {
  const seen = loadSeen();
  const fresh = headlines.filter((h) => !seen.includes(h));
  if (fresh.length === 0) return headlines[0]; // fallback: reuse oldest
  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  seen.push(pick);
  saveSeen(seen);
  return pick;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log("🤖 World Cup Bot starting...");

  // Validate env vars
  const required = [
    "ANTHROPIC_API_KEY",
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_SECRET",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
  }

  // Pick tweet type
  const type = TWEET_TYPES[Math.floor(Math.random() * TWEET_TYPES.length)];
  console.log(`📝 Generating tweet type: ${type}`);

  let context;

  if (type === "news") {
    const headlines = await getLatestHeadlines();
    if (headlines.length === 0) throw new Error("No headlines fetched from RSS feeds");
    context = pickFreshHeadline(headlines);
    console.log(`📰 Headline: ${context}`);
  } else if (type === "banter") {
    context = BANTER_TOPICS[Math.floor(Math.random() * BANTER_TOPICS.length)];
  } else if (type === "hottake") {
    // Mix of banter + africa topics for hot takes
    const all = [...BANTER_TOPICS, ...AFRICA_TOPICS];
    context = all[Math.floor(Math.random() * all.length)];
  } else {
    context = AFRICA_TOPICS[Math.floor(Math.random() * AFRICA_TOPICS.length)];
  }

  // Generate tweet text via Claude
  const tweetText = await generateTweet(type, context);
  console.log(`✍️  Generated: ${tweetText}`);

  // Guard: enforce character limit
  if (tweetText.length > 280) {
    throw new Error(`Tweet too long (${tweetText.length} chars): ${tweetText}`);
  }

  // Post to Twitter
  await postTweet(tweetText);
}

main().catch((err) => {
  console.error("❌ Bot failed:", err.message);
  process.exit(1);
});
