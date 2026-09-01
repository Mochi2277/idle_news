import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // コラム本文(AI生成の markdown 文字列)を安全にHTML化し、[n] を出典へのリンクにする
  eleventyConfig.addFilter("columnBody", (s) => {
    if (!s) return "";
    return md
      .render(String(s))
      .replace(/\[(\d{1,2})\]/g, '<a class="cite" href="#src-$1">[$1]</a>');
  });

  // 記事の date は UTC。ビルドは UTC ランナーで走るため、明示的に JST(UTC+9) へ寄せて表示する。
  eleventyConfig.addFilter("dateJP", (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const [y, m, day] = new Date(d.getTime() + 9 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
      .split("-");
    return `${y}/${m}/${day}`;
  });

  eleventyConfig.addFilter("regionLabel", (r) =>
    r === "jp" ? "日本" : r === "kr" ? "韓国" : "その他"
  );

  eleventyConfig.addFilter("json", (v) => JSON.stringify(v));

  // グループ名などを X 用ハッシュタグに(記号・空白を除去、# を前置)
  eleventyConfig.addFilter("hashtag", (s) => {
    const t = String(s || "").replace(/[^\p{L}\p{N}]+/gu, "");
    return t ? "#" + t : "";
  });

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    // GitHub Pages のプロジェクトサイト( https://<user>.github.io/idle_news/ )配下で配信されるため、
    // 全ての内部リンク・アセットURLをこの接頭辞つきで出力する。`url` フィルタが自動で付与する。
    pathPrefix: "/idle_news/",
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
