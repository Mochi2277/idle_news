/**
 * 最新のコラムを X(Twitter) に投稿する。
 *
 *  - src/_data/columns.json の先頭(最新)を見る
 *  - それが「今日(JST)」のコラムで、まだ投稿していない(posted_x が無い)なら投稿
 *  - 投稿文 = タイトル + リード(dek) + コラムURL。X がリンクからOGPカードを自動表示する
 *  - 投稿できたら columns.json の該当エントリに posted_x:true を書き込む
 *
 * 必要な環境変数(GitHub Secrets): X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *   X_API_KEY/X_API_SECRET      = アプリの API Key / API Key Secret (Consumer Key/Secret)
 *   X_ACCESS_TOKEN/X_ACCESS_SECRET = Read and Write 権限で発行した Access Token / Secret
 * 任意: SITE_URL(既定 https://mochi2277.github.io/idle_news), X_DRY_RUN=1(投稿せず本文だけ表示),
 *       X_FORCE=1(posted_x があっても再投稿)
 *
 * キー未設定 / 今日のコラムが無い / 既に投稿済み の場合は何もせず正常終了(exit 0)。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLUMNS_FILE = path.join(ROOT, "src", "_data", "columns.json");
const SITE_URL = (process.env.SITE_URL || "https://mochi2277.github.io/idle_news").replace(/\/$/, "");
const DRY_RUN = process.env.X_DRY_RUN === "1";
const FORCE = process.env.X_FORCE === "1";

const KEYS = {
  consumerKey: process.env.X_API_KEY || "",
  consumerSecret: process.env.X_API_SECRET || "",
  token: process.env.X_ACCESS_TOKEN || "",
  tokenSecret: process.env.X_ACCESS_SECRET || ""
};

const log = (...a) => console.log(...a);

function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** X の重み付き文字数(CJK等は2、URLは23固定)。 */
function weighted(text) {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function buildText(col) {
  const url = `${SITE_URL}/columns/${col.slug}/`;
  const lead = String(col.dek || col.body_md || "")
    .replace(/\[\d+\]/g, "")
    .replace(/[#*`>_-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const FIXED = weighted("\n\n") + weighted("\n") + 23; // 改行 + URL(23固定)
  const LIMIT = 275; // 280 に少し余裕
  let title = String(col.title || "").trim();
  let budget = LIMIT - FIXED - weighted(title);
  let lead2 = lead;
  while (weighted(lead2) > budget && lead2.length > 1) {
    lead2 = lead2.slice(0, -1);
  }
  if (lead2 !== lead) lead2 = lead2.replace(/[、。！？,.\s]+$/, "") + "…";

  return `${title}\n\n${lead2}\n${url}`;
}

/* ---------- OAuth 1.0a 署名 ---------- */
function pct(s) {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function authHeader(method, url) {
  const oauth = {
    oauth_consumer_key: KEYS.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: KEYS.token,
    oauth_version: "1.0"
  };
  const paramString = Object.keys(oauth)
    .sort()
    .map((k) => `${pct(k)}=${pct(oauth[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const signingKey = `${pct(KEYS.consumerSecret)}&${pct(KEYS.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

async function postTweet(text) {
  const url = "https://api.twitter.com/2/tweets";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader("POST", url)
    },
    body: JSON.stringify({ text })
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`X API HTTP ${res.status}: ${bodyText.slice(0, 400)}`);
  return JSON.parse(bodyText);
}

async function main() {
  const missing = Object.entries(KEYS)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length && !DRY_RUN) {
    log(`SKIP: Xのキーが未設定 (${missing.join(", ")})`);
    return;
  }

  let columns;
  try {
    columns = JSON.parse(fs.readFileSync(COLUMNS_FILE, "utf8"));
  } catch {
    columns = [];
  }
  const col = columns[0];
  const today = jstDate();

  if (!col) {
    log("SKIP: コラムがありません。");
    return;
  }
  if (col.date !== today && !FORCE) {
    log(`SKIP: 最新コラムの日付(${col.date})が今日(${today})ではありません。`);
    return;
  }
  if (col.posted_x && !FORCE) {
    log("SKIP: このコラムは既にXへ投稿済みです。");
    return;
  }

  const text = buildText(col);
  log(`--- 投稿本文 (${weighted(text)} / 280) ---\n${text}\n---------------------------`);

  if (DRY_RUN) {
    log("DRY RUN: 投稿はしません。");
    return;
  }

  try {
    const r = await postTweet(text);
    log(`OK: 投稿しました id=${r?.data?.id}`);
    col.posted_x = true;
    fs.writeFileSync(COLUMNS_FILE, JSON.stringify(columns, null, 2) + "\n", "utf8");
  } catch (e) {
    log(`ERROR: X投稿に失敗: ${e.message}`);
  }
}

main()
  .catch((e) => console.error("ERROR(想定外):", e))
  .finally(() => process.exit(0));
