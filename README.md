# 日韓アイドル ニュースまとめ（プロトタイプ）

日本・韓国のアイドル／アーティスト関連ニュースを **公式RSS** から自動収集し、
「見出し + 要約 + 出典リンク」の形でまとめる静的サイトです。すべて無料の構成。

公開URL: https://mochi2277.github.io/idle_news/

## 仕組み

```
feeds.json ─▶ scripts/fetch-feeds.mjs ─▶ src/_data/articles.json ─▶ Eleventy ─▶ _site/（公開物）
（収集元RSS）   （収集・要約・分類・重複除去）     （記事データ）           （静的HTML + data/articles.json）
```

- **全文転載はしない**。RSSの説明文を整形した数百字の要約と、出典元へのリンクだけを載せます。
- フィードごとに `mode` を指定：
  - `strict` … `KEYWORDS`（アイドル/アーティスト関連語）に一致した記事だけ採用
  - `loose` … `EXCLUDE`（グラビア・水着等）に当たらなければ採用
- `GROUPS` 辞書で記事にグループ名を自動タグ付け（サイドバーの「グループ」欄になる）。
- 英語（韓国系ソース）の見出し・要約は無料の翻訳API（MyMemory、失敗時はGoogle非公式）で
  日本語化し `title_ja` / `summary_ja` に保存。一度訳したら再利用するので、毎回の実行では
  新着分だけ翻訳する（1回あたり `TRANSLATE_MAX` 件まで）。無効化は `TRANSLATE = false`。
- RSSに全文が入っている場合は `body` として保持（コラム生成用。クライアント配信用JSONからは除外）。
- 取得に失敗したフィードは自動スキップ。

## コラム（1日 最大4本・AI生成 / 狭め2本＋広め2本）

```
scripts/generate-column.mjs
  == group（狭め・特定グループの深掘り。既定2本）==
  1. 「今日(JST)の00:00〜現在」の記事を対象にする（20件未満のときだけ直近48hに拡大）
  2. グループタグでクラスタ化し、報道量(件数・媒体数・日韓横断)でトピックをスコア順に並べる
  3. 直近数本 + 今日すでに書いたトピックを除き、上位から「不足本数」ぶんを対象にする
  4. 当日記事 + 同一グループの過去記事（背景・最大5本）を渡し、AI にコラムを書かせる

  == broad（広め・複数グループの横断比較。既定2本）==
  1. 直近7日ぶんの記事に、テーマ辞書（BROAD_THEMES: 新人 / ライブ動員 / チャート / 卒業・体制変更 /
     海外進出 / 賞レース / タイアップ / メディア）を見出しでマッチさせる
  2. グループ紐付き記事数・媒体数・関与グループ数でスコア化し、上位4テーマを候補に
  3. 候補と関連見出しを AI（編集者役）に渡し、横断比較で面白いテーマを2つ＋注目点(angle)つきで選ばせる
  4. テーマごとに最大14本の記事（グループ紐付きを優先）を渡し、AI に横断コラムを書かせる

  == 共通 ==
  5. 出典リンク・kind(group|broad) 付きで src/_data/columns.json に追記
     slug は 今日=YYYY-MM-DD、2本目以降は -2 / -3 …（group を先に生成するので若い番号は group）
     `groups` に「記事に登場するアーティスト名」を格納（group=クラスタ名 / broad=引用記事のタグを頻度順）。
     一覧・詳細のタグはこの `groups` で、group/broad の区別は画面には出さない（kind は生成本数の制御用）。
  * broad が2本立たない日は group で埋めて常に最大 COLUMN_COUNT 本にする
```

- `.github/workflows/column.yml` が毎日 15:17 JST 目標で実行。
- **本数**は既定 4本（`COLUMN_COUNT`）、うち広めが既定 2本（`COLUMN_BROAD_COUNT`）。いずれも Variables で変更可。
  ネタが足りなければ本数は減る。再実行すると不足分だけ追加。`COLUMN_FORCE=1` で今日ぶんを作り直し。
