export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

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
