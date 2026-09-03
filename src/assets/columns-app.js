/* ============================================================
   コラム一覧のクライアント描画。data/columns.json を読み込み、
   検索 / 年月(→日) / トピック で絞り込む。
   ============================================================ */

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const listEl = $("[data-list]");
  const loadingEl = $("[data-loading]");
  const emptyEl = $("[data-empty]");
  const titleEl = $("[data-view-title]");
  const countEl = $("[data-view-count]");
  const monthListEl = $("[data-month-list]");
  const topicListEl = $("[data-topic-list]");
  const searchEl = $("#search");
  const layoutEl = $("[data-colapp]");
  const toggleEl = $(".menu-toggle");

  let ALL = [];
  let state = { key: "all", q: "" };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

  const ymLabel = (ym) => {
    const [y, m] = ym.split("-");
    return `${y}年${Number(m)}月`;
  };
  const ymdLabel = (ymd) => {
    const [y, m, d] = ymd.split("-");
    return `${y}年${Number(m)}月${Number(d)}日`;
  };
  const slug = (s) =>
    String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const hashtag = (s) => {
    const t = String(s || "").replace(/[^\p{L}\p{N}]+/gu, "");
    return t ? "#" + t : "";
  };
  // コラムに紐づくアーティスト(グループ)名。新データは配列 groups、旧データは topic 単体。
  const groupsOf = (c) =>
    Array.isArray(c.groups) && c.groups.length ? c.groups : c.topic ? [c.topic] : [];

  function readHash() {
    state.key = decodeURIComponent(location.hash.replace(/^#/, "")).trim() || "all";
  }

  function titleForKey(k) {
    if (k === "all") return "コラム";
    if (k === "jp") return "日本のコラム";
    if (k === "kr") return "韓国のコラム";
    if (k.startsWith("m:")) return ymLabel(k.slice(2)) + "のコラム";
    if (k.startsWith("d:")) return ymdLabel(k.slice(2)) + "のコラム";
    if (k.startsWith("t:")) {
      const key = k.slice(2);
      let name = "トピック";
      for (const c of ALL) {
        const g = groupsOf(c).find((x) => slug(x) === key);
        if (g) { name = g; break; }
      }
      return name + "のコラム";
    }
    return "コラム";
  }

  function matchesKey(c) {
    const k = state.key;
    if (k === "jp") return c.region === "jp";
    if (k === "kr") return c.region === "kr";
    if (k.startsWith("m:")) return (c.date || "").startsWith(k.slice(2));
    if (k.startsWith("d:")) return (c.date || "").startsWith(k.slice(2));
    if (k.startsWith("t:")) return groupsOf(c).some((g) => slug(g) === k.slice(2));
    return true;
  }

  function current() {
    const q = state.q.toLowerCase();
    return ALL.filter(matchesKey).filter((c) => {
      if (!q) return true;
      const hay = `${c.title} ${c.dek} ${c.body_md} ${groupsOf(c).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function buildSidebar() {
    $("[data-count-all]").textContent = ALL.length;
    $("[data-count-jp]").textContent = ALL.filter((c) => c.region === "jp").length;
    $("[data-count-kr]").textContent = ALL.filter((c) => c.region === "kr").length;

    const months = new Map();
    const daysBy = new Map();
    for (const c of ALL) {
      const ymd = (c.date || "").slice(0, 10);
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

    const topics = new Map();
    for (const c of ALL) {
      for (const g of groupsOf(c)) {
        const s = slug(g);
        if (!s) continue;
        const cur = topics.get(s) || { name: g, n: 0 };
        cur.n += 1;
        topics.set(s, cur);
      }
    }
    topicListEl.innerHTML = [...topics.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name))
      .map(
        ([s, t]) =>
          `<li><a class="sb-link" data-key="t:${s}" href="#t:${s}">${esc(t.name)}<span class="sb-count">${t.n}</span></a></li>`
      )
      .join("");
    if (topics.size > 12) topicListEl.classList.add("is-scroll");
  }

  function openMonth(ym) {
    const li = monthListEl.querySelector(`.sb-month[data-ym="${ym}"]`);
    if (!li || li.classList.contains("is-open")) return;
    li.classList.add("is-open");
    const sub = li.querySelector(".sb-sub");
    if (sub) sub.hidden = false;
  }

  function syncActive() {
    document.querySelectorAll(".sb-link").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.key === state.key);
    });
    const k = state.key;
    const ym = k.startsWith("d:") ? k.slice(2, 9) : k.startsWith("m:") ? k.slice(2) : null;
    if (ym) openMonth(ym);
  }

  function render() {
    const items = current();
    titleEl.textContent = titleForKey(state.key);
    countEl.textContent = items.length ? `${items.length}本` : "";
    loadingEl.hidden = true;
    emptyEl.hidden = items.length !== 0;

    listEl.innerHTML = items
      .map((c, i) => {
        const delay = Math.min(i, 12) * 28;
        const rtag = c.region
          ? `<span class="tag tag-${c.region}">${c.region === "kr" ? "韓国" : "日本"}</span> `
          : "";
        const gs = groupsOf(c);
        const absUrl = new URL(c.slug + "/", location.href).href;
        const tags = [...gs.map(hashtag), "#Idol_Pulse"].filter(Boolean).join(" ");
        const shareText = `${c.title}\n${c.dek || ""}\n\n${tags}`;
        const shareHref =
          "https://twitter.com/intent/tweet?text=" +
          encodeURIComponent(shareText) +
          "&url=" +
          encodeURIComponent(absUrl);
        const topicLinks = gs
          .map((g) => `<a class="col-card-topic" href="#t:${slug(g)}">${esc(g)}</a>`)
          .join(" ");
        return `<li class="col-card" style="animation-delay:${delay}ms">
  <div class="col-card-meta">${rtag}<time>${esc(c.date)}</time>
    <a class="share-x share-x-sm" href="${shareHref}" target="_blank" rel="noopener" aria-label="Xでシェア">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
    </a>
  </div>
  <h2><a href="${esc(c.slug)}/">${esc(c.title)}</a></h2>
  ${c.dek ? `<p>${esc(c.dek)}</p>` : ""}
  ${topicLinks ? `<div class="col-card-topics">${topicLinks}</div>` : ""}
</li>`;
      })
      .join("");

    layoutEl.classList.remove("menu-open");
  }

  function onRoute() {
    readHash();
    syncActive();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  fetch(window.__COLUMNS_JSON || "./data/columns.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => {
      ALL = Array.isArray(data) ? data : [];
      ALL.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      buildSidebar();
      onRoute();
    })
    .catch((err) => {
      loadingEl.textContent = `コラムの読み込みに失敗しました (${err.message})`;
    });

  window.addEventListener("hashchange", onRoute);

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

  toggleEl?.addEventListener("click", () => layoutEl.classList.toggle("menu-open"));
  layoutEl.addEventListener("click", (e) => {
    if (e.target === layoutEl && layoutEl.classList.contains("menu-open")) {
      layoutEl.classList.remove("menu-open");
    }
  });
})();
