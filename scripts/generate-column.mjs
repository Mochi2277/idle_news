/**
 * 1日1本の「コラム」を生成する。
 *
 *  1. articles.json から「昨日(JST)」の記事を取り出す(少なすぎる時だけ直近48hに拡大)
 *  2. グループタグでクラスタ化し、報道量(件数・媒体数・日韓横断)でトピック候補を上位抽出
 *  3. 候補記事の本文を用意(RSSの content:encoded、無ければ記事ページから抽出)
 *  4. Gemini に「候補から1トピック選び、参考記事だけを根拠にコラムを書く」よう依頼
 *  5. 出典リンク付きで src/_data/columns.json に追記
 *
 * GEMINI_API_KEY が無い / 対象記事が無い / 当日分が既にある 場合は何もせず正常終了する。
 * 予期しない失敗でもニュース側のデプロイを止めないよう、常に exit 0。
 * 環境変数: GEMINI_API_KEY(必須), GEMINI_MODEL(任意。既定は gemini-flash-latest ほかを順に試行),
 *           COLUMN_FORCE=1(当日分があっても再生成), COLUMN_DRY_RUN=1(API未使用でクラスタ確認)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "@extractus/article-extractor";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTICLES_FILE = path.join(ROOT, "src", "_data", "articles.json");
const COLUMNS_FILE = path.join(ROOT, "src", "_data", "columns.json");

const API_KEY = process.env.GEMINI_API_KEY || "";
// GEMINI_MODEL を指定すればそれを最優先。指定が無ければ以下を順に試す。
// (Google は旧モデルを予告なく新規利用不可にするため複数フォールバックを持つ)
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-2.0-flash"
].filter(Boolean);
const FORCE = process.env.COLUMN_FORCE === "1";
const DRY_RUN = process.env.COLUMN_DRY_RUN === "1";

const FALLBACK_HOURS = 48;           // 昨日ぶんが少なすぎる時だけ、この時間まで広げる
const MIN_POOL = 20;                 // これ未満なら FALLBACK_HOURS に拡大
const MAX_CANDIDATE_CLUSTERS = 3;    // Gemini に見せるトピック候補数
const MAX_ARTICLES_PER_CLUSTER = 7;  // 1トピックあたりの参考記事数
const MIN_CLUSTER_SIZE = 2;          // これ未満のクラスタは無視
const MAX_EXTRACT_FETCHES = 24;      // 記事ページ抽出の最大回数(礼儀)
const SOURCE_TEXT_MAX = 1200;        // 1記事あたり Gemini に渡す本文の最大文字数
const KEEP_COLUMNS = 90;
const AVOID_RECENT_TOPICS = 4;       // 直近N本と同じトピックは避ける

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

/** 候補記事に本文を用意し、番号付きソース一覧を作る。 */
async function prepareSources(clusters) {
  let n = 0;
  let fetches = 0;
  const out = [];
  for (const c of clusters) {
    const picked = c.items.slice(0, MAX_ARTICLES_PER_CLUSTER);
    for (const a of picked) {
      n += 1;
      let text = (a.body || "").trim();
      if (text.length < 400 && fetches < MAX_EXTRACT_FETCHES) {
        fetches += 1;
        const ex = await extractBody(a.link);
        if (ex) text = ex;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!text) text = a.summary || a.title;
      out.push({
        n,
        cluster: c.name,
        title: a.title_ja || a.title,
        source: a.source,
        url: a.link,
        text: text.slice(0, SOURCE_TEXT_MAX)
      });
    }
  }
  return out;
}

function buildPrompt(candidateNames, sources) {
  const list = sources
    .map(
      (s) =>
        `【${s.n}】(${s.cluster} / ${s.source}) ${s.title}\n${s.text}`
    )
    .join("\n\n");
  return `あなたは日本と韓国のアイドルを専門に扱うニュースメディアの編集者です。
昨日1日の報道を振り返るコラムを1本執筆します。以下の「トピック候補」と「参考記事」だけを情報源にしてください。

# トピック候補
${candidateNames.map((x, i) => `${i + 1}. ${x}`).join("\n")}

# 参考記事
${list}

# 執筆ルール
- トピック候補の中から、最も報道量が多く読者の関心が高いと思われるものを1つ選ぶ。
- 本文は日本語で 500〜900 文字。
- 事実は参考記事に明記されている内容だけを書く。推測・憶測、参考記事に無い固有名詞や数字は書かない。
- 事実を述べた文の末尾に、根拠となる参考記事の番号を [1] [2] のように付ける。
- 直接引用は1文以内・「」でくくる。参考記事の文章をそのまま長く写さない。
- 中立的なトーン。誇張・断定・煽りを避ける。見出しは40文字以内。
- 出力は指定のJSONのみ。`;
}

