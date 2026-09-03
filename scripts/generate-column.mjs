/**
 * 「今日のコラム」を1日 最大 COLUMN_COUNT 本(既定4)生成する。ネタが足りなければ本数は減る。
 * コラムには2種類ある:
 *   - group … 特定グループを深掘りする狭めのコラム(従来どおり)
 *   - broad … 「新人」「ライブ動員」「チャート」等のテーマで複数グループを横断比較する広めのコラム
 * 目標は group 2本 + broad 2本。broad が足りない日は group で埋めて常に最大 COLUMN_COUNT 本にする。
 *
 *  1. articles.json から「今日(JST)の 00:00〜現在」の記事を取り出す(少なすぎる時だけ直近48hに拡大)。
 *     broad 用には直近 BROAD_WINDOW_DAYS 日(既定7)ぶんを別途プールする。
 *  2. group: グループタグでクラスタ化し、報道量(件数・媒体数・日韓横断)でトピックをスコア順に並べる。
 *  3. broad: テーマ辞書(BROAD_THEMES)をキーワードで記事にあて、記事数・媒体数・関与グループ数でスコア化。
 *     上位候補と関連見出しを AI(編集者役)に渡し、横断比較で面白いテーマを注目点(angle)つきで選ばせる。
 *  4. トピック/テーマごとに参考記事の本文を用意し、日韓エンタメに詳しいコラムニストの立場で、
 *     事実(出典番号つき)と見解を分けたコラムを AI に書かせる(1トピック=1本)。
 *  5. 出典リンク・kind(group|broad)付きで src/_data/columns.json に追記(slug: 今日=YYYY-MM-DD、2本目以降は -2, -3 …)。
 *
 * API キーが無い / 対象記事が無い / 今日ぶんが既に COLUMN_COUNT 本ある 場合は何もせず正常終了。
 * 予期しない失敗でもニュース側のデプロイを止めないよう、常に exit 0。
 * 環境変数: OPENAI_API_KEY か GEMINI_API_KEY(どちらか必須), OPENAI_MODEL / GEMINI_MODEL(任意),
 *           COLUMN_COUNT(1日の本数。既定4), COLUMN_BROAD_COUNT(広めの目標本数。既定2),
 *           COLUMN_FORCE=1(今日ぶんを作り直す), COLUMN_DRY_RUN=1(API未使用でトピックとプロンプトを表示)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "@extractus/article-extractor";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTICLES_FILE = path.join(ROOT, "src", "_data", "articles.json");
const COLUMNS_FILE = path.join(ROOT, "src", "_data", "columns.json");

// OpenAI のキーがあればそちらを優先(有料アカウントで安定)。無ければ Gemini(無料)。
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const API_KEY = process.env.GEMINI_API_KEY || "";
// GEMINI_MODEL を指定すればそれを最優先。指定が無ければ以下を順に試す。
// (Google は旧モデルを予告なく新規利用不可にするため複数フォールバックを持つ)
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite"
].filter(Boolean);
const FORCE = process.env.COLUMN_FORCE === "1";
const DRY_RUN = process.env.COLUMN_DRY_RUN === "1";

const COLUMN_COUNT = Number(process.env.COLUMN_COUNT || 4); // 1日に作る最大本数(ネタが無ければ減る)
const BROAD_COUNT = Number(process.env.COLUMN_BROAD_COUNT || 2); // うち「広め(broad)」の目標本数
const FALLBACK_HOURS = 48;           // 今日ぶんが少なすぎる時だけ、この時間まで広げる
const MIN_POOL = 20;                 // これ未満なら FALLBACK_HOURS に拡大
const MAX_ARTICLES_PER_CLUSTER = 7;  // 1トピックあたりの参考記事数(当日分)
const MIN_CLUSTER_SIZE = 2;          // これ未満のクラスタは無視
const MAX_EXTRACT_FETCHES = 30;      // 記事ページ抽出の最大回数(礼儀)
const SOURCE_TEXT_MAX = 1200;        // 当日記事: AI に渡す本文の最大文字数
const BG_TEXT_MAX = 500;             // 背景記事: 同上(短め)
const MAX_BACKGROUND = 5;            // 1トピックにつき付ける背景(過去)記事の最大数
const BACKGROUND_DAYS = 90;          // 背景記事としてさかのぼる日数
const KEEP_COLUMNS = 120;
const AVOID_RECENT_TOPICS = 6;       // 直近N本と同じトピック/テーマは避ける

// --- 広め(broad)コラム用 ---
const BROAD_WINDOW_DAYS = 7;         // 広めコラムが参照する記事の期間(直近N日)
const BROAD_MAX_ARTICLES = 14;       // 1本の広めコラムに渡す記事の最大数
const BROAD_MIN_ARTICLES = 5;        // このテーマを候補にするのに必要な最小記事数
const BROAD_MIN_GROUPS = 3;          // 「横断」といえる最小グループ数(タグ付き記事ベース)
const BROAD_CANDIDATES = 4;          // AI に最終選択させる候補テーマ数
const BROAD_TEXT_MAX = 850;          // 広めコラム: AI に渡す1記事の本文の最大文字数
const BROAD_DIGEST_ARTICLES = 8;     // 候補選択プロンプトでテーマごとに見せる見出し数

/**
 * テーマ辞書。kw のいずれかが記事の「見出し(title / title_ja)」に含まれればそのテーマに該当。
 * 本文ではなく見出しだけを見るのは、誤検出(映画紹介中の「ライブシーン」等)を避けるため。
 * ここを編集すれば広めコラムのテーマを増減できる。kw は大小文字を区別しない。
 */
