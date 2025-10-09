// === GOOGLE SHEETS (Published CSV) CONFIG ===
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTW0dfyxzzttB8ukYBZS8UygpXaRllwKctevJKB4-6mSFst21f36MEBbKa5pHhur5eUFRfr84UfcuGa/pub?gid=0&single=true&output=csv";

const CSV_FETCH_OPTS = { cache: "no-store" };
function withCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set("_cb", Date.now().toString());
  return u.toString();
}

// --- Admin mode: URL-driven only (?admin=1) ---
function isAdmin() {
  return new URLSearchParams(location.search).get("admin") === "1";
}

/* =================================================
   🔧 CONFIG: CARD FIELDS + CONFIGURABLE MODAL
================================================= */
// Map your sheet columns to core fields (case-insensitive)
const FIELD_MAP = {
  id:     ["id", "uid", "slug", "competition_id"],
  title:  ["Comp name"],
  date:   ["Date"],
  type:   ["Comp format (scoring type)", "Comp format"],
  overview: ["Comp Summary", "Comp Description"],      // short card text
  details:  ["Comp Description", "Comp Summary"],      // overview body (modal)
  link:   ["link", "url", "website", "info_url"]       // optional; shows a badge
};

/*
  MODAL_CONFIG: fully controls what appears in the modal.
  - "rich" section picks first non-empty field from `fields` (or `adminFields` for admin).
  - "list" section shows label:value lines from `items`.
  - Mark any list item with { adminOnly: true } to hide from public view.
  You can edit labels, headers, order — or add/remove sections as you like.
*/
const MODAL_CONFIG = [
  {
    title: "Overview",
    type: "rich",
    fields: ["Comp Description", "Comp Summary"],
    adminFields: ["Comp Description", "Comp Summary"] // can differ from public if you want
  },
  {
    title: "Rules",
    type: "list",
    items: [
      // Public
      { label: "Entrant criteria",          header: "Entrant criteria" },
      { label: "Acceptable for Handicap",   header: "Acceptable for Handicap" },
      { label: "Handicap Limit",            header: "Handicap Limit" },
      { label: "Handicap Allowance",        header: "Handicap Allowance" },
      { label: "Divisions",                 header: "Divisions" },
      // Admin-only extras
      { label: "Board Competition",         header: "Board Comp", adminOnly: true },
      { label: "Criteria for Prizewinners", header: "Criteria for Prizewinners", adminOnly: true },
      { label: "2's competition",           header: "2's comp", adminOnly: true },
      { label: "Merit Shield Contributor",  header: "Merit Shield Contributer", adminOnly: true },
      { label: "Trophy",                    header: "Trophy", adminOnly: true }
    ]
  },
  {
    title: "Procedures",
    type: "list",
    items: [
      // Public
      { label: "Start Sheet",           header: "Start Sheet" },
      { label: "1st & last tee times",  header: "1st & last tee times" },
      { label: "Players per time",      header: "Players per time" },
      { label: "Interval",              header: "Interval (10 Mins)" },
      { label: "Sign in options",       header: "Sign in options" },
      { label: "Score entry",           header: "Score entry" },
      // Admin-only extras
      { label: "Booking options",       header: "Enable booking options", adminOnly: true },
      { label: "Booking window",        header: "Enabled from and to", adminOnly: true },
      { label: "Zones for drawn comps", header: "Zones for drawn comps", adminOnly: true },
      { label: "Sign in enabled",       header: "Enable Sign in", adminOnly: true },
      { label: "Sign in times",         header: "From and to times", adminOnly: true },
      { label: "Sign In Message",       header: "Sign In Message", adminOnly: true },
      { label: "Charges enabled",       header: "Enable Charges", adminOnly: true },
      { label: "Member Fee",            header: "Member Fee", adminOnly: true },
      { label: "When to charge",        header: "When to charge", adminOnly: true },
      { label: "Refund options",        header: "Refund options", adminOnly: true },
      { label: "Leaderboard",           header: "Leaderboard", adminOnly: true },
      { label: "Sweep breakdown",       header: "Sweep breakdown", adminOnly: true },
      { label: "Course Cards",          header: "Course Cards", adminOnly: true }
    ]
  }
];

/* ================================================
   Robust CSV parser (handles quoted newlines, quotes)
================================================ */
function parseCSV(csv) {
  const rows = [];
  let row = [], field = "", i = 0, inQuotes = false;
  while (i < csv.length) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { if (csv[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h || "").trim());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").toString()));
    return obj;
  });
}