async function callGeminiModel(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          topic: { type: "string" },
          title: { type: "string" },
          dek: { type: "string" },
          body_md: { type: "string" },
          used_sources: { type: "array", items: { type: "integer" } }
        },
        required: ["topic", "title", "dek", "body_md", "used_sources"]
      }
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
  const text = cand?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    const reason =
      data?.promptFeedback?.blockReason || cand?.finishReason || "不明";
    throw new Error(`Gemini: 本文なし (reason=${reason}) ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { result: JSON.parse(text), model };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * モデル候補を順に試す。
 *  - 404(モデル廃止)         → すぐ次の候補へ
 *  - 429/500/503(一時的)     → 同じモデルを指数バックオフで最大3回リトライ、ダメなら次の候補へ
 *  - 400/403(リクエスト不正) → 即中断(リトライしても無駄)
 */
async function callGemini(prompt) {
  let lastErr;
  for (const model of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await callGeminiModel(model, prompt);
        if (model !== MODEL_CANDIDATES[0]) log(`  (フォールバックモデル ${model} を使用)`);
        return out;
      } catch (e) {
        lastErr = e;
        const status = (e.message.match(/HTTP (\d+)/) || [])[1];
        if (status === "404") {
          log(`  ${model}: 利用不可 → 次の候補へ`);
          break;
        }
        if (status === "400" || status === "403") throw e;
        if (["429", "500", "503"].includes(status) && attempt < 3) {
          const wait = 4000 * attempt;
          log(`  ${model}: 一時エラー HTTP ${status} → ${wait / 1000}s 後に再試行 (${attempt}/3)`);
          await sleep(wait);
          continue;
        }
        log(`  ${model}: 失敗(${e.message.slice(0, 90)}) → 次の候補へ`);
        break;
      }
    }
  }
  throw lastErr;
}

async function main() {
  log(
    `[column] models=[${MODEL_CANDIDATES.join(", ")}] ` +
      `apiKey=${API_KEY ? API_KEY.slice(0, 6) + "…(" + API_KEY.length + "文字)" : "なし"} ` +
      `force=${FORCE} dryRun=${DRY_RUN}`
  );
  if (!API_KEY && !DRY_RUN) {
    log("SKIP: GEMINI_API_KEY が未設定のためコラム生成をスキップします。");
    return;
  }

  const articles = readJson(ARTICLES_FILE, []);
  const columns = readJson(COLUMNS_FILE, []);
  const today = jstDate();
  log(`[column] articles=${articles.length} columns=${columns.length} today(JST)=${today}`);

  if (!FORCE && columns[0]?.date === today) {
    log(`SKIP: 本日(${today})のコラムは既に存在します。COLUMN_FORCE=1 で再生成できます。`);
    return;
  }

  // 基本は「昨日(JST)の 00:00〜24:00」を対象にする
  const yStart = jstMidnight(1);
  const yEnd = jstMidnight(0);
  const inYesterday = (a) => {
    const t = new Date(a.date).getTime();
    return t >= yStart && t < yEnd;
  };
  let recent = articles.filter(inYesterday);
  let windowLabel = `昨日 ${jstDate(new Date(yStart))} (JST)`;

  if (recent.length < MIN_POOL) {
    recent = articles.filter((a) => new Date(a.date).getTime() >= Date.now() - FALLBACK_HOURS * 3600 * 1000);
    windowLabel = `直近 ${FALLBACK_HOURS}h (昨日ぶんが ${MIN_POOL} 件未満のため拡大)`;
  }
  log(`対象記事: ${recent.length} 件 / ${windowLabel}`);

  const recentTopics = columns.slice(0, AVOID_RECENT_TOPICS).map((c) => c.topic);
  const clusters = buildClusters(recent)
    .filter((c) => !recentTopics.includes(c.name))
    .slice(0, MAX_CANDIDATE_CLUSTERS);

  if (clusters.length === 0) {
    log("SKIP: コラムにできるトピッククラスタがありません。");
    return;
  }
  log(
    "トピック候補: " +
      clusters.map((c) => `${c.name}(${c.items.length}件/score ${c.score.toFixed(1)})`).join(", ")
  );

  const sources = await prepareSources(clusters);
  const prompt = buildPrompt(clusters.map((c) => c.name), sources);

  if (DRY_RUN) {
    log("\n===== DRY RUN: プロンプト =====\n");
    log(prompt);
    return;
  }

  let result, usedModel;
  try {
    ({ result, model: usedModel } = await callGemini(prompt));
  } catch (e) {
    log(`ERROR: Gemini呼び出しに失敗: ${e.message}`);
    return;
  }

  const body = String(result.body_md || "").trim();
  const title = String(result.title || "").trim();
  if (!body || !title) {
    log("ERROR: 生成結果が不十分(title/body欠落)。");
    return;
  }

  // 本文で実際に参照された番号 + used_sources を採用し、こちらの正規URLに差し替える
  const cited = new Set(
    [...(result.used_sources || []), ...[...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))]
  );
  const byN = new Map(sources.map((s) => [s.n, s]));
  const usedSources = [...cited]
    .filter((x) => byN.has(x))
    .sort((a, b) => a - b)
    .map((x) => {
      const s = byN.get(x);
      return { n: x, title: s.title, source: s.source, url: s.url };
    });

  const entry = {
    date: today,
    slug: today,
    topic: String(result.topic || clusters[0].name),
    title,
    dek: String(result.dek || "").trim(),
    body_md: body,
    sources: usedSources,
    model: usedModel,
    generated_at: new Date().toISOString()
  };

  const next = [entry, ...columns.filter((c) => c.date !== today)].slice(0, KEEP_COLUMNS);
  fs.writeFileSync(COLUMNS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  log(`OK: コラムを生成しました → ${entry.title} (出典 ${usedSources.length}件)`);
}

main()
  .catch((e) => {
    console.error("ERROR(想定外):", e);
  })
  .finally(() => process.exit(0));
