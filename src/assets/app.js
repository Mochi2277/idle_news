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

  const ymdLabel = (ymd) => {
    const [y, m, d] = ymd.split("-");
    return `${y}年${Number(m)}月${Number(d)}日`;
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
    if (key.startsWith("d:")) return ymdLabel(key.slice(2));
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
    if (k.startsWith("d:")) return (a.date || "").startsWith(k.slice(2));
    if (k.startsWith("g:")) return (a.groups || []).some((g) => g.slug === k.slice(2));
    return true;
  }

  function currentArticles() {
    const q = state.q.toLowerCase();
    return ALL.filter(matchesKey).filter((a) => {
      if (!q) return true;
      const hay = `${a.title} ${a.title_ja || ""} ${a.summary} ${a.summary_ja || ""} ${(a.groups || [])
        .map((g) => g.name)
        .join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /* ---------- サイドバー描画 ---------- */
  function buildSidebar() {
    $("[data-count-all]").textContent = ALL.length;
    $("[data-count-jp]").textContent = ALL.filter((a) => a.region === "jp").length;
    $("[data-count-kr]").textContent = ALL.filter((a) => a.region === "kr").length;

    // 年月 → 日（月をクリックで日が開く）
    const months = new Map(); // ym -> count
    const daysBy = new Map(); // ym -> Map(ymd -> count)
    for (const a of ALL) {
      const ymd = (a.date || "").slice(0, 10);
      if (ymd.length !== 10) continue;
      const ym = ymd.slice(0, 7);
      months.set(ym, (months.get(ym) || 0) + 1);
      if (!daysBy.has(ym)) daysBy.set(ym, new Map());
      const dm = daysBy.get(ym);
      dm.set(ymd, (dm.get(ymd) || 0) + 1);
    }
    monthListEl.innerHTML = [...months.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([ym, n]) => {
        const dayHtml = [...daysBy.get(ym).entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(
            ([ymd, dn]) =>
              `<li><a class="sb-link sb-day" data-key="d:${ymd}" href="#d:${ymd}">${Number(
                ymd.slice(8)
              )}日<span class="sb-count">${dn}</span></a></li>`
          )
          .join("");
        return `<li class="sb-month" data-ym="${ym}">
  <div class="sb-row">
    <a class="sb-link" data-key="m:${ym}" href="#m:${ym}">${ymLabel(ym)}<span class="sb-count">${n}</span></a>
    <button class="sb-exp" type="button" aria-label="日付を開閉">▸</button>
  </div>
  <ul class="sb-sub" hidden>${dayHtml}</ul>
</li>`;
      })
      .join("");

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
    // 選択中が 月 or 日 なら、その月のサブリストを開く
    const k = state.key;
    const ym = k.startsWith("d:") ? k.slice(2, 9) : k.startsWith("m:") ? k.slice(2) : null;
    if (ym) openMonth(ym);
  }

  function openMonth(ym) {
    const li = monthListEl.querySelector(`.sb-month[data-ym="${ym}"]`);
    if (!li || li.classList.contains("is-open")) return;
    li.classList.add("is-open");
    const sub = li.querySelector(".sb-sub");
    if (sub) sub.hidden = false;
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
        const title = a.title_ja || a.title;
        const summary = a.summary_ja || a.summary;
        const orig =
          a.title_ja && a.title_ja !== a.title
            ? `<p class="card-orig">${esc(a.title)}</p>`
            : "";
        return `<li class="card" style="animation-delay:${delay}ms">
  <div class="card-meta">
    <span class="tag tag-${a.region}">${regionLabel(a.region)}</span>
    <span class="src">${esc(a.source)}</span>
    <time>${fmtDate(a.date)}</time>
  </div>
  <h2 class="card-title"><a href="articles/${esc(a.id)}/">${esc(title)}</a></h2>
  ${orig}
  <p class="card-summary">${esc(summary)}</p>
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

  // 年月の ▸ ボタンで日リストを開閉
  monthListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".sb-exp");
    if (!btn) return;
    const li = btn.closest(".sb-month");
    const sub = li.querySelector(".sb-sub");
    const open = li.classList.toggle("is-open");
    if (sub) sub.hidden = !open;
  });

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