/* ================================================
   Case-insensitive field helpers
================================================ */
function buildLc(rec) {
  if (rec.__lc) return rec.__lc;
  const m = {};
  for (const k in rec) m[k.toLowerCase()] = rec[k];
  rec.__lc = m;
  return m;
}
function getField(rec, key) {
  const candidates = FIELD_MAP[key] || [];
  const lc = buildLc(rec);
  for (const name of candidates) {
    const v = lc[name.toLowerCase()];
    if (v != null && v !== "") return String(v);
  }
  return "";
}
function getByHeader(rec, header) {
  if (!header) return "";
  const lc = buildLc(rec);
  return lc[header.toLowerCase()] ?? "";
}

/* ================================================
   Normalize record for cards
================================================ */
function makeSlug(s) {
  return (s || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0,80) || "item";
}
function normalizeRecord(rec) {
  const id    = getField(rec, "id") || makeSlug(getField(rec, "title") || "competition");
  const title = getField(rec, "title") || "Untitled competition";
  const date  = getField(rec, "date");
  const type  = getField(rec, "type");
  const overview = getField(rec, "overview");
  const link  = getField(rec, "link");
  return { id, title, date, type, overview, link, __raw: rec };
}

/* ================================================
   Search / Fuzzy
================================================ */
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
function scoreRecord(rec, q) {
  const n = normalizeRecord(rec);
  const text = `${n.title} ${n.type} ${n.overview} ${Object.values(rec).join(" ")}`.toLowerCase();
  const tokens = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, fuzzy: false };
  let score = 0, anyExact = false;
  for (const t of tokens) {
    if (text.includes(t)) { score += 3; anyExact = true; }
    else {
      const chunks = text.split(/[^a-z0-9]+/i);
      let best = Infinity;
      for (const c of chunks) { if (!c) continue; const d = levenshtein(t, c); if (d < best) best = d; }
      if (best === 1) score += 2; else if (best === 2) score += 1;
    }
  }
  return { score, fuzzy: !anyExact && score > 0 };
}

/* ================================================
   Plain text highlight (card title/type)
================================================ */
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}
function highlightExact(text, query) {
  if (!query.trim()) return escapeHTML(text);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return escapeHTML(text);
  const rx = new RegExp("(" + tokens.join("|") + ")", "gi");
  return escapeHTML(text).replace(rx, (m) => `<mark>${escapeHTML(m)}</mark>`);
}

/* ================================================
   Safe HTML pipeline (modal content)
================================================ */
const ALLOWED_TAGS = new Set(["P", "BR", "B", "I", "EM", "STRONG", "A", "SPAN"]);
function isSafeHttpUrl(url) {
  try { const u = new URL(url, window.location.origin); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
}
function sanitizeClassValue(raw) {
  if (!raw) return "";
  return raw.split(/\s+/).filter(Boolean).filter(t => /^[A-Za-z0-9_-]{1,64}$/.test(t)).join(" ");
}
function decodeEntities(str) {
  if (!str) return "";
  const el = document.createElement("textarea"); el.innerHTML = str; return el.value;
}
function normalizeMultilinePlainText(str) {
  if (!str) return "";
  if (/[<][a-zA-Z]/.test(str)) return str; // looks like HTML already
  return str.replace(/\r?\n/g, "<br>");
}
function sanitizeBasicHTML(input) {
  if (!input) return "";
  const root = document.createElement("div");
  root.innerHTML = input;
  (function sanitize(node) {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toUpperCase();
        if (!ALLOWED_TAGS.has(tag)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child); return;
        }
        const rawClass = child.getAttribute("class") || "";
        const cleanClass = sanitizeClassValue(rawClass);

        if (tag === "A") {
          const href = child.getAttribute("href") || "";
          [...child.attributes].forEach((a) => child.removeAttribute(a.name));
          if (isSafeHttpUrl(href)) {
            child.setAttribute("href", href);
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noopener noreferrer");
          } else {
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child); return;
          }
          if (cleanClass) child.setAttribute("class", cleanClass);
        } else {
          [...child.attributes].forEach((a) => child.removeAttribute(a.name));
          if (cleanClass) child.setAttribute("class", cleanClass);
        }
        sanitize(child);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        node.removeChild(child);
      }
    });
  })(root);
  return root.innerHTML;
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function highlightHTML(html, query) {
  if (!query || !query.trim()) return html;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return html;

  const rx = new RegExp("(" + tokens.map(escapeRegex).join("|") + ")", "gi");
  const container = document.createElement("div");
  container.innerHTML = html;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts = [];
  let n; while ((n = walker.nextNode())) texts.push(n);

  texts.forEach((txt) => {
    const val = txt.nodeValue; if (!rx.test(val)) return;
    const frag = document.createDocumentFragment();
    let last = 0;
    val.replace(rx, (m, _g, i) => {
      if (i > last) frag.appendChild(document.createTextNode(val.slice(last, i)));
      const mark = document.createElement("mark"); mark.textContent = m;
      frag.appendChild(mark);
      last = i + m.length;
    });
    if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
    txt.parentNode.replaceChild(frag, txt);
  });
  return container.innerHTML;
}

