// ============================================================
//  World Cup Twitter Bot — 100% Free Version
//  AI: Groq (free tier) running Llama 3
//  Scheduler: GitHub Actions (free)
//  Posting: X/Twitter API (free tier)
//
//  GitHub Secrets required:
//    GROQ_API_KEY         → console.groq.com → API Keys
//    TWITTER_API_KEY      → developer.twitter.com
//    TWITTER_API_SECRET   → developer.twitter.com
//    TWITTER_ACCESS_TOKEN → developer.twitter.com
//    TWITTER_ACCESS_SECRET→ developer.twitter.com
// ============================================================

const https = require("https");
const http  = require("http");
const crypto = require("crypto");
const fs     = require("fs");
const { URL } = require("url");

// ─── Config ────────────────────────────────────────────────

const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/sport/football/rss.xml",
  "https://www.espn.com/espn/rss/soccer/news",
  "https://www.goal.com/feeds/en/news",
];

const BANTER_TOPICS = [
  "VAR decisions ruining football",
  "Mbappe vs Ronaldo vs Messi GOAT debate",
  "Argentina defending their World Cup title",
  "African teams shocking everyone at the World Cup",
  "penalty shootouts being pure chaos",
  "managers losing their minds on the touchline",
  "surprise upsets at the World Cup",
  "the best World Cup goals of all time",
  "fans who never touched a ball giving tactics advice",
  "that one teammate who always blames the keeper",
  "referees making baffling decisions",
  "players diving like they've been shot",
];

const AFRICA_TOPICS = [
  "African teams making the World Cup knockouts",
  "AFCON being underrated by European media",
  "African players dominating European leagues",
  "the unmatched passion of African football fans",
  "East Africa's growing football scene",
  "African coaches proving themselves on the world stage",
];

// Weighted pool — news & banter post most
const TWEET_TYPES = [
  "news", "news", "news",
  "banter", "banter", "banter",
  "hottake", "hottake",
  "africa", "africa",
];

// ─── HTTP helpers ──────────────────────────────────────────

function httpGet(url, timeoutMs = 10000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const parsed = new URL(url);
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

// ─── RSS Parser ────────────────────────────────────────────

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    if (title) items.push({ title: cleanText(title) });
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
      console.log(`📡 Fetching: ${feed}`);
      const { body } = await httpGet(feed);
      const items = parseRSS(body).slice(0, 5);
      console.log(`   ✓ Got ${items.length} headlines`);
      headlines.push(...items.map((i) => i.title));
    } catch (e) {
      console.warn(`   ⚠️  Failed: ${e.message}`);
    }
  }
  return [...new Set(headlines)].slice(0, 10);
}

// ─── Groq AI — Tweet Generator ────────────────────────────

const PROMPTS = {
  news: (headline) =>
    `You are a witty World Cup Twitter account with a sharp football brain.
Headline: "${headline}"
Write ONE tweet reacting to this news.
Rules: under 230 characters, add a hot take or sarcastic reaction, max 2 hashtags (e.g. #WorldCup #FIFA), sound like a real football fan NOT a robot, no quotation marks.
Output the tweet text only. Nothing else.`,

  banter: (topic) =>
    `You are a football banter account — funny, relatable, and a little savage.
Topic: "${topic}"
Write ONE banter tweet.
Rules: under 230 characters, use football fan humor (mock outrage, exaggeration, roasting), keep it tasteful, caps allowed on 1-2 words for emphasis, no hashtags needed.
Output the tweet text only. Nothing else.`,

  hottake: (topic) =>
    `You are a football pundit known for controversial but intelligent opinions.
Topic: "${topic}"
Write ONE hot take tweet: bold claim first, one-line justification, end with a debate question.
Rules: under 220 characters, no hashtags, must be defensible not just trolling.
Output the tweet text only. Nothing else.`,

  africa: (topic) =>
    `You are a football Twitter account celebrating African football with pride and humor.
Topic: "${topic}"
Write ONE tweet mixing pride, humor and passion. Relatable to East African and African football fans. Max 2 hashtags like #AFCON or #WorldCup.
Rules: under 230 characters.
Output the tweet text only. Nothing else.`,
};

