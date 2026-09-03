/**
 * 月別アーカイブページ用のデータ。archive/*.json を月ごとにまとめ、新しい月順で返す。
 * `/archive/` の索引と `/archive/YYYY-MM/` の月別一覧が使う。
 */
import loadArticles from "./articles.js";

export default function () {
  const byMonth = new Map();
  for (const a of loadArticles()) {
    const ym = String(a.date || "").slice(0, 7);
    if (ym.length !== 7) continue;
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(a);
  }
  return [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([ym, items]) => {
      items.sort((x, y) => new Date(y.date) - new Date(x.date));
      return { ym, items, count: items.length };
    });
}