/* ================================================
   Date helpers
================================================ */
function parseCompetitionDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const dateOnly = s.split(/[T\s]/)[0];

  const mIso = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mIso) { const [_, y, mo, d] = mIso; const dt = new Date(+y, +mo-1, +d); dt.setHours(0,0,0,0); return dt; }

  const mUk = dateOnly.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mUk) { const [_, d, mo, y] = mUk; const dt = new Date(+y, +mo-1, +d); dt.setHours(0,0,0,0); return dt; }

  const parsed = new Date(s);
  if (!isNaN(parsed)) { parsed.setHours(0,0,0,0); return parsed; }
  return null;
}
function isPastDate(eventDate) {
  if (!eventDate) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  return eventDate < today;
}

/* ================================================
   State & DOM refs
================================================ */
let allRecords = [];
let filtered = [];
let currentPage = 1;
let pageSize = 10;
let currentRole = ""; // filter by "type"
let currentQuery = "";
let fuzzyEnabled = false;

const listEl = document.getElementById("data-list");
const searchEl = document.getElementById("search-input");
const roleEl = document.getElementById("role-filter");
const pageSizeEl = document.getElementById("page-size");
const prevBtn = document.getElementById("prev-page");
const nextBtn = document.getElementById("next-page");
const pageInfo = document.getElementById("page-info");
const resultCount = document.getElementById("result-count");
const fuzzyToggle = document.getElementById("fuzzy-toggle");
const fuzzyHint = document.getElementById("fuzzy-hint");
document.getElementById("refresh-sheet")?.addEventListener("click", () => loadCSVFile());

// Modal refs (must match your HTML)
const modalEl = document.getElementById("record-modal");
const modalCloseBtn = document.getElementById("modal-close");
const modalTitle = document.getElementById("modal-title");
const modalMeta = document.getElementById("modal-meta");
// We render into these three containers
const modalDetails = document.getElementById("modal-details");
const modalRules = document.getElementById("modal-rules");
const modalProcedures = document.getElementById("modal-procedures");
let lastFocus = null;

/* ================================================
   Fetch + init
================================================ */
async function loadCSVFile() {
  try {
    const res = await fetch(withCacheBuster(SHEET_CSV_URL), CSV_FETCH_OPTS);
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    const text = await res.text();
    allRecords = parseCSV(text);

    // (Optional) Debug table of headers + sample values
    if (Array.isArray(allRecords) && allRecords.length > 0) {
      const sampleCount = Math.min(3, allRecords.length);
      const headers = Object.keys(allRecords[0]);
      const debugData = headers.map(h => {
        const samples = allRecords.slice(0, sampleCount).map(r => (r[h] ?? "").trim()).filter(Boolean);
        return { Header: h, "Samples (first few)": samples.join(" | ") || "(no values)" };
      });
      console.groupCollapsed("📊 Google Sheet Headers & Sample Values");
      console.table(debugData);
      console.log(`Detected ${headers.length} columns and ${allRecords.length} rows`);
      console.groupEnd();
    }

    // Build the type/category dropdown from your data
    const roles = [...new Set(allRecords.map(r => (getField(r, "type") || "").trim()).filter(Boolean))].sort();
    roleEl.innerHTML = '<option value="">All types</option>';
    roles.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r;
      roleEl.appendChild(opt);
    });

    applyFilters();

    // Open deep link if present (preserve ?admin=1)
    const hashId = location.hash.replace(/^#/, "");
    if (hashId) {
      const rec = findRecordById(hashId);
      if (rec) openModalForRecord(rec, /*pushHash*/ false);
    }
  } catch (err) {
    console.error("Failed to load Google Sheet CSV:", err);
    listEl.innerHTML = `<li style="color:#b91c1c">Failed to load data. Check your Sheet URL or publish settings.</li>`;
  }
}

