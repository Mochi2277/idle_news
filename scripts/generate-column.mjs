/**
 * 「今日のコラム」を1日 最大 COLUMN_COUNT 本(既定3)生成する。ネタが足りなければ本数は減る。
 *
 *  1. articles.json から「今日(JST)の 00:00〜現在」の記事を取り出す(少なすぎる時だけ直近48hに拡大)
 *  2. グループタグでクラスタ化し、報道量(件数・媒体数・日韓横断)でトピックをスコア順に並べる
 *  3. 直近数本 + 今日すでに書いたトピックを除き、上位から不足本数ぶんを対象にする
 *  4. トピックごとに、当日記事の本文 + 同一グループの過去記事(直近90日・最大5本)を「背景」として用意し、
 *     日韓エンタメに詳しいコラムニストの立場で、事実(出典番号つき)と見解を分けたコラムを AI に書かせる(1トピック=1本)
 *  5. 出典リンク付きで src/_data/columns.json に追記(slug: 今日=YYYY-MM-DD、2本目以降は -2, -3 …)
 *
 * API キーが無い / 対象記事が無い / 今日ぶんが既に COLUMN_COUNT 本ある 場合は何もせず正常終了。
 * 予期しない失敗でもニュース側のデプロイを止めないよう、常に exit 0。
 * 環境変数: OPENAI_API_KEY か GEMINI_API_KEY(どちらか必須), OPENAI_MODEL / GEMINI_MODEL(任意),
 *           COLUMN_COUNT(1日の本数。既定3), COLUMN_FORCE=1(今日ぶんを作り直す),
 *           COLUMN_DRY_RUN=1(API未使用でトピックとプロンプトを表示)
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
  "gemini-2.5-flash-lite"
].filter(Boolean);
const FORCE = process.env.COLUMN_FORCE === "1";
const DRY_RUN = process.env.COLUMN_DRY_RUN === "1";

const COLUMN_COUNT = Number(process.env.COLUMN_COUNT || 3); // 1日に作る最大本数(ネタが無ければ減る)
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
const AVOID_RECENT_TOPICS = 6;       // 直近N本と同じトピックは避ける

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

function jsonFormatHint() {
  return `\n\n出力は次のキーだけを持つJSONオブジェクトを1つ、他の文字なしで返す:
{"topic": "選んだトピック名", "title": "見出し(40字以内)", "dek": "リード1〜2文",
 "body_md": "本文(markdown, 900〜1400字, 事実の文末に [1] のような出典番号)", "used_sources": [使った番号の配列]}`;
}

/** OpenAI Chat Completions (JSONモード)。 */
async function callOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "あなたは日本と韓国のポップカルチャー/アイドルシーンを長年取材してきたコラムニスト。指示に厳密に従い、事実と見解を分けて書き、JSONオブジェクトだけを返す。"
        },
        { role: "user", content: prompt + jsonFormatHint() }
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("OpenAI: 空のレスポンス");
  return { result: parseJsonLoose(text), model: `openai:${OPENAI_MODEL}` };
}

async function callGeminiModel(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt + jsonFormatHint() }] }],
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

/** OpenAIキーがあればそれを優先、失敗時 or 無ければ Gemini。 */
async function generateColumn(prompt) {
  if (OPENAI_KEY) {
    try {
      return await callOpenAI(prompt);
    } catch (e) {
      log(`OpenAI失敗(${e.message.slice(0, 140)}) → Geminiにフォールバック`);
    }
  }
  return await callGemini(prompt);
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

  // FORCE のときは今日ぶんを消して作り直す
  const todaysExisting = columns.filter((c) => c.date === today);
  if (FORCE) columns = columns.filter((c) => c.date !== today);
  const baseCount = FORCE ? 0 : todaysExisting.length;
  const need = COLUMN_COUNT - baseCount;
  log(
    `[column] articles=${articles.length} columns=${columns.length} today(JST)=${today} ` +
      `既存(今日)=${baseCount} 目標=${COLUMN_COUNT} 追加予定=${Math.max(need, 0)}`
  );
  if (need <= 0 && !DRY_RUN) {
    log(`SKIP: 本日(${today})のコラムは既に ${baseCount} 本あります。COLUMN_FORCE=1 で作り直せます。`);
    return;
  }

  // 「今日(JST)の 00:00〜現在」を対象に(実行は毎日20時JST)。少なすぎる時だけ48hに拡大。
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
  log(`対象記事: ${recent.length} 件 / ${windowLabel}`);

  // 避けるトピック = 直近N本 + 今日すでに書いたもの(FORCE時は後者なし)
  const avoid = new Set(
    [...columns.slice(0, AVOID_RECENT_TOPICS).map((c) => c.topic), ...todaysExisting.map((c) => c.topic)]
      .filter(Boolean)
      .map(normName)
  );
  const allClusters = buildClusters(recent).filter((c) => !avoid.has(normName(c.name)));
  if (allClusters.length === 0) {
    log("SKIP: コラムにできるトピッククラスタがありません。");
    return;
  }

  const wantCount = DRY_RUN ? COLUMN_COUNT : Math.max(need, 0);
  const targets = allClusters.slice(0, wantCount);
  log(
    `対象トピック(${targets.length}): ` +
      targets.map((c) => `${c.name}(${c.items.length}件/score ${c.score.toFixed(1)})`).join(", ")
  );

  if (DRY_RUN) {
    for (const c of targets) {
      const src = await prepareSources(c, articles, dayStart);
      const bgN = src.filter((s) => s.kind === "background").length;
      log(`\n===== DRY RUN: 「${c.name}」のプロンプト (当日 ${src.length - bgN}本 / 背景 ${bgN}本) =====\n`);
      log(buildPrompt(c.name, src, today));
    }
    return;
  }

  const usedSlugs = new Set(
    columns.filter((c) => c.date === today).map((c) => c.slug)
  );
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

  const made = [];
  for (const cluster of targets) {
    const src = await prepareSources(cluster, articles, dayStart);
    const bgN = src.filter((s) => s.kind === "background").length;
    if (bgN) log(`  ${cluster.name}: 背景記事 ${bgN} 本を追加`);
    let result, usedModel;
    try {
      ({ result, model: usedModel } = await generateColumn(buildPrompt(cluster.name, src, today)));
    } catch (e) {
      log(`  ${cluster.name}: 生成失敗 ${e.message}`);
      continue;
    }
    const body = String(result.body_md || "").trim();
    const title = String(result.title || "").trim();
    if (!body || !title) {
      log(`  ${cluster.name}: 生成結果が不十分(title/body欠落)`);
      continue;
    }

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
    for (const a of cluster.items) if (rc[a.region] !== undefined) rc[a.region] += 1;
    const region = rc.kr > rc.jp ? "kr" : "jp";

    const slug = nextSlug();
    made.push({
      date: today,
      slug,
      topic: cluster.name,
      region,
      title,
      dek: String(result.dek || "").trim(),
      body_md: body,
      sources: usedSources,
      model: usedModel,
      generated_at: new Date().toISOString()
    });
    log(`  OK: ${title} [${slug}] (出典 ${usedSources.length}件)`);
  }

  if (made.length === 0) {
    log("ERROR: 生成できたコラムがありません。");
    return;
  }

  const next = [...made, ...columns].slice(0, KEEP_COLUMNS);
  fs.writeFileSync(COLUMNS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  log(`OK: コラムを ${made.length} 本生成 (今日 合計 ${baseCount + made.length} 本)`);
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