const BROAD_THEMES = [
  {
    slug: "rookie",
    name: "新人・新グループ",
    kw: ["デビュー", "新グループ", "新ボーイズグループ", "新ガールズグループ", "プレデビュー",
         "お披露目", "初シングル", "1stシングル", "ファーストシングル", "デビュー曲",
         "デビューシングル", "デビュー決定", "結成", "新人グループ", "サバイバル番組"]
  },
  {
    slug: "live",
    name: "ライブ・動員・ツアー",
    kw: ["ツアー", "公演", "動員", "アリーナ", "ドーム", "スタジアム", "単独ライブ", "ワンマン",
         "ライブビューイング", "セットリスト", "セトリ", "ファンミーティング", "ファンミ",
         "完売", "追加公演", "武道館", "スーパーアリーナ", "東京ドーム", "京セラドーム"]
  },
  {
    slug: "chart",
    name: "チャート・セールス",
    kw: ["オリコン", "ビルボード", "Billboard", "チャート", "初週", "初動", "売上", "万枚",
         "ミリオン", "1位", "首位", "ランクイン", "セールス", "デイリー1位", "週間1位", "1位獲得"]
  },
  {
    slug: "lineup",
    name: "卒業・脱退・体制変更",
    kw: ["卒業", "脱退", "契約解除", "契約満了", "活動休止", "移籍", "解散", "ラストシングル",
         "新体制", "メンバー追加", "加入", "改名", "活動再開", "電撃移籍", "グループ卒業"]
  },
  {
    slug: "global",
    name: "海外進出・ワールド展開",
    kw: ["ワールドツアー", "北米", "南米ツアー", "ヨーロッパツアー", "欧州ツアー", "全米",
         "海外進出", "グローバルデビュー", "英語詞", "英語曲", "海外デビュー", "コーチェラ",
         "海外フェス", "米ビルボード", "海外公演", "アジアツアー"]
  },
  {
    slug: "award",
    name: "賞レース・音楽授賞式",
    kw: ["受賞", "大賞", "アワード", "授賞式", "レコード大賞", "MAMA", "MMA", "ノミネート",
         "新人賞", "レコ大", "紅白", "音楽祭", "最優秀"]
  },
  {
    slug: "tieup",
    name: "タイアップ・コラボ",
    kw: ["タイアップ", "コラボ", "主題歌", "テーマソング", "CMソング", "CM出演", "アンバサダー",
         "楽曲提供", "コラボレーション", "イメージソング", "オープニングテーマ", "エンディングテーマ",
         "CM起用", "アンバサダー就任"]
  },
  {
    slug: "media",
    name: "冠番組・メディア展開",
    kw: ["冠番組", "レギュラー番組", "MC就任", "レギュラー決定", "初主演", "ドラマ出演",
         "映画出演", "ドキュメンタリー", "リアリティ番組", "密着", "初冠番組", "レギュラー出演決定"]
  }
];

const log = (...a) => console.log(...a);