/* ================================================
   Filtering + Searching
================================================ */
function applyFilters() {
  const q = currentQuery.trim().toLowerCase();

  let temp = currentRole
    ? allRecords.filter(r => (getField(r, "type") || "").toLowerCase() === currentRole.toLowerCase())
    : [...allRecords];

  if (!q) {
    filtered = temp;
  } else if (!fuzzyEnabled) {
    filtered = temp.filter(r =>
      Object.values(r).some(val => (val || "").toLowerCase().includes(q))
    );
  } else {
    const scored = temp
      .map(rec => ({ rec, s: scoreRecord(rec, q) }))
      .filter(x => x.s.score > 0)
      .sort((a, b) => b.s.score - a.s.score);
    filtered = scored.map(x => ({ ...x.rec, __fuzzy: x.s.fuzzy }));
  }

  currentPage = 1;
  render();
}

/* ================================================
   Rendering (cards + pagination)
================================================ */
function render() {
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.min(currentPage, pages);

  const start = (currentPage - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  listEl.innerHTML = "";
  for (const rawRec of slice) {
    const recN = normalizeRecord(rawRec);

    const fuzzyTag = rawRec.__fuzzy ? '<span class="badge fuzzy" title="Approximate match">≈ fuzzy</span>' : "";
    const name = highlightExact(recN.title, currentQuery);
    const role = highlightExact(recN.type || "", currentQuery);

    const decoded = decodeEntities(recN.overview || "");
    const withBreaks = normalizeMultilinePlainText(decoded);
    const safeMsg = sanitizeBasicHTML(withBreaks);
    const msg = highlightHTML(safeMsg, currentQuery);

    const eventDate = parseCompetitionDate(recN.date);
    const past = isPastDate(eventDate);
    const playedBadge = past ? '<span class="badge past" title="Completed">Played</span>' : "";

    const linkBadge = recN.link && isSafeHttpUrl(recN.link)
      ? `<a class="badge" href="${recN.link}" target="_blank" rel="noopener noreferrer">Link</a>`
      : "";

    const li = document.createElement("li");
    if (past) li.classList.add("is-past");
    li.dataset.id = recN.id;

    li.innerHTML = `
      <div class="entry-top">
        <div>
          <strong>${name}</strong>
          <span class="entry-role">— ${role}</span>
        </div>
        <div class="badges">
          <span class="badge secondary">CSV</span>
          ${linkBadge}
          ${playedBadge}
          ${fuzzyTag}
        </div>
      </div>
      ${recN.date ? `<div class="muted" style="margin-top:.25rem;">${escapeHTML(recN.date)}</div>` : ""}
      <div class="entry-msg">${msg}</div>
      <div style="margin-top:.6rem;">
        <button class="view-btn" data-view="${recN.id}" aria-label="View details for ${escapeHTML(recN.title)}">View details</button>
      </div>
    `;
    listEl.appendChild(li);
  }

  resultCount.textContent = `${total} result${total === 1 ? "" : "s"}`;
  pageInfo.textContent = `Page ${currentPage} / ${pages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= pages;
  fuzzyHint.textContent = fuzzyEnabled
    ? "Fuzzy search on: results include approximate matches. Exact hits are highlighted."
    : "";

  listEl.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-view");
      const rec = findRecordById(id);
      if (rec) openModalForRecord(rec);
    });
  });
}

/* ================================================
   Modal (config-driven; respects ?admin=1)
================================================ */
function findRecordById(id) {
  if (!id) return null;
  let hit = allRecords.find(r => getField(r, "id") === id);
  if (hit) return hit;
  return allRecords.find(r => makeSlug(getField(r, "title") || "competition") === id) || null;
}

function renderLabelValueList(pairs, query) {
  if (!pairs.length) return `<p class="muted">No information.</p>`;
  const items = pairs.map(({ label, value }) => {
    const html = highlightHTML(
      sanitizeBasicHTML(normalizeMultilinePlainText(decodeEntities(value))),
      query
    );
    return `<li><strong>${escapeHTML(label)}:</strong> <span class="kv-value">${html}</span></li>`;
  }).join("");
  return `<ul class="kv-list">${items}</ul>`;
}

function buildSectionHTML(rec, section, query) {
  const admin = isAdmin();

  if (section.type === "rich") {
    const fieldList = admin && Array.isArray(section.adminFields) && section.adminFields.length
      ? section.adminFields
      : (section.fields || []);
    let content = "";
    for (const h of fieldList) {
      const val = getByHeader(rec, h);
      if (val && String(val).trim() !== "") { content = String(val); break; }
    }
    const html = highlightHTML(
      sanitizeBasicHTML(normalizeMultilinePlainText(decodeEntities(content))),
      query
    );
    return html || `<p class="muted">No information.</p>`;
  }

  if (section.type === "list") {
    const pairs = [];
    for (const item of (section.items || [])) {
      if (item.adminOnly && !admin) continue; // hide from public
      const raw = getByHeader(rec, item.header);
      if (raw != null && String(raw).trim() !== "") {
        pairs.push({ label: item.label, value: String(raw) });
      }
    }
    return renderLabelValueList(pairs, query);
  }

  return `<p class="muted">No information.</p>`;
}

function openModalForRecord(recRaw, pushHash = true) {
  const n = normalizeRecord(recRaw);

  // Title + meta
  modalTitle.textContent = n.title;
  const parts = [];
  if (n.date) parts.push(`📅 ${escapeHTML(n.date)}`);
  if (n.type) parts.push(`🏷️ ${escapeHTML(n.type)}`);
  modalMeta.innerHTML = parts.join(" &nbsp;•&nbsp; ") || "";

  // Map config titles to the three containers present in HTML
  const containers = { "Overview": modalDetails, "Rules": modalRules, "Procedures": modalProcedures };
  MODAL_CONFIG.forEach(section => {
    const target = containers[section.title];
    if (!target) return; // skip sections without containers
    target.innerHTML = buildSectionHTML(recRaw, section, currentQuery);
  });

  // Show modal + preserve ?admin=1 in URL
  lastFocus = document.activeElement;
  modalEl.hidden = false;
  document.body.style.overflow = "hidden";
  if (pushHash) {
    history.pushState({ id: n.id }, "", location.pathname + location.search + "#" + n.id);
  }
  modalCloseBtn?.focus();
}

function closeModal() {
  modalEl.hidden = true;
  document.body.style.overflow = "";
  if (location.hash) history.pushState({}, "", location.pathname + location.search); // keep ?admin=1
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
}

modalCloseBtn?.addEventListener("click", closeModal);
modalEl?.addEventListener("click", (e) => {
  if (e.target.matches(".modal__backdrop") || e.target.dataset.close === "backdrop") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (!modalEl?.hidden && e.key === "Escape") closeModal();
});
window.addEventListener("hashchange", () => {
  const id = location.hash.replace(/^#/, "");
  if (!id) { if (!modalEl.hidden) closeModal(); return; }
  const rec = findRecordById(id);
  if (rec) openModalForRecord(rec, /*pushHash*/ false);
});

/* ================================================
   Controls: search, filters, pagination, fuzzy toggle
================================================ */
function debounce(fn, ms=200) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
searchEl.addEventListener("input", debounce((e) => { currentQuery = e.target.value; applyFilters(); }));
roleEl.addEventListener("change", (e) => { currentRole = e.target.value; applyFilters(); });
pageSizeEl.addEventListener("change", (e) => { pageSize = parseInt(e.target.value, 10) || 10; currentPage = 1; render(); });
prevBtn.addEventListener("click", () => { currentPage = Math.max(1, currentPage - 1); render(); });
nextBtn.addEventListener("click", () => { currentPage += 1; render(); });
fuzzyToggle.addEventListener("change", (e) => { fuzzyEnabled = e.target.checked; applyFilters(); });

/* ================================================
   Contact + CTA (existing)
================================================ */
document.getElementById("contact-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  const formData = { name: this.name.value, email: this.email.value, message: this.message.value };
  try {
    const res = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(formData) });
    const data = await res.json();
    document.getElementById("response-msg").textContent = data.message;
  } catch (err) {
    document.getElementById("response-msg").textContent = "Something went wrong!";
    console.error("Error submitting contact:", err);
  }
});
document.getElementById("cta-button").addEventListener("click", () => {
  alert("Welcome aboard! Let's build your starry website ⭐️");
});

/* ================================================
   Boot
================================================ */
loadCSVFile();
