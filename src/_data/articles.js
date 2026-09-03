/**
 * Eleventy グローバルデータ `articles`。
 * ニュース記事は月別シャード archive/YYYY-MM.json に永続保存しており(アーカイブ)、
 * ここで全月を結合し、新しい順に並べて 1 本の配列として返す。
 * ページ数を増やさないため個別記事ページは作らない(一覧のタイトルは配信元へ直リンク)。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARCHIVE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "archive"
);

export default function () {
  let all = [];
  try {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const arr = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), "utf8"));
      if (Array.isArray(arr)) all = all.concat(arr);
    }
  } catch {
    /* アーカイブがまだ無ければ空配列 */
  }
  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  return all;
}