/** HTML除去 + 主要な実体参照のデコード + 空白整形。 */
function cleanPlain(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCp(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&(?:ldquo|rdquo|quot);/g, '"')
    .replace(/&(?:lsquo|rsquo|apos);/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function safeCp(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : " ";
  } catch {
    return " ";
  }
}

/** JST(UTC+9) の YYYY-MM-DD */
function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 「今日(JST)から daysAgo 日前」の 00:00 JST を表す UNIX ミリ秒。 */
function jstMidnight(daysAgo) {
  const j = new Date(Date.now() + 9 * 3600 * 1000);
  const wall = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - daysAgo);
  return wall - 9 * 3600 * 1000;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** グループタグで記事をクラスタ化し、報道量スコア順に返す。 */
function buildClusters(articles) {
  const map = new Map(); // slug -> { name, slug, items:[] }
  for (const a of articles) {
    for (const g of a.groups || []) {
      if (!map.has(g.slug)) map.set(g.slug, { name: g.name, slug: g.slug, items: [] });
      map.get(g.slug).items.push(a);
    }
  }
  const clusters = [];
  for (const c of map.values()) {
    if (c.items.length < MIN_CLUSTER_SIZE) continue;
    const sources = new Set(c.items.map((x) => x.source));
    const regions = new Set(c.items.map((x) => x.region));
    c.score =
      c.items.length + sources.size * 0.5 + (regions.size > 1 ? 2 : 0);
    c.items.sort((x, y) => new Date(y.date) - new Date(x.date));
    clusters.push(c);
  }
  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}

/** タイムアウト付きで記事本文を抽出。失敗時 "" */
async function extractBody(url) {
  try {
    const art = await Promise.race([
      extract(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000))
    ]);
    const text = cleanPlain(art?.content || "");
    return text.length > 200 ? text : "";
  } catch {
    return "";
  }
}

/** 1記事の本文テキストを用意する。短ければ実ページから抽出して補う。 */
async function textFor(a, { maxLen, allowFetch, fetchState }) {
  let text = (a.body || "").trim();
  if (text.length < 400 && allowFetch && fetchState.n < MAX_EXTRACT_FETCHES) {
    fetchState.n += 1;
    const ex = await extractBody(a.link);
    if (ex) text = ex;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!text) text = a.summary || a.title;
  return String(text).slice(0, maxLen);
}

/**
 * 1トピック分のソースを、通し番号つきのフラット配列で返す。
 *  - kind:"today"      … 当日ウィンドウの記事。事実の主たる根拠。短い本文はページ抽出で補う。
 *  - kind:"background" … 同一グループの過去記事(直近 BACKGROUND_DAYS 日 / 最大 MAX_BACKGROUND 本)。
 *                        経緯・文脈の把握用。保存済みの本文/要約のみ使い、ページ抽出はしない。
 */
