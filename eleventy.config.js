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

  eleventyConfig.addFilter("dateJP", (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
      d.getDate()
    ).padStart(2, "0")}`;
  });

  eleventyConfig.addFilter("regionLabel", (r) =>
    r === "jp" ? "日本" : r === "kr" ? "韓国" : "その他"
  );

  eleventyConfig.addFilter("json", (v) => JSON.stringify(v));

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    // GitHub Pages のプロジェクトサイト( https://<user>.github.io/idle_news/ )配下で配信されるため、
    // 全ての内部リンク・アセットURLをこの接頭辞つきで出力する。`url` フィルタが自動で付与する。
    pathPrefix: "/idle_news/",
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
