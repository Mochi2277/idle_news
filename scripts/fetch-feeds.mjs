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
const BODY_MAX = 3500;          // コラム生成用に保持する本文の最大文字数
const KEEP_DAYS = 120;          // これより古い記事は捨てる

const TRANSLATE = true;         // 英語(韓国系)記事の見出し・要約を日本語へ自動翻訳する
const TRANSLATE_MAX = 50;       // 1回の実行で翻訳するフィールド数の上限(無料枠・レート制限の保護)
                               // 既訳はキャッシュされるので、数回の実行で全記事が日本語化される

/**
 * mode:"strict" のフィードで「アイドル/アーティスト関連」と判定するためのキーワード。
 * mode:"loose" のフィードでは使わない(除外ワードに当たらなければ通す)。
 */
const KEYWORDS = [
  // 日本 - 一般語
  "アイドル", "アイドルグループ", "ガールズグループ", "ボーイズグループ", "新グループ",
  "デビュー", "改名", "新曲", "シングル", "アルバム", "MV", "ミュージックビデオ",
  "ライブ", "ワンマン", "ツアー", "フェス", "音楽番組", "配信リリース", "センター",
  // 日本 - 坂道 / 秋元系
  "坂道", "乃木坂", "櫻坂", "日向坂", "AKB48", "SKE48", "NMB48", "HKT48", "STU48", "NGT48",
  "=LOVE", "イコラブ", "≠ME", "ノイミー", "≒JOY", "ニアジョイ",
  // 日本 - ハロプロ
  "ハロプロ", "ハロー!プロジェクト", "モーニング娘", "アンジュルム", "Juice=Juice",
  "つばきファクトリー", "BEYOOOOONDS", "OCHA NORMA",
  // 日本 - 事務所 / 男性アイドル
  "STARTO", "旧ジャニーズ", "Snow Man", "SixTONES", "なにわ男子", "Travis Japan",
  "timelesz", "King & Prince", "Hey! Say! JUMP", "Kis-My-Ft2", "A.B.C-Z", "WEST.",
  "Aぇ! group", "少年忍者", "JO1", "INI", "DXTEEN", "ME:I", "IS:SUE", "IMP.", "OCTPATH", "KO1KEYZ",
  // 日本 - その他アイドル
  "FRUITS ZIPPER", "CANDY TUNE", "SWEET STEADY", "CUTIE STREET", "超ときめき",
  "私立恵比寿中学", "でんぱ組", "スタァライト", "22/7", "アップアップガールズ",
  "ばってん少女隊", "テレ東音楽祭", "アイドルマスター",
  // 韓国 / K-POP - 一般語
  "K-POP", "KPOP", "K-pop", "케이팝", "아이돌", "걸그룹", "보이그룹", "컴백", "데뷔",
  "신곡", "미니앨범", "정규앨범", "타이틀곡", "뮤직비디오", "음악방송", "콘서트", "팬미팅",
  "idol", "girl group", "boy group", "comeback", "debut", "mini album", "title track",
  "music video", "world tour", "fan meeting", "lightstick",
  // 韓国 / K-POP - グループ名
  "BTS", "방탄소년단", "SEVENTEEN", "세븐틴", "Stray Kids", "스트레이 키즈", "TXT",
  "투모로우바이투게더", "ENHYPEN", "엔하이픈", "NCT", "엔시티", "aespa", "에스파",
  "NewJeans", "뉴진스", "IVE", "아이브", "LE SSERAFIM", "르세라핌", "ITZY", "있지",
  "TWICE", "트와이스", "BLACKPINK", "블랙핑크", "(G)I-DLE", "아이들", "ILLIT", "아일릿",
  "BABYMONSTER", "베이비몬스터", "RIIZE", "라이즈", "ZEROBASEONE", "제로베이스원",
  "BOYNEXTDOOR", "보이넥스트도어", "KATSEYE", "PLAVE", "플레이브", "TWS", "투어스",
  "EXO", "엑소", "Red Velvet", "레드벨벳", "SHINee", "샤이니", "NMIXX", "엔믹스",
  "KISS OF LIFE", "키스오브라이프", "MEOVV", "미야오", "ARTMS", "izna", "이즈나",
  "Hearts2Hearts", "ALLDAY PROJECT", "ALPHA DRIVE ONE"
];

