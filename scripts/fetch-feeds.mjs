/**
 * 公式RSSからアイドル関連ニュースを収集し、src/_data/articles.json を更新する。
 *
 * 方針:
 *  - 全文は保存しない。見出し + 数百字の要約(RSS由来) + 出典リンクのみ。
 *  - 取得に失敗したフィードはスキップして処理を続行する。
 *  - 既存データとマージし、重複(リンクのハッシュ)を除いて新しい順に MAX_ITEMS 件保持する。
 *
 * 後から「AI要約」を足したい場合は summarize() を差し替える。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FEEDS_FILE = path.join(ROOT, "feeds.json");
const OUT_FILE = path.join(ROOT, "src", "_data", "articles.json");

const MAX_ITEMS = 300;          // 保持する記事の最大数
const SUMMARY_MAX = 280;        // 要約の最大文字数
const KEEP_DAYS = 120;          // これより古い記事は捨てる

/** アイドル関連だけに絞りたいときのキーワード。空配列にすると全記事を通す。 */
const KEYWORDS = [
  // 日本
  "アイドル", "坂道", "乃木坂", "櫻坂", "日向坂", "AKB", "SKE", "NMB", "HKT", "STU",
  "ハロプロ", "モーニング娘", "=LOVE", "≠ME", "≒JOY", "FRUITS ZIPPER", "ばってん",
  "ジャニーズ", "STARTO", "Snow Man", "SixTONES", "なにわ男子", "Travis Japan", "timelesz",
  "アイドルグループ", "新グループ", "デビュー",
  // 韓国 / K-POP
  "K-POP", "KPOP", "K-pop", "idol", "girl group", "boy group", "comeback", "debut",
  "BTS", "SEVENTEEN", "Stray Kids", "TXT", "ENHYPEN", "NCT", "aespa", "NewJeans",
  "IVE", "LE SSERAFIM", "ITZY", "TWICE", "BLACKPINK", "(G)I-DLE", "ILLIT", "BABYMONSTER",
  "RIIZE", "ZEROBASEONE", "BOYNEXTDOOR", "KATSEYE"
];

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8"
  }
});

// CI で rss-parser がソケットを掴んだままプロセスが終了しないことがあるので、
// 全体の上限時間を設けて確実に終わらせる。unref で監視タイマー自体は event loop を延命しない。
const WATCHDOG_MS = 90000;
setTimeout(() => {
  console.error(`watchdog: ${WATCHDOG_MS}ms を超えたため強制終了します`);
  process.exit(1);
}, WATCHDOG_MS).unref();

function hash(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 12);
}

function stripHtml(s = "") {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** いまはRSSの説明文を整形するだけ。将来ここをAI要約に差し替え可能。 */
function summarize(item) {
  const raw = item.contentSnippet || item.summary || item.content || item["content:encoded"] || "";
  const text = stripHtml(raw);
  if (text.length <= SUMMARY_MAX) return text;
  return text.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, "") + "…";
}

function matchesKeyword(item) {
  if (KEYWORDS.length === 0) return true;
  const hay = `${item.title || ""} ${item.contentSnippet || ""} ${item.categories || ""}`.toLowerCase();
  return KEYWORDS.some((k) => hay.includes(k.toLowerCase()));
}

function toArticle(item, feed) {
  const link = (item.link || item.guid || "").trim();
  if (!link) return null;
  const dateStr = item.isoDate || item.pubDate || null;
  const date = dateStr ? new Date(dateStr) : new Date();
  return {
    id: hash(link),
    title: stripHtml(item.title || "(無題)"),
    link,
    summary: summarize(item),
    source: feed.name,
    region: feed.region,
    date: isNaN(date) ? new Date().toISOString() : date.toISOString()
  };
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function main() {
  const { feeds } = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8"));
  const active = feeds.filter((f) => f.enabled !== false);

  const collected = [];
  for (const feed of active) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || [])
        .filter(matchesKeyword)
        .map((it) => toArticle(it, feed))
        .filter(Boolean);
      collected.push(...items);
      console.log(`OK   ${feed.name}: ${items.length} 件`);
    } catch (err) {
      console.warn(`SKIP ${feed.name}: ${err.message}`);
    }
  }

  const byId = new Map();
  for (const a of [...loadExisting(), ...collected]) byId.set(a.id, a);

  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const merged = [...byId.values()]
    .filter((a) => new Date(a.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`\n合計 ${merged.length} 件を ${path.relative(ROOT, OUT_FILE)} に書き出しました。`);
}

main()
  .then(() => process.exit(0)) // 未クローズのソケットが残っても確実に終了させる
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
