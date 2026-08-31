/* ============================================================
   日韓アイドル ニュースまとめ — クライアント側の動的レンダリング
   data/articles.json を読み込み、サイドバー(エリア/年月/グループ)と
   記事一覧をハッシュルーティングで切り替える。
   ============================================================ */

(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const listEl = $("[data-list]");
  const loadingEl = $("[data-loading]");
  const emptyEl = $("[data-empty]");
  const titleEl = $("[data-view-title]");
  const countEl = $("[data-view-count]");
  const monthListEl = $("[data-month-list]");
  const groupListEl = $("[data-group-list]");
  const searchEl = $("#search");
  const layoutEl = $("[data-app]");
  const toggleEl = $(".menu-toggle");

  let ALL = [];
  let state = { key: "all", q: "" };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

  const fmtDate = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
      d.getDate()
    ).padStart(2, "0")}`;
  };

  const ymLabel = (ym) => {
    const [y, m] = ym.split("-");
    return `${y}年${Number(m)}月`;
  };

  const regionLabel = (r) => (r === "jp" ? "日本" : r === "kr" ? "韓国" : "その他");

  /* ---------- ルーティング ---------- */
  function readHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
    state.key = h || "all";
  }

  function titleForKey(key) {
    if (key === "all") return "最新ニュース";
    if (key === "jp") return "日本のニュース";
    if (key === "kr") return "韓国のニュース";
    if (key.startsWith("m:")) return ymLabel(key.slice(2));
    if (key.startsWith("g:")) {
      const g = ALL.flatMap((a) => a.groups || []).find((x) => x.slug === key.slice(2));
      return g ? g.name : "グループ";
    }
    return "ニュース";
  }

  /* ---------- フィルタ ---------- */
  function matchesKey(a) {
    const k = state.key;
    if (k === "jp") return a.region === "jp";
    if (k === "kr") return a.region === "kr";
    if (k.startsWith("m:")) return (a.date || "").startsWith(k.slice(2));
    if (k.startsWith("g:")) return (a.groups || []).some((g) => g.slug === k.slice(2));
    return true;
  }

  function currentArticles() {
    const q = state.q.toLowerCase();
    return ALL.filter(matchesKey).filter((a) => {
      if (!q) return true;
      const hay = `${a.title} ${a.summary} ${(a.groups || []).map((g) => g.name).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /* ---------- サイドバー描画 ---------- */
  function buildSidebar() {
    $("[data-count-all]").textContent = ALL.length;
    $("[data-count-jp]").textContent = ALL.filter((a) => a.region === "jp").length;
    $("[data-count-kr]").textContent = ALL.filter((a) => a.region === "kr").length;

    // 年月
    const months = new Map();
    for (const a of ALL) {
      const ym = (a.date || "").slice(0, 7);
      if (ym) months.set(ym, (months.get(ym) || 0) + 1);
    }
    monthListEl.innerHTML = [...months.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(
        ([ym, n]) =>
          `<li><a class="sb-link" data-key="m:${ym}" href="#m:${ym}">${ymLabel(ym)}<span class="sb-count">${n}</span></a></li>`
      )
      .join("");
    if (months.size > 10) monthListEl.classList.add("is-scroll");

    // グループ
    const groups = new Map();
    for (const a of ALL) {
      for (const g of a.groups || []) {
        const cur = groups.get(g.slug) || { name: g.name, n: 0 };
        cur.n += 1;
        groups.set(g.slug, cur);
      }
    }
    groupListEl.innerHTML = [...groups.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name))
      .map(
        ([slug, g]) =>
          `<li><a class="sb-link" data-key="g:${slug}" href="#g:${slug}">${esc(g.name)}<span class="sb-count">${g.n}</span></a></li>`
      )
      .join("");
    if (groups.size > 12) groupListEl.classList.add("is-scroll");
  }

  function syncActive() {
    document.querySelectorAll(".sb-link").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.key === state.key);
    });
  }

  /* ---------- 一覧描画 ---------- */
  function render() {
    const items = currentArticles();
    titleEl.textContent = titleForKey(state.key);
    countEl.textContent = items.length ? `${items.length}件` : "";
    loadingEl.hidden = true;
    emptyEl.hidden = items.length !== 0;

    listEl.innerHTML = items
      .map((a, i) => {
        const delay = Math.min(i, 12) * 28;
        const chips = (a.groups || [])
          .map((g) => `<a class="chip" href="#g:${g.slug}">${esc(g.name)}</a>`)
          .join("");
        return `<li class="card" style="animation-delay:${delay}ms">
  <div class="card-meta">
    <span class="tag tag-${a.region}">${regionLabel(a.region)}</span>
    <span class="src">${esc(a.source)}</span>
    <time>${fmtDate(a.date)}</time>
  </div>
  <h2 class="card-title"><a href="articles/${esc(a.id)}/">${esc(a.title)}</a></h2>
  <p class="card-summary">${esc(a.summary)}</p>
  ${chips ? `<div class="chips">${chips}</div>` : ""}
</li>`;
      })
      .join("");

    // モバイル: ナビ選択でドロワーを閉じる
    layoutEl.classList.remove("menu-open");
  }

  function onRoute() {
    readHash();
    syncActive();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------- 初期化 ---------- */
  fetch("./data/articles.json", { cache: "no-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      ALL = Array.isArray(data) ? data : [];
      ALL.sort((a, b) => new Date(b.date) - new Date(a.date));
      buildSidebar();
      onRoute();
    })
    .catch((err) => {
      loadingEl.textContent = `記事の読み込みに失敗しました (${err.message})`;
    });

  window.addEventListener("hashchange", onRoute);

  searchEl.addEventListener("input", () => {
    state.q = searchEl.value.trim();
    render();
  });

  toggleEl?.addEventListener("click", () => {
    layoutEl.classList.toggle("menu-open");
  });
  layoutEl.addEventListener("click", (e) => {
    // オーバーレイ(::after)クリックで閉じる
    if (e.target === layoutEl && layoutEl.classList.contains("menu-open")) {
      layoutEl.classList.remove("menu-open");
    }
  });
})();