/**
 * グラビア/水着/パパラッチ系の記事を弾く除外ワード。
 * mode に関係なく、どのフィードにも適用される。
 */
const EXCLUDE = [
  "グラビア", "写真集", "水着", "ビキニ", "ランジェリー", "下着", "セクシー", "セクシーショット",
  "悩殺", "谷間", "美ボディ", "美バスト", "美尻", "美脚", "美太もも", "太もも", "生足",
  "デコルテ", "美デコルテ", "鎖骨", "二の腕", "くびれ", "ヘソ出し", "へそ出し", "美へそ",
  "ベアトップ", "オフショル", "肩出し", "背中見せ", "美背中", "透け", "ノーブラ",
  "ヘアヌード", "ヌード", "セミヌード", "巨乳", "爆乳", "Gカップ", "Fカップ", "Eカップ",
  "着エロ", "過激", "大胆", "艶", "色っぽ", "セクシー女優", "AV女優", "週刊誌",
  "gravure", "swimsuit", "bikini", "lingerie", "cleavage"
];

/**
 * グループ別サイドバー用のタグ付け辞書。
 * canonical名: [別名(日本語/英語/ハングル/略称) ...]
 * 記事タイトル+要約に別名が含まれると、その canonical 名がタグとして付く。
 * 3〜4文字以下の英字別名は前後が英数字でない場合のみ一致(誤爆防止)。
 * ここに足せば自動でサイドバーに項目が増える(記事が1件以上ある場合のみ表示)。
 */