async function generateTweet(type, context) {
  console.log(`🤖 Calling Groq API (llama3-8b-8192)...`);

  const res = await httpsPost(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama3-8b-8192",
      max_tokens: 150,
      temperature: 0.9,
      messages: [{ role: "user", content: PROMPTS[type](context) }],
    },
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    }
  );

  if (res.status !== 200) {
    throw new Error(`Groq API error ${res.status}: ${res.body}`);
  }

  const data = JSON.parse(res.body);

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error(`Unexpected Groq response: ${JSON.stringify(data)}`);
  }

  return data.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
}

// ─── Twitter OAuth 1.0a Signing ────────────────────────────

function oauthSign(method, url, oauthParams, consumerSecret, tokenSecret) {
  const encode = (s) => encodeURIComponent(String(s));
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encode(k)}=${encode(oauthParams[k])}`)
    .join("&");
  const baseString = [method.toUpperCase(), encode(url), encode(paramString)].join("&");
  const signingKey = `${encode(consumerSecret)}&${encode(tokenSecret)}`;
  return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function buildAuthHeader(method, url) {
  const oauthParams = {
    oauth_consumer_key:     process.env.TWITTER_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            process.env.TWITTER_ACCESS_TOKEN,
    oauth_version:          "1.0",
  };

  oauthParams.oauth_signature = oauthSign(
    method, url, oauthParams,
    process.env.TWITTER_API_SECRET,
    process.env.TWITTER_ACCESS_SECRET
  );

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(", ")
  );
}

// ─── Post Tweet ────────────────────────────────────────────

async function postTweet(text) {
  const TWEET_URL = "https://api.twitter.com/2/tweets";
  console.log(`🐦 Posting to Twitter...`);

  const res = await httpsPost(
    TWEET_URL,
    JSON.stringify({ text }),
    {
      Authorization:  buildAuthHeader("POST", TWEET_URL),
      "Content-Type": "application/json",
    }
  );

  console.log(`   Twitter response: ${res.status}`);

  if (res.status === 201) {
    const data = JSON.parse(res.body);
    console.log(`✅ Tweet posted! ID: ${data.data.id}`);
    console.log(`   "${text}"`);
    return data;
  } else {
    throw new Error(`Twitter API error ${res.status}: ${res.body}`);
  }
}

// ─── Deduplication ─────────────────────────────────────────

const SEEN_FILE = "/tmp/seen_headlines.json";

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch { return []; }
}

function saveSeen(arr) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr.slice(-50)));
}

function pickFreshHeadline(headlines) {
  const seen = loadSeen();
  const fresh = headlines.filter((h) => !seen.includes(h));
  const pick = fresh.length > 0
    ? fresh[Math.floor(Math.random() * fresh.length)]
    : headlines[Math.floor(Math.random() * headlines.length)];
  seen.push(pick);
  saveSeen(seen);
  return pick;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log("⚽ World Cup Bot starting (Groq free tier)...");

  // Validate secrets
  const required = [
    "GROQ_API_KEY",
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_SECRET",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing secret: ${key}`);
  }
  console.log("✅ All secrets present");

  // Pick tweet type
  const type = TWEET_TYPES[Math.floor(Math.random() * TWEET_TYPES.length)];
  console.log(`📝 Tweet type: ${type}`);

  let context;

  if (type === "news") {
    const headlines = await getLatestHeadlines();
    if (headlines.length === 0) {
      console.warn("⚠️  No headlines found — falling back to banter");
      context = BANTER_TOPICS[Math.floor(Math.random() * BANTER_TOPICS.length)];
    } else {
      context = pickFreshHeadline(headlines);
      console.log(`📰 Using headline: ${context}`);
    }
  } else if (type === "banter") {
    context = BANTER_TOPICS[Math.floor(Math.random() * BANTER_TOPICS.length)];
  } else if (type === "hottake") {
    const all = [...BANTER_TOPICS, ...AFRICA_TOPICS];
    context = all[Math.floor(Math.random() * all.length)];
  } else {
    context = AFRICA_TOPICS[Math.floor(Math.random() * AFRICA_TOPICS.length)];
  }

  // Generate tweet
  const tweetText = await generateTweet(type, context);
  console.log(`✍️  Generated (${tweetText.length} chars): ${tweetText}`);

  if (tweetText.length > 280) {
    throw new Error(`Tweet too long: ${tweetText.length} chars`);
  }

  // Post it
  await postTweet(tweetText);
}

main().catch((err) => {
  console.error("❌ Bot failed:", err.message);
  process.exit(1);
});