async function prepareSources(cluster, allArticles, dayStartMs) {
  const fetchState = { n: 0 };
  const out = [];
  let n = 0;

  const todayItems = cluster.items.slice(0, MAX_ARTICLES_PER_CLUSTER);
  const todayIds = new Set(todayItems.map((a) => a.id));
  for (const a of todayItems) {
    n += 1;
    out.push({
      n,
      kind: "today",
      cluster: cluster.name,
      title: a.title_ja || a.title,
      source: a.source,
      url: a.link,
      date: (a.date || "").slice(0, 10),
      text: await textFor(a, { maxLen: SOURCE_TEXT_MAX, allowFetch: true, fetchState })
    });
  }

  const bgCutoff = Date.now() - BACKGROUND_DAYS * 864e5;
  const background = (allArticles || [])
    .filter((a) => !todayIds.has(a.id))
    .filter((a) => (a.groups || []).some((g) => g.slug === cluster.slug))
    .filter((a) => {
      const t = new Date(a.date).getTime();
      return Number.isFinite(t) && t < dayStartMs && t >= bgCutoff;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_BACKGROUND);

  for (const a of background) {
    n += 1;
    out.push({
      n,
      kind: "background",
      cluster: cluster.name,
      title: a.title_ja || a.title,
      source: a.source,
      url: a.link,
      date: (a.date || "").slice(0, 10),
      text: await textFor(a, { maxLen: BG_TEXT_MAX, allowFetch: false, fetchState })
    });
  }

  return out;
}

function buildPrompt(topicName, sources, todayStr) {
  const fmt = (s) =>
    `【${s.n}】[配信 ${s.date || "不明"}] (${s.source}) ${s.title}\n${s.text}`;
  const todayList = sources.filter((s) => s.kind !== "background").map(fmt).join("\n\n");
  const bg = sources.filter((s) => s.kind === "background");
  const bgList = bg.length ? bg.map(fmt).join("\n\n") : "(なし)";
  return `あなたは、日本と韓国のポップカルチャーとアイドルシーンを長年取材してきたコラムニストだ。
署名コラムとして「${topicName}」をめぐる最新の動きを取り上げ、その背景と意味を読者にかみ砕いて伝える。
本日の日付は ${todayStr}。各記事には配信日を [配信 YYYY-MM-DD] で示している。

# 本日の参考記事(事実の根拠はここから取る)
${todayList}

# 背景記事(経緯・文脈の把握に使う。古い情報なので最新の状況と混同しない)
${bgList}

# 書き方
- topic は "${topicName}" とする。
- 本文は日本語・markdown で 900〜1400 文字。文体は「である・だ」調（常体）で統一する。「です・ます」調は使わない。
- 構成の目安: (1) 本日何が起きたか (2) これまでの経緯・文脈 (3) コラムニストとしての見立て・意味づけ (4) 結び。段落は2〜4個。
- 事実（出来事・発言・数値・日程）は「本日の参考記事」または「背景記事」に明記されたものだけを書き、その文末に根拠の番号を [1] [2] のように付ける。
- 「見立て」「意味づけ」は書いてよいが、筆者の解釈だと分かる書き方にする（「〜と位置づけられる」「〜と見るのが自然だろう」等）。解釈だけの文には出典番号を付けない。
- 未発表の予定、出るか分からない数字、関係者の内心、確認できない噂は書かない。参考記事に無い固有名詞・西暦は補わない。年月日が不明なものは「今年」「先日」「来月」のように相対表現にする。
- 直接引用は1文以内・「」でくくる。原文をそのまま長く写さない。
- 断定的な煽り・誇張は避ける。見出し(title)は40文字以内、dek はリード1〜2文。いずれも「である」調にする。
- 出力は指定のJSONのみ。`;
}

/** ```json フェンスや前後の余分な文字を取り除いてから JSON.parse する。 */
function parseJsonLoose(text) {
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const REQUIRED_KEYS = ["topic", "title", "dek", "body_md", "used_sources"];

// llmJson に渡すシステムメッセージ。用途で使い分ける。
const COLUMNIST_SYSTEM =
  "あなたは日本と韓国のポップカルチャー/アイドルシーンを長年取材してきたコラムニスト。指示に厳密に従い、事実と見解を分けて書き、JSONオブジェクトだけを返す。";
const EDITOR_SYSTEM =
  "あなたは日韓ポップカルチャーを扱うウェブメディアのコラム編集者。与えられた候補と記事だけを根拠に判断し、指定されたJSONオブジェクトだけを返す。";

function jsonFormatHint(bodyRange = "900〜1400字") {
  return `\n\n出力は次のキーだけを持つJSONオブジェクトを1つ、他の文字なしで返す:
{"topic": "選んだトピック名", "title": "見出し(40字以内)", "dek": "リード1〜2文",
 "body_md": "本文(markdown, ${bodyRange}, 事実の文末に [1] のような出典番号)", "used_sources": [使った番号の配列]}`;
}

/** OpenAI Chat Completions (JSONモード)。system は呼び出し側が指定する。 */
async function callOpenAI(prompt, system) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("OpenAI: 空のレスポンス");
  return { result: parseJsonLoose(text), model: `openai:${OPENAI_MODEL}` };
}

async function callGeminiModel(model, prompt, system) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      // 思考型モデルが出力枠を思考で使い切って本文が切れるのを防ぐ
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  const finish = cand?.finishReason || data?.promptFeedback?.blockReason || "不明";
  if (!text) {
    throw new Error(`Gemini: 本文なし (finishReason=${finish}) ${JSON.stringify(data).slice(0, 400)}`);
  }
  try {
    return { result: parseJsonLoose(text), model };
  } catch (e) {
    throw new Error(`Gemini JSONパース失敗 (finishReason=${finish}, ${text.length}字): ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * モデル候補を順に試す。
 *  - 403(権限/キー不正)  → 即中断
 *  - 429/500/503(一時的) → 同じモデルを指数バックオフで最大3回リトライ、ダメなら次の候補へ
 *  - それ以外(404/400/JSON失敗など) → 次の候補へ
 */
async function callGemini(prompt, system) {
  let lastErr;
  for (const model of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await callGeminiModel(model, prompt, system);
        if (model !== MODEL_CANDIDATES[0]) log(`  (フォールバックモデル ${model} を使用)`);
        return out;
      } catch (e) {
        lastErr = e;
        const status = (e.message.match(/HTTP (\d+)/) || [])[1];
        if (status === "403") throw e;
        if (["429", "500", "503"].includes(status) && attempt < 3) {
          const wait = 4000 * attempt;
          log(`  ${model}: 一時エラー HTTP ${status} → ${wait / 1000}s 後に再試行 (${attempt}/3)`);
          await sleep(wait);
          continue;
        }
        log(`  ${model}: 失敗(${e.message.slice(0, 110)}) → 次の候補へ`);
        break;
      }
    }
  }
  throw lastErr;
}

/** OpenAIキーがあればそれを優先、失敗時 or 無ければ Gemini。JSONオブジェクトを返す共通関数。 */
async function llmJson(prompt, system = COLUMNIST_SYSTEM) {
  if (OPENAI_KEY) {
    try {
      return await callOpenAI(prompt, system);
    } catch (e) {
      log(`OpenAI失敗(${e.message.slice(0, 140)}) → Geminiにフォールバック`);
    }
  }
  return await callGemini(prompt, system);
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * テーマ辞書を pool の記事にあて、候補テーマをスコア順で返す。
 * kw のいずれかが 見出し/日本語見出し/要約/本文 に含まれれば該当。
 * 記事数 < BROAD_MIN_ARTICLES または 関与グループ数 < BROAD_MIN_GROUPS のテーマは落とす。
 */
function matchThemes(pool) {
  const out = [];
  for (const th of BROAD_THEMES) {
    const rx = new RegExp(th.kw.map(escapeRegex).join("|"), "i");
    const hit = pool.filter((a) => rx.test(`${a.title || ""} ${a.title_ja || ""}`));
    if (hit.length < BROAD_MIN_ARTICLES) continue;
    // グループタグの付いた記事だけを「横断」の根拠にする(比較対象がはっきりするもの)。
    const tagged = hit.filter((a) => (a.groups || []).length > 0);
    const groupSlugs = new Set();
    for (const a of tagged) for (const g of a.groups || []) groupSlugs.add(g.slug);
    if (groupSlugs.size < BROAD_MIN_GROUPS) continue;
    // タグ付き記事を先、その中で新しい順。素材としてタグ付きを優先的に使う。
    const items = hit.slice().sort((a, b) => {
      const at = (a.groups || []).length > 0 ? 0 : 1;
      const bt = (b.groups || []).length > 0 ? 0 : 1;
      return at - bt || new Date(b.date) - new Date(a.date);
    });
    const sources = new Set(items.map((a) => a.source));
    const regions = new Set(tagged.map((a) => a.region));
    const score =
      tagged.length + sources.size * 0.5 + groupSlugs.size * 0.8 + (regions.size > 1 ? 2 : 0);
    out.push({ ...th, items, score, groupCount: groupSlugs.size, taggedCount: tagged.length });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 候補選択プロンプトに載せる、テーマごとの見出しダイジェスト。 */
function buildBroadDigest(candidates) {
  return candidates
    .map((th) => {
      const lines = th.items.slice(0, BROAD_DIGEST_ARTICLES).map((a) => {
        const gs = (a.groups || []).map((g) => g.name).slice(0, 3).join("・") || "-";
        return `  - [配信 ${(a.date || "").slice(0, 10)}] (${a.source} / ${gs}) ${a.title_ja || a.title}`;
      });
      return `## ${th.slug} — ${th.name}(グループ紐付き ${th.taggedCount} 件 / ${th.groupCount} グループ、関連記事 計 ${th.items.length} 件)\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** 候補テーマから、横断比較で面白いものを want 件、注目点(angle)つきで AI に選ばせる。 */
async function selectBroadThemes(candidates, want, todayStr) {
  const prompt = `本日の日付は ${todayStr}。以下は「広め(横断)コラム」の候補テーマと、直近1週間の関連記事の一覧である。

${buildBroadDigest(candidates)}

# 指示
- 読者にとって興味深く、複数のグループ／アーティストを横断して比較・考察できるテーマを ${want} つ選ぶ。
- 1つのグループの話題に偏るテーマや、記事が薄いテーマは避ける。互いにできるだけ異なる切り口にする。
- 各テーマに、どこに注目して書くと面白いかを1文で添える(固有名詞や数字は断定せず、方向性だけ)。
- 出力は次のJSONオブジェクトだけを返す:
{"picks": [{"slug": "候補のslug", "angle": "注目点を1文で"}]}`;
  const { result } = await llmJson(prompt, EDITOR_SYSTEM);
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const picks = [];
  for (const p of result?.picks || []) {
    const th = bySlug.get(String(p?.slug || "").trim());
    if (th && !picks.some((x) => x.theme.slug === th.slug)) {
      picks.push({ theme: th, angle: String(p?.angle || "").trim() });
    }
    if (picks.length >= want) break;
  }
  return picks;
}

/** 広めコラム1本ぶんの参考記事を、通し番号つきのフラット配列で返す。 */
async function prepareBroadSources(theme) {
  const fetchState = { n: 0 };
  const items = theme.items.slice(0, BROAD_MAX_ARTICLES);
  const out = [];
  let n = 0;
  for (const a of items) {
    n += 1;
    out.push({
      n,
      title: a.title_ja || a.title,
      source: a.source,
      url: a.link,
      date: (a.date || "").slice(0, 10),
      group: (a.groups || []).map((g) => g.name).slice(0, 3).join("・"),
      text: await textFor(a, { maxLen: BROAD_TEXT_MAX, allowFetch: true, fetchState })
    });
  }
  return out;
}

function buildBroadPrompt(theme, angle, sources, todayStr) {
  const list = sources
    .map(
      (s) =>
        `【${s.n}】[配信 ${s.date || "不明"}] (${s.source}${s.group ? " / " + s.group : ""}) ${s.title}\n${s.text}`
    )
    .join("\n\n");
  return `あなたは、日本と韓国のポップカルチャーとアイドルシーンを長年取材してきたコラムニストだ。
今回は特定のグループの深掘りではなく、「${theme.name}」というテーマで最近の複数の動きを横断的に取り上げ、比較しながらその意味を読み解く署名コラムを書く。
本日の日付は ${todayStr}。参照するのは直近1週間ぶんの記事で、各記事には配信日 [配信 YYYY-MM-DD] と関連グループ名を示している。
${angle ? `編集部の注目点: ${angle}\n` : ""}
# 参考記事(事実の根拠はここから取る)
${list}

# 書き方
- topic は "${theme.name}" とする。
- 本文は日本語・markdown で 1000〜1600 文字。文体は「である・だ」調(常体)で統一する。「です・ます」調は使わない。
- 構成の目安: (1) いま何が起きているか(具体的な事例を2つ以上挙げる) (2) それぞれの規模や経緯の違い (3) 横断して見えてくる傾向とコラムニストとしての見立て (4) 結び。段落は3〜5個。
- 事実(出来事・発言・数値・日程)は参考記事に明記されたものだけを書き、その文末に根拠の番号を [1] [2] のように付ける。複数の対象を比べるときは、それぞれの事実に対応する番号を付ける。
- 片方にしか出典が無い比較(順位付け・優劣の断定・「最も」等)は書かない。参考記事に無い固有名詞・西暦・数値は補わない。日付が不明なものは「今週」「先日」「来月」のように相対表現にする。
- 「見立て」「意味づけ」は書いてよいが、筆者の解釈だと分かる書き方にする(「〜と位置づけられる」「〜と見るのが自然だろう」等)。解釈だけの文には出典番号を付けない。
- 未発表の予定、確認できない噂、関係者の内心は書かない。直接引用は1文以内・「」でくくる。
- 断定的な煽り・誇張は避ける。見出し(title)は40文字以内、dek はリード1〜2文。いずれも「である」調にする。
- 出力は指定のJSONのみ。`;
}

async function main() {
  const provider = OPENAI_KEY
    ? `OpenAI(${OPENAI_MODEL})` + (API_KEY ? " → Geminiフォールバック" : "")
    : `Gemini[${MODEL_CANDIDATES.join(", ")}]`;
  log(
    `[column] provider=${provider} ` +
      `openaiKey=${OPENAI_KEY ? "あり" : "なし"} geminiKey=${API_KEY ? API_KEY.length + "文字" : "なし"} ` +
      `force=${FORCE} dryRun=${DRY_RUN}`
  );
  if (!API_KEY && !OPENAI_KEY && !DRY_RUN) {
    log("SKIP: GEMINI_API_KEY も OPENAI_API_KEY も未設定のためコラム生成をスキップします。");
    return;
  }

  const articles = readJson(ARTICLES_FILE, []);
  let columns = readJson(COLUMNS_FILE, []);
  const today = jstDate();

  // 既存の今日ぶんを kind 別に数える。FORCE のときは今日ぶんを消して作り直す。
  const todaysExisting = columns.filter((c) => c.date === today);
  if (FORCE) columns = columns.filter((c) => c.date !== today);
  const kindOf = (c) => (c.kind === "broad" ? "broad" : "group");
  const haveBroad = FORCE ? 0 : todaysExisting.filter((c) => kindOf(c) === "broad").length;
  const haveGroup = FORCE ? 0 : todaysExisting.filter((c) => kindOf(c) === "group").length;
  const haveTotal = haveBroad + haveGroup;
  const totalNeed = COLUMN_COUNT - haveTotal;
  log(
    `[column] articles=${articles.length} columns=${columns.length} today(JST)=${today} ` +
      `既存(今日)=${haveTotal}(group ${haveGroup} / broad ${haveBroad}) ` +
      `目標=${COLUMN_COUNT}(broad ${BROAD_COUNT}) 追加予定=${Math.max(totalNeed, 0)}`
  );
  if (totalNeed <= 0 && !DRY_RUN) {
    log(`SKIP: 本日(${today})のコラムは既に ${haveTotal} 本あります。COLUMN_FORCE=1 で作り直せます。`);
    return;
  }

  // --- group 用: 「今日(JST)の 00:00〜現在」を対象に。少なすぎる時だけ48hに拡大。 ---
  const dayStart = jstMidnight(0);
  const dayEnd = jstMidnight(-1);
  const inToday = (a) => {
    const t = new Date(a.date).getTime();
    return t >= dayStart && t < dayEnd;
  };
  let recent = articles.filter(inToday);
  let windowLabel = `今日 ${today} (JST)`;
  if (recent.length < MIN_POOL) {
    recent = articles.filter((a) => new Date(a.date).getTime() >= Date.now() - FALLBACK_HOURS * 3600 * 1000);
    windowLabel = `直近 ${FALLBACK_HOURS}h (今日ぶんが ${MIN_POOL} 件未満のため拡大)`;
  }
  log(`group 対象記事: ${recent.length} 件 / ${windowLabel}`);

  // 避けるトピック = 直近N本 + 今日すでに書いたもの(FORCE時は後者なし)
  const avoidGroup = new Set(
    [...columns.slice(0, AVOID_RECENT_TOPICS).map((c) => c.topic), ...todaysExisting.map((c) => c.topic)]
      .filter(Boolean)
      .map(normName)
  );
  const allClusters = buildClusters(recent).filter((c) => !avoidGroup.has(normName(c.name)));

  // --- broad 用: 直近 BROAD_WINDOW_DAYS 日ぶんをプールし、テーマ辞書をあてる ---
  const broadCutoff = Date.now() - BROAD_WINDOW_DAYS * 864e5;
  const broadPool = articles.filter((a) => {
    const t = new Date(a.date).getTime();
    return Number.isFinite(t) && t >= broadCutoff;
  });
  const avoidBroad = new Set(
    [
      ...columns.slice(0, AVOID_RECENT_TOPICS).filter((c) => kindOf(c) === "broad").map((c) => c.topic),
      ...todaysExisting.filter((c) => kindOf(c) === "broad").map((c) => c.topic)
    ]
      .filter(Boolean)
      .map(normName)
  );
  const broadCandidates = matchThemes(broadPool)
    .filter((th) => !avoidBroad.has(normName(th.name)))
    .slice(0, BROAD_CANDIDATES);
  log(
    `broad 候補テーマ(${broadCandidates.length}) / プール ${broadPool.length}件: ` +
      (broadCandidates
        .map((t) => `${t.name}(タグ付${t.taggedCount}/${t.items.length}件・${t.groupCount}G/score ${t.score.toFixed(1)})`)
        .join(", ") || "なし")
  );

  if (DRY_RUN) {
    const wantBroadDry = Math.min(BROAD_COUNT, broadCandidates.length);
    if (broadCandidates.length) {
      log(`\n===== DRY RUN: broad テーマ選択プロンプト (${wantBroadDry}件選ばせる) =====\n`);
      log(`本日の日付は ${today}。\n\n${buildBroadDigest(broadCandidates)}`);
      for (const th of broadCandidates.slice(0, Math.max(wantBroadDry, 1))) {
        const bsrc = await prepareBroadSources(th);
        log(`\n===== DRY RUN: broad「${th.name}」の本文プロンプト (記事 ${bsrc.length}本) =====\n`);
        log(buildBroadPrompt(th, "(AIが選ぶ注目点)", bsrc, today) + jsonFormatHint("1000〜1600字"));
      }
    }
    for (const c of allClusters.slice(0, Math.max(COLUMN_COUNT - BROAD_COUNT, 1))) {
      const src = await prepareSources(c, articles, dayStart);
      const bgN = src.filter((s) => s.kind === "background").length;
      log(`\n===== DRY RUN: group「${c.name}」のプロンプト (当日 ${src.length - bgN}本 / 背景 ${bgN}本) =====\n`);
      log(buildPrompt(c.name, src, today) + jsonFormatHint());
    }
    return;
  }

  const usedSlugs = new Set(columns.filter((c) => c.date === today).map((c) => c.slug));
  const nextSlug = () => {
    let n = usedSlugs.size + 1;
    let s = n === 1 ? today : `${today}-${n}`;
    while (usedSlugs.has(s)) {
      n += 1;
      s = `${today}-${n}`;
    }
    usedSlugs.add(s);
    return s;
  };

  /** LLM 結果を columns.json のレコードに整える。title/body が無ければ null。 */
  const toRecord = ({ result, usedModel, src, regionItems, topic, kind }) => {
    const body = String(result.body_md || "").trim();
    const title = String(result.title || "").trim();
    if (!body || !title) return null;
    const cited = new Set([
      ...(result.used_sources || []),
      ...[...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    ]);
    const byN = new Map(src.map((s) => [s.n, s]));
    const usedSources = [...cited]
      .filter((x) => byN.has(x))
      .sort((a, b) => a - b)
      .map((x) => {
        const s = byN.get(x);
        return { n: x, title: s.title, source: s.source, url: s.url };
      });
    const rc = { jp: 0, kr: 0 };
    for (const a of regionItems) if (rc[a.region] !== undefined) rc[a.region] += 1;
    return {
      date: today,
      slug: nextSlug(),
      kind,
      topic,
      region: rc.kr > rc.jp ? "kr" : "jp",
      title,
      dek: String(result.dek || "").trim(),
      body_md: body,
      sources: usedSources,
      model: usedModel,
      generated_at: new Date().toISOString()
    };
  };

  const madeGroup = [];
  const madeBroad = [];

  const makeGroupColumn = async (cluster, tag = "group") => {
    const src = await prepareSources(cluster, articles, dayStart);
    const bgN = src.filter((s) => s.kind === "background").length;
    if (bgN) log(`  ${tag} ${cluster.name}: 背景記事 ${bgN} 本を追加`);
    let result, usedModel;
    try {
      ({ result, model: usedModel } = await llmJson(
        buildPrompt(cluster.name, src, today) + jsonFormatHint(),
        COLUMNIST_SYSTEM
      ));
    } catch (e) {
      log(`  ${tag} ${cluster.name}: 生成失敗 ${e.message}`);
      return null;
    }
    const rec = toRecord({
      result,
      usedModel,
      src,
      regionItems: cluster.items,
      topic: cluster.name,
      kind: "group"
    });
    if (!rec) {
      log(`  ${tag} ${cluster.name}: 生成結果が不十分(title/body欠落)`);
      return null;
    }
    log(`  OK[${tag}]: ${rec.title} [${rec.slug}] (出典 ${rec.sources.length}件)`);
    return rec;
  };

  // 1) broad テーマを AI に選ばせる(候補があり、broad の枠が残っている場合)
  let wantBroad = Math.max(0, Math.min(BROAD_COUNT - haveBroad, totalNeed));
  wantBroad = Math.min(wantBroad, broadCandidates.length);
  let picks = [];
  if (wantBroad > 0) {
    try {
      picks = await selectBroadThemes(broadCandidates, wantBroad, today);
      log(`broad 選択: ${picks.map((p) => p.theme.name).join(", ") || "(AIが選ばず)"}`);
    } catch (e) {
      log(`broad テーマ選択に失敗(${e.message.slice(0, 120)}) → 上位候補で代替`);
    }
    if (picks.length === 0) {
      picks = broadCandidates.slice(0, wantBroad).map((th) => ({ theme: th, angle: "" }));
    }
  }

  // 2) group を先に生成(通常の主役。slug が -1, -2 と若い番号になる)
  const groupTarget = Math.max(0, totalNeed - picks.length);
  const triedClusters = new Set();
  for (const cluster of allClusters.slice(0, groupTarget)) {
    triedClusters.add(cluster.name);
    const rec = await makeGroupColumn(cluster);
    if (rec) madeGroup.push(rec);
  }

  // 3) broad を生成
  for (const { theme, angle } of picks) {
    const src = await prepareBroadSources(theme);
    log(`  broad ${theme.name}: 参考記事 ${src.length} 本 / ${theme.groupCount} グループ`);
    let result, usedModel;
    try {
      ({ result, model: usedModel } = await llmJson(
        buildBroadPrompt(theme, angle, src, today) + jsonFormatHint("1000〜1600字"),
        COLUMNIST_SYSTEM
      ));
    } catch (e) {
      log(`  broad ${theme.name}: 生成失敗 ${e.message}`);
      continue;
    }
    const rec = toRecord({
      result,
      usedModel,
      src,
      regionItems: theme.items,
      topic: theme.name,
      kind: "broad"
    });
    if (!rec) {
      log(`  broad ${theme.name}: 生成結果が不十分(title/body欠落)`);
      continue;
    }
    madeBroad.push(rec);
    log(`  OK[broad]: ${rec.title} [${rec.slug}] (出典 ${rec.sources.length}件)`);
  }

  // 4) broad が目標に届かなければ group で埋める(常に最大 COLUMN_COUNT 本)
  const shortfall = totalNeed - (madeGroup.length + madeBroad.length);
  if (shortfall > 0) {
    const fill = allClusters.filter((c) => !triedClusters.has(c.name)).slice(0, shortfall);
    for (const cluster of fill) {
      const rec = await makeGroupColumn(cluster, "group補充");
      if (rec) madeGroup.push(rec);
    }
  }

  const made = [...madeGroup, ...madeBroad];
  if (made.length === 0) {
    log("ERROR: 生成できたコラムがありません。");
    return;
  }

  const next = [...made, ...columns].slice(0, KEEP_COLUMNS);
  fs.writeFileSync(COLUMNS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  log(
    `OK: コラムを ${made.length} 本生成 (group ${madeGroup.length} / broad ${madeBroad.length}、` +
      `今日 合計 ${haveTotal + made.length} 本)`
  );
}

/** 名前を大まかに正規化(小文字・空白除去)。 */
function normName(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "");
}

main()
  .catch((e) => {
    console.error("ERROR(想定外):", e);
  })
  .finally(() => process.exit(0));