const GROUPS = {
  // --- K-POP ---
  "BTS": ["bts", "방탄소년단", "防弾少年団", "バンタン"],
  "SEVENTEEN": ["seventeen", "세븐틴", "セブチ", "セブンティーン"],
  "Stray Kids": ["stray kids", "straykids", "스트레이 키즈", "스키즈", "スキズ", "ストレイキッズ", "skz"],
  "TXT": ["tomorrow x together", "투모로우바이투게더", "txt", "トゥバ", "トゥモローバイトゥゲザー"],
  "ENHYPEN": ["enhypen", "엔하이픈", "エンハイプン"],
  "NCT": ["nct", "엔시티", "エヌシーティー"],
  "aespa": ["aespa", "에스파", "エスパ"],
  "NewJeans": ["newjeans", "new jeans", "뉴진스", "ニュージーンズ", "ニュジ"],
  "IVE": ["ive", "아이브", "アイヴ"],
  "LE SSERAFIM": ["le sserafim", "lesserafim", "르세라핌", "ルセラフィム", "ルセラ"],
  "ITZY": ["itzy", "있지", "イッジ"],
  "TWICE": ["twice", "트와이스", "トゥワイス", "トワイス"],
  "BLACKPINK": ["blackpink", "black pink", "블랙핑크", "ブラックピンク", "ブルピン"],
  "(G)I-DLE": ["(g)i-dle", "gi-dle", "g-idle", "아이들", "ジーアイドル", "アイドゥル"],
  "ILLIT": ["illit", "아일릿", "アイリット"],
  "BABYMONSTER": ["babymonster", "베이비몬스터", "ベイビーモンスター", "ベビモン"],
  "RIIZE": ["riize", "라이즈", "ライズ"],
  "ZEROBASEONE": ["zerobaseone", "zb1", "제로베이스원", "ゼロベースワン", "ゼベワン"],
  "BOYNEXTDOOR": ["boynextdoor", "보이넥스트도어", "ボーイネクストドア", "ボイネク"],
  "KATSEYE": ["katseye", "カットアイ"],
  "PLAVE": ["plave", "플레이브", "プレイブ"],
  "TWS": ["tws", "투어스", "トゥアス"],
  "EXO": ["exo", "엑소", "エクソ"],
  "Red Velvet": ["red velvet", "레드벨벳", "レドベル", "レッドベルベット"],
  "SHINee": ["shinee", "샤이니", "シャイニー"],
  "NMIXX": ["nmixx", "엔믹스", "エンミックス"],
  "KISS OF LIFE": ["kiss of life", "키스오브라이프", "キスオブライフ"],
  "Girls' Generation": ["girls' generation", "girls generation", "소녀시대", "少女時代", "snsd"],
  "MAMAMOO": ["mamamoo", "마마무", "ママム"],
  "Apink": ["apink", "에이핑크", "エーピンク"],
  "TREASURE": ["treasure", "트레저", "トレジャー"],
  "ATEEZ": ["ateez", "에이티즈", "エイティーズ"],
  "THE BOYZ": ["the boyz", "더보이즈", "ドボイズ"],
  "ALPHA DRIVE ONE": ["ald1", "ALD1", "アルファドライブワン"],
  // --- 日本 ---
  "乃木坂46": ["乃木坂46", "乃木坂", "nogizaka"],
  "櫻坂46": ["櫻坂46", "櫻坂", "sakurazaka"],
  "日向坂46": ["日向坂46", "日向坂", "hinatazaka"],
  "AKB48": ["akb48"],
  "=LOVE": ["=love", "イコラブ"],
  "≠ME": ["≠me", "ノイミー"],
  "Snow Man": ["snow man", "スノーマン", "スノ"],
  "SixTONES": ["sixtones", "ストーンズ"],
  "なにわ男子": ["なにわ男子", "naniwa danshi"],
  "King & Prince": ["king & prince", "king&prince", "キンプリ"],
  "timelesz": ["timelesz", "タイムレス"],
  "Travis Japan": ["travis japan", "トラジャ"],
  "JO1": ["jo1", "ジェイオーワン"],
  "INI": ["ini", "アイエヌアイ"],
  "ME:I": ["me:i", "ミーアイ"],
  "IS:SUE": ["issue", "イッシュ"],
  "DXTEEN": ["dxteen", "ディーエックスティーン"],
  "KO1KEYZ": ["ko1keyz", "コイキーズ"],
  "FRUITS ZIPPER": ["fruits zipper", "フルーツジッパー", "フルジ"],
  "CANDY TUNE": ["candy tune", "キャンディーチューン", "キャンチュ"],
  "M!LK": ["m!lk", "ミルク"],
  "ハロプロ": ["ハロプロ", "ハロー!プロジェクト", "モーニング娘", "アンジュルム", "juice=juice", "つばきファクトリー", "beyooooonds"],
  "超ときめき♡宣伝部": ["超ときめき", "ときめき宣伝部", "とき宣"]
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** グループ名 → URLハッシュ用スラッグ。日本語はそのまま残す(hashに載せられる)。 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** 記事テキストから該当グループの {name, slug} 配列を返す。 */
function groupsFor(text) {
  const hay = text.toLowerCase();
  const out = [];
  for (const [canon, aliases] of Object.entries(GROUPS)) {
    const hit = aliases.some((al) => {
      const a = al.toLowerCase();
      if (/^[\x00-\x7f]+$/.test(a) && a.length <= 4) {
        return new RegExp(`(^|[^a-z0-9])${escapeRegex(a)}([^a-z0-9]|$)`, "i").test(hay);
      }
      return hay.includes(a);
    });
    if (hit) out.push({ name: canon, slug: slugify(canon) });
  }
  return out;
}

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
const WATCHDOG_MS = 210000; // 翻訳(逐次HTTP)を含むため長めに
setTimeout(() => {
  console.error(`watchdog: ${WATCHDOG_MS}ms を超えたため強制終了します`);
  process.exit(1);
}, WATCHDOG_MS).unref();

/* ---------------- 自動翻訳(無料・APIキー不要) ---------------- */

/** かな が無く英字を含む = 英語記事とみなす(日本語のDanmee等は翻訳しない)。 */
function looksEnglish(s) {
  if (!s) return false;
  if (/[぀-ヿ]/.test(s)) return false; // ひらがな・カタカナがあれば日本語扱い
  return /[a-z]/i.test(s);
}

let translateBudget = TRANSLATE_MAX;
let translateFails = 0;
let translateBlocked = false;

/** タイムアウト付き fetch(AbortSignal.timeout は終了時に警告を出すことがあるので手動制御)。 */
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** MyMemory(公式・無料・キー不要。匿名は約5000語/日、1リクエスト約500字まで)。 */
async function viaMyMemory(text) {
  const q = text.slice(0, 480);
  const url =
    "https://api.mymemory.translated.net/get?langpair=en|ja&q=" + encodeURIComponent(q);
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error(`MyMemory ${data.responseStatus}`);
  const out = (data.responseData?.translatedText || "").trim();
  if (!out || /MYMEMORY WARNING|QUOTA/i.test(out)) throw new Error("MyMemory quota/empty");
  return out;
}

/** Google翻訳の非公式エンドポイント(予備。IPによっては429)。 */
async function viaGoogle(text) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=" +
    encodeURIComponent(text.slice(0, 1800));
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data = await res.json();
  const out = (data[0] || []).map((seg) => (seg && seg[0]) || "").join("").trim();
  if (!out) throw new Error("Google empty");
  return out;
}

