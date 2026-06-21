const $ = (sel) => document.querySelector(sel);
const content = $("#content");
const viewTitle = $("#viewTitle");

let currentView = "all";
let searchTerm = "";

const api = {
  async get(path) {
    const r = await fetch(path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function stars(n) {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

function cardHtml(e) {
  const chips = (e.tags || [])
    .map((t) => `<span class="chip" data-tag="${esc(t)}">#${esc(t)}</span>`)
    .join("");
  return `<article class="card" data-id="${e.id}">
    <div class="card-meta">
      <span class="card-id">#${e.id}</span>
      ${e.category ? `<span class="badge">${esc(e.category)}</span>` : ""}
      <span class="card-date">${fmtDate(e.occurred_at)}</span>
      <span class="stars" title="importance ${e.importance}">${stars(e.importance)}</span>
    </div>
    <div class="card-body">${esc(e.content)}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ""}
    <div class="card-actions">
      <button class="mini" data-graph="${e.id}">⎘ Links</button>
      <button class="mini danger" data-forget="${e.id}">Archive</button>
    </div>
  </article>`;
}

function renderCards(entries) {
  if (!entries || entries.length === 0) {
    content.innerHTML = `<div class="empty">No memories here yet.</div>`;
    return;
  }
  content.innerHTML = `<div class="grid">${entries.map(cardHtml).join("")}</div>`;
}

async function loadStats() {
  const s = await api.get("/api/stats");
  $("#statsCard").innerHTML = `
    <div class="stat"><span class="stat-num">${s.total}</span><span class="stat-label">memories</span></div>
    <div class="stat"><span class="stat-num">${s.tags}</span><span class="stat-label">tags</span></div>
    <div class="stat"><span class="stat-num">${s.links}</span><span class="stat-label">links</span></div>
    <div class="stat"><span class="stat-num">${s.archived}</span><span class="stat-label">archived</span></div>`;
}

async function render() {
  const titles = {
    all: "All memories", timeline: "Timeline", tags: "Tags",
    collections: "Collections", duplicates: "Duplicates",
  };
  viewTitle.textContent = searchTerm ? `Search: “${searchTerm}”` : titles[currentView];

  if (searchTerm) {
    renderCards(await api.get(`/api/entries?q=${encodeURIComponent(searchTerm)}&limit=100`));
    return;
  }

  if (currentView === "all") {
    renderCards(await api.get("/api/entries?limit=100"));
  } else if (currentView === "timeline") {
    const items = await api.get("/api/timeline?limit=200");
    renderCards(items.slice().reverse());
  } else if (currentView === "tags") {
    const tags = await api.get("/api/tags");
    content.innerHTML = tags.length
      ? `<div class="pill-wrap">${tags
          .map((t) => `<span class="tag-pill" data-tag="${esc(t.tag)}">#${esc(t.tag)} <b>${t.count}</b></span>`)
          .join("")}</div>`
      : `<div class="empty">No tags yet.</div>`;
  } else if (currentView === "collections") {
    const cols = await api.get("/api/collections");
    content.innerHTML = cols.length
      ? `<div class="pill-wrap">${cols
          .map((c) => `<span class="tag-pill" data-collection="${c.id}">▤ ${esc(c.name)} <b>${c.count}</b></span>`)
          .join("")}</div>`
      : `<div class="empty">No collections yet. Create them from your MCP client.</div>`;
  } else if (currentView === "duplicates") {
    const pairs = await api.get("/api/duplicates?threshold=0.5");
    content.innerHTML = pairs.length
      ? pairs
          .map(
            (p) => `<div class="dup">
              <span class="dup-score">${Math.round(p.score * 100)}%</span>
              <div><div class="card-body">#${p.a.id}: ${esc(p.a.content.slice(0, 120))}</div>
              <div class="card-body" style="color:var(--text-dim)">#${p.b.id}: ${esc(p.b.content.slice(0, 120))}</div></div>
            </div>`,
          )
          .join("")
      : `<div class="empty">No near-duplicate memories found.</div>`;
  }
}

// Events
$("#nav").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".nav-item");
  if (!btn) return;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  btn.classList.add("active");
  currentView = btn.dataset.view;
  searchTerm = "";
  $("#search").value = "";
  render();
});

let searchTimer;
$("#search").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  const v = ev.target.value.trim();
  searchTimer = setTimeout(() => {
    searchTerm = v;
    render();
  }, 250);
});

content.addEventListener("click", async (ev) => {
  const tagEl = ev.target.closest("[data-tag]");
  const colEl = ev.target.closest("[data-collection]");
  const forgetEl = ev.target.closest("[data-forget]");
  const graphEl = ev.target.closest("[data-graph]");
  if (tagEl) {
    renderCards(await api.get(`/api/entries?tag=${encodeURIComponent(tagEl.dataset.tag)}&limit=100`));
    viewTitle.textContent = `Tag: #${tagEl.dataset.tag}`;
  } else if (colEl) {
    renderCards(await api.get(`/api/entries?collection=${colEl.dataset.collection}&limit=100`));
    viewTitle.textContent = "Collection";
  } else if (forgetEl) {
    await api.post("/api/forget", { id: Number(forgetEl.dataset.forget) });
    toast(`Archived #${forgetEl.dataset.forget}`);
    loadStats();
    render();
  } else if (graphEl) {
    const g = await api.get(`/api/graph/${graphEl.dataset.graph}?depth=2`);
    toast(`#${graphEl.dataset.graph}: ${g.nodes.length} connected · ${g.edges.length} links`);
  }
});

// Modal
const modal = $("#modal");
const openModal = () => { modal.hidden = false; $("#mContent").focus(); };
const closeModal = () => { modal.hidden = true; };
$("#newBtn").addEventListener("click", openModal);
$("#closeModal").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

$("#saveBtn").addEventListener("click", async () => {
  const content = $("#mContent").value.trim();
  if (!content) return toast("Content required");
  const tags = $("#mTags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const category = $("#mCategory").value.trim() || undefined;
  const importance = Number($("#mImportance").value);
  await api.post("/api/remember", { content, tags, category, importance });
  $("#mContent").value = ""; $("#mTags").value = ""; $("#mCategory").value = "";
  closeModal();
  toast("Memory saved");
  loadStats();
  render();
});

$("#themeBtn").addEventListener("click", () => {
  const html = document.documentElement;
  const next = html.dataset.theme === "dark" ? "light" : "dark";
  html.dataset.theme = next;
  $("#themeBtn").textContent = next === "dark" ? "☾" : "☀";
  localStorage.setItem("ai-diary-theme", next);
});

$("#snapshotBtn").addEventListener("click", async () => {
  const r = await api.post("/api/snapshot", {});
  toast(r.message || "snapshot done");
});

// Init
const savedTheme = localStorage.getItem("ai-diary-theme");
if (savedTheme) {
  document.documentElement.dataset.theme = savedTheme;
  $("#themeBtn").textContent = savedTheme === "dark" ? "☾" : "☀";
}
loadStats();
render();