- **文章生成プロバイダ**（Secrets に登録）:
  - `OPENAI_API_KEY` があれば **OpenAI を優先**（既定モデル `gpt-4o-mini`、`OPENAI_MODEL` で変更可）。失敗時は Gemini へ。
  - 無ければ `GEMINI_API_KEY`（無料）。`gemini-flash-latest` → `gemini-3.6-flash` → `gemini-2.5-flash-lite` を自動フォールバック。
    思考型モデルで出力が切れないよう thinkingBudget=0 / maxOutputTokens=8192 で呼ぶ。
- 本文の `[n]` は末尾の「参考記事」リンクに対応。各コラムに「AIが作成した下書き」の注記あり。
- 生成失敗／APIキー未設定／当日分が既にある場合は何もせず正常終了（デプロイは止めない）。
- ローカル確認: `COLUMN_DRY_RUN=1 node scripts/generate-column.mjs`（API未使用、クラスタとプロンプトを表示）。
  実生成は `COLUMN_FORCE=1 OPENAI_API_KEY=... node scripts/generate-column.mjs`。

## フロントエンド

- トップページは `data/articles.json` を読み込んでクライアント側で描画（`src/assets/app.js`）。
- 左サイドバー：キーワード検索 / エリア（日本・韓国）/ 年月 / グループ。
- グループを選ぶと、日韓どちらのソースの記事もまとめて表示される（例：Stray Kids）。
- URLハッシュで状態を保持（`#jp` `#m:2026-08` `#g:stray-kids`）。
- 各記事の個別ページ（`/articles/<id>/`）はEleventyが静的生成（共有・SEO用）。

## ローカルで動かす

```bash
npm install
npm run fetch     # RSSを取得して src/_data/articles.json を更新
npm run dev       # http://localhost:8080/idle_news/ でプレビュー
```

`npm run build` は fetch + サイト生成をまとめて実行します。

## 収集元を変える

`feeds.json` を編集するだけ。

```json
{ "name": "サイト名", "url": "https://example.com/rss", "region": "jp", "mode": "strict", "enabled": true }
```

`region` は `jp` か `kr`。`mode` は `strict` か `loose`。`enabled: false` で一時停止。

## フィルタ・グループを調整する

`scripts/fetch-feeds.mjs` の以下を編集：

- `KEYWORDS` … strict フィードで「関連」と判定する語
- `EXCLUDE` … 全フィードで弾く語（グラビア系）。更新すると過去記事も遡って除外される
- `GROUPS` … `"表示名": ["別名1", "別名2", ...]`。記事が1件以上あればサイドバーに自動で出る

## 公開（GitHub Pages / 無料）

1. GitHub リポジトリに push。
2. **Settings ▸ Pages ▸ Source** を **GitHub Actions**。
3. **Settings ▸ Actions ▸ General ▸ Workflow permissions** を **Read and write**。
4. `.github/workflows/update.yml` が **6時間ごと**に収集・ビルド・公開（手動実行も可）。

> **リポジトリ名を変えたとき**は `eleventy.config.js` の `pathPrefix: "/idle_news/"` を
> 新しいリポジトリ名に合わせて変更すること（GitHub Pagesのサブパス配信のため）。
> 独自ドメインを使う場合は `pathPrefix: "/"` に戻す。

## あとから拡張するなら

- **AI要約**: `summarize()` を Claude API 呼び出しに差し替え（出典明記 + 自分の言葉で要約すると独自性が出る）。
- **画像**: 各記事ページには埋め込まず出典元へ誘導する現在の方針を推奨（権利面が安全）。
- **収益化**: アクセスが安定してから広告やアフィリエイトを検討。

## 注意

各ニュースの著作権は配信元に帰属します。RSSは配信元が二次利用を想定して公開しているものですが、
要約の分量・引用の範囲・画像の扱いには配慮してください。配信元から停止依頼があった場合は
`feeds.json` の該当フィードを `enabled: false` にしてください。
