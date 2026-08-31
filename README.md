# 日韓アイドル ニュースまとめ（プロトタイプ）

日本・韓国のアイドル関連ニュースを **公式RSS** から自動収集し、
「見出し + 要約 + 出典リンク」の形でまとめる静的サイトです。すべて無料の構成。

## 仕組み

```
feeds.json ──▶ scripts/fetch-feeds.mjs ──▶ src/_data/articles.json ──▶ Eleventy ──▶ _site/（公開物）
（収集元RSS）      （収集・要約・重複除去）        （記事データ）              （静的HTML生成）
```

- **全文転載はしない**。RSSの説明文を整形した数百字の要約と、出典元へのリンクだけを載せます。
- キーワードで「アイドル関連」に絞り込み（`scripts/fetch-feeds.mjs` の `KEYWORDS`）。
- 取得に失敗したフィードは自動スキップ。

## ローカルで動かす

```bash
npm install
npm run fetch     # RSSを取得して src/_data/articles.json を更新
npm run dev       # http://localhost:8080 でプレビュー
```

`npm run build` は fetch + サイト生成をまとめて実行します。

## 収集元を変える

`feeds.json` を編集するだけ。

```json
{ "name": "サイト名", "url": "https://example.com/rss", "region": "jp", "enabled": true }
```

`region` は `jp` か `kr`。`enabled: false` で一時停止。

## 無料で公開する（GitHub Pages）

1. このフォルダを GitHub リポジトリにpush（リポジトリ名は任意）。
2. リポジトリの **Settings ▸ Pages ▸ Build and deployment ▸ Source** を **GitHub Actions** にする。
3. `.github/workflows/update.yml` が **6時間ごと**に自動で収集・ビルド・公開する。
   - 手動実行は Actions タブの「Update & Deploy ▸ Run workflow」。

## あとから拡張するなら

- **AI要約**: `scripts/fetch-feeds.mjs` の `summarize()` を Claude API 呼び出しに差し替え。
  出典明記 + 自分の言葉での要約にすると独自性が出ます。
- **画像**: 各記事ページには埋め込まず出典元へ誘導する現在の方針を推奨（権利面が安全）。
- **カテゴリ**: グループ名でのタグ付け、検索、グループ別ページなど。
- **収益化**: アクセスが安定してから広告やアフィリエイトを検討。

## 注意

各ニュースの著作権は配信元に帰属します。RSSは配信元が二次利用を想定して公開しているものですが、
要約の分量・引用の範囲・画像の扱いには配慮してください。配信元から停止依頼があった場合は
`feeds.json` の該当フィードを `enabled: false` にしてください。