/** 複数プロバイダを順に試して日本語へ。全滅が3回続いたら以降スキップ。失敗時 null。 */
async function translateToJa(text) {
  if (translateBlocked || translateBudget <= 0) return null;
  translateBudget -= 1;
  for (const provider of [viaMyMemory, viaGoogle]) {
    try {
      const out = await provider(text);
      translateFails = 0;
      await new Promise((r) => setTimeout(r, 150));
      return out;
    } catch {
      /* 次のプロバイダへ */
    }
  }
  translateFails += 1;
  if (translateFails >= 3) {
    translateBlocked = true;
    console.warn("  翻訳を停止(全プロバイダ連続失敗)");
  }
  return null;
}

/** merged の英語記事に title_ja / summary_ja を付与(既訳はスキップ=キャッシュ)。 */
async function translateArticles(articles) {
  if (!TRANSLATE) return;
  let done = 0;
  for (const a of articles) {
    if (translateBlocked || translateBudget <= 0) break;
    if (!("title_ja" in a) && looksEnglish(a.title)) {
      const t = await translateToJa(a.title);
      if (t) {
        a.title_ja = t;
        done += 1;
      }
    }
    if (!("summary_ja" in a) && looksEnglish(a.summary)) {
      const s = await translateToJa(a.summary);
      if (s) a.summary_ja = s;
    }
  }
  console.log(`翻訳: 新規 ${done} 件を日本語化 (残り予算 ${Math.max(translateBudget, 0)})`);
}

function hash(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 12);
}

function decodeEntities(s = "") {
  return (
    String(s)
      // WordPressの二重エンコード(&amp;#8230; など)を先に戻す
      .replace(/&amp;/g, "&")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
      .replace(/&nbsp;/g, " ")
      .replace(/&hellip;/g, "…")
      .replace(/&(?:ldquo|rdquo|quot);/g, '"')
      .replace(/&(?:lsquo|rsquo|apos);/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  );
}

function codePoint(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : " ";
  } catch {
    return " ";
  }
}

function stripHtml(s = "") {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** WordPress系フィード末尾の定型句などを除去。 */
function cleanText(s) {
  return stripHtml(s)
    .replace(/\s*The post\b.*$/i, "")
    .replace(/\s*(Read more|続きを読む|関連記事)\b.*$/i, "")
    .replace(/\s*\[[^\]]*\]$/, "")
    .trim();
}

/** カード用の短い要約。 */
function summarize(item) {
  const raw = item.contentSnippet || item.summary || item.content || item["content:encoded"] || "";
  const text = cleanText(raw);
  if (text.length <= SUMMARY_MAX) return text;
  return text.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, "") + "…";
}

/**
 * コラム生成用の本文(RSSに全文が入っている場合のみ)。
 * クライアント配信用JSONからは除外され、build時のみ使われる。
 */
function fullBody(item) {
  const raw = item["content:encoded"] || item.content || "";
  const text = cleanText(raw);
  return text.length > 200 ? text.slice(0, BODY_MAX) : "";
}

function haystack(item) {
  return `${item.title || ""} ${item.contentSnippet || ""} ${
    Array.isArray(item.categories) ? item.categories.join(" ") : item.categories || ""
  }`.toLowerCase();
}

/** グラビア等の除外ワードを含むか。 */
function isExcluded(item) {
  const hay = haystack(item);
  return EXCLUDE.some((k) => hay.includes(k.toLowerCase()));
}

/**
 * アイドル/アーティスト関連キーワードを含むか。
 * カテゴリ(categories)は配信元によって過剰に付与される(例: Danmee は K-ドラマ記事にも
 * アイドル系タグが付く)ので、判定はタイトルと要約本文のみで行う。
 */
function isRelevant(item) {
  const hay = `${item.title || ""} ${item.contentSnippet || ""}`.toLowerCase();
  return KEYWORDS.some((k) => hay.includes(k.toLowerCase()));
}

/** フィードの mode に応じて記事を残すか判定する。 */
function keepItem(item, feed) {
  if (isExcluded(item)) return false;
  if (feed.mode === "strict") return isRelevant(item);
  return true; // loose: 除外ワードに当たらなければ通す
}

function toArticle(item, feed) {
  const link = (item.link || item.guid || "").trim();
  if (!link) return null;
  const dateStr = item.isoDate || item.pubDate || null;
  const date = dateStr ? new Date(dateStr) : new Date();
  const title = stripHtml(item.title || "(無題)");
  const summary = summarize(item);
  const body = fullBody(item);
  return {
    id: hash(link),
    title,
    link,
    summary,
    ...(body ? { body } : {}),
    source: feed.name,
    region: feed.region,
    groups: groupsFor(`${title} ${summary}`),
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
      const raw = parsed.items || [];
      const items = raw
        .filter((it) => keepItem(it, feed))
        .map((it) => toArticle(it, feed))
        .filter(Boolean);
      collected.push(...items);
      console.log(`OK   ${feed.name}: ${items.length} / ${raw.length} 件`);
    } catch (err) {
      console.warn(`SKIP ${feed.name}: ${err.message}`);
    }
  }

  const byId = new Map();
  for (const a of [...loadExisting(), ...collected]) byId.set(a.id, a);

  // 除外ワードのルールを更新したら、過去に取り込んだ記事も遡って除外する
  const excludedNow = (a) => {
    const hay = `${a.title || ""} ${a.summary || ""}`.toLowerCase();
    return EXCLUDE.some((k) => hay.includes(k.toLowerCase()));
  };

  // 現在 strict のフィード名。過去に緩い判定で取り込んだ記事も、いまの基準で無関係なら落とす。
  const strictSources = new Set(active.filter((f) => f.mode === "strict").map((f) => f.name));
  const staleStrict = (a) => {
    if (!strictSources.has(a.source)) return false;
    const hay = `${a.title || ""} ${a.summary || ""}`.toLowerCase();
    return !KEYWORDS.some((k) => hay.includes(k.toLowerCase()));
  };

  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const merged = [...byId.values()]
    .filter((a) => !excludedNow(a))
    .filter((a) => !staleStrict(a))
    .filter((a) => new Date(a.date).getTime() >= cutoff)
    // グループ辞書の更新を過去記事にも反映(常に付け直す)
    .map((a) => ({ ...a, groups: groupsFor(`${a.title || ""} ${a.summary || ""}`) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS);

  await translateArticles(merged);

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
