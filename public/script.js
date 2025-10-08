// === GOOGLE SHEETS (Published CSV) CONFIG ===
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTW0dfyxzzttB8ukYBZS8UygpXaRllwKctevJKB4-6mSFst21f36MEBbKa5pHhur5eUFRfr84UfcuGa/pub?gid=0&single=true&output=csv";

const CSV_FETCH_OPTS = { cache: "no-store" };
function withCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set("_cb", Date.now().toString());
  return u.toString();
}

/* ---------------------------
   Robust CSV parser (handles quoted newlines)
---------------------------- */
function parseCSV(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

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

/* ---------------------------
   Fuzzy helpers
---------------------------- */
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
  const text = `${rec.name} ${rec.role} ${rec.message}`.toLowerCase();
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

/* ---------------------------
   Plain text highlighter (name/role)
---------------------------- */
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

/* ---------------------------
   Safe HTML + HTML-aware highlighting (message / modal fields)
---------------------------- */
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
          node.removeChild(child);
          return;
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
            node.removeChild(child);
            return;
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

/* ---------------------------
   Date helpers + case-insensitive field access
---------------------------- */
function getFieldCI(obj, candidates) {
  const map = Object.keys(obj).reduce((m, k) => (m[k.toLowerCase()] = obj[k], m), {});
  for (const c of candidates) {
    const v = map[c.toLowerCase()];
    if (v != null && v !== "") return String(v);
  }
  return "";
}
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

/* ---------------------------
   State & DOM refs
---------------------------- */
let allRecords = [];
let filtered = [];
let currentPage = 1;
let pageSize = 10;
let currentRole = "";
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

/* ---------------------------
   Fetch + init
---------------------------- */
async function loadCSVFile() {
  try {
    const res = await fetch(withCacheBuster(SHEET_CSV_URL), CSV_FETCH_OPTS);
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    const text = await res.text();
    allRecords = parseCSV(text);

    // Build role dropdown (or competition type, etc.)
    const roles = [...new Set(allRecords.map(r => r.role).filter(Boolean))].sort();
    roleEl.innerHTML = '<option value="">All roles</option>';
    roles.forEach(r => { const opt = document.createElement("option"); opt.value = r; opt.textContent = r; roleEl.appendChild(opt); });

    applyFilters();

    // Open deep link if present (#<id>)
    const hashId = location.hash.replace(/^#/, "");
    if (hashId) {
      const rec = findRecordById(hashId);
      if (rec) openModalForRecord(rec);
    }
  } catch (err) {
    console.error("Failed to load Google Sheet CSV:", err);
    listEl.innerHTML = `<li style="color:#b91c1c">Failed to load data. Check your Sheet URL or publish settings.</li>`;
  }
}

/* ---------------------------
   Filtering + Searching
---------------------------- */
function applyFilters() {
  const q = currentQuery.trim().toLowerCase();

  let temp = currentRole
    ? allRecords.filter(r => (r.role || "").toLowerCase() === currentRole.toLowerCase())
    : [...allRecords];

  if (!q) {
    filtered = temp;
  } else if (!fuzzyEnabled) {
    filtered = temp.filter(r => Object.values(r).some(val => (val || "").toLowerCase().includes(q)));
  } else {
    const scored = temp.map(rec => ({ rec, s: scoreRecord(rec, q) }))
                       .filter(x => x.s.score > 0)
                       .sort((a,b)=> b.s.score - a.s.score);
    filtered = scored.map(x => ({ ...x.rec, __fuzzy: x.s.fuzzy }));
  }

  currentPage = 1;
  render();
}

/* ---------------------------
   Rendering (with pagination)
---------------------------- */
function render() {
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.min(currentPage, pages);

  const start = (currentPage - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  listEl.innerHTML = "";
  for (const rec of slice) {
    const fuzzyTag = rec.__fuzzy ? '<span class="badge fuzzy" title="Approximate match">≈ fuzzy</span>' : "";
    const name = highlightExact(rec.name || rec.title || "Untitled", currentQuery);
    const role = highlightExact(rec.role || rec.type || "", currentQuery);

    // message preview
    const raw = rec.message || rec.overview || "";
    const decoded = decodeEntities(raw);
    const withBreaks = normalizeMultilinePlainText(decoded);
    const safeMsg = sanitizeBasicHTML(withBreaks);
    const msg = highlightHTML(safeMsg, currentQuery);

    // date logic
    const dateStr = getFieldCI(rec, ["date", "competition_date", "comp_date", "event_date", "Date"]);
    const eventDate = parseCompetitionDate(dateStr);
    const past = isPastDate(eventDate);
    const playedBadge = past ? '<span class="badge past" title="Completed">Played</span>' : "";

    // id/slug (needed for deep-link + modal)
    const id = getFieldCI(rec, ["id", "slug", "uid"]) || makeSlug(rec.name || rec.title || "item");

    const li = document.createElement("li");
    if (past) li.classList.add("is-past");
    li.dataset.id = id;

    li.innerHTML = `
      <div class="entry-top">
        <div>
          <strong>${name}</strong>
          <span class="entry-role">— ${role}</span>
        </div>
        <div class="badges">
          <span class="badge secondary">CSV</span>
          ${playedBadge}
          ${fuzzyTag}
        </div>
      </div>
      ${eventDate ? `<div class="muted" style="margin-top:.25rem;">${escapeHTML(dateStr)}</div>` : ""}
      <div class="entry-msg">${msg}</div>
      <div style="margin-top:.6rem;">
        <button class="view-btn" data-view="${id}" aria-label="View details for ${escapeHTML(rec.name || rec.title || "item")}">View details</button>
      </div>
    `;
    listEl.appendChild(li);
  }

  resultCount.textContent = `${total} result${total === 1 ? "" : "s"}`;
  pageInfo.textContent = `Page ${currentPage} / ${pages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= pages;
  fuzzyHint.textContent = fuzzyEnabled ? "Fuzzy search on: results include approximate matches. Exact hits are highlighted." : "";

  // wire detail buttons
  listEl.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-view");
      const rec = findRecordById(id);
      if (rec) openModalForRecord(rec);
    });
  });
}

function makeSlug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0,80) || "item";
}

/* ---------------------------
   Modal: open/close, populate, deep-link
---------------------------- */
const modalEl = document.getElementById("record-modal");
const modalCloseBtn = document.getElementById("modal-close");
const modalTitle = document.getElementById("modal-title");
const modalMeta = document.getElementById("modal-meta");
const modalDetails = document.getElementById("modal-details");
const modalRules = document.getElementById("modal-rules");
const modalProcedures = document.getElementById("modal-procedures");

let lastFocus = null;

function findRecordById(id) {
  if (!id) return null;
  // try id/slug/uid columns; else match our generated slug from name/title
  return allRecords.find(r => {
    const rid = getFieldCI(r, ["id", "slug", "uid"]);
    if (rid && rid === id) return true;
    const alt = makeSlug(r.name || r.title || "item");
    return alt === id;
  }) || null;
}

function openModalForRecord(rec) {
  // title
  const title = rec.name || rec.title || "Details";
  modalTitle.textContent = title;

  // meta (date, location, type)
  const dateStr = getFieldCI(rec, ["date", "competition_date", "comp_date", "event_date"]);
  const location = getFieldCI(rec, ["location", "course", "venue"]);
  const type = getFieldCI(rec, ["role", "type", "category"]);
  const metaParts = [];
  if (dateStr) metaParts.push(`📅 ${escapeHTML(dateStr)}`);
  if (location) metaParts.push(`📍 ${escapeHTML(location)}`);
  if (type) metaParts.push(`🏷️ ${escapeHTML(type)}`);
  modalMeta.innerHTML = metaParts.join(" &nbsp;•&nbsp; ") || "";

  // content fields (may contain HTML)
  const decodedDetails = decodeEntities(getFieldCI(rec, ["details", "overview", "description"]));
  const decodedRules = decodeEntities(getFieldCI(rec, ["rules", "competition_rules"]));
  const decodedProcedures = decodeEntities(getFieldCI(rec, ["procedures", "procedure", "how_to_enter"]));

  const detailsHTML = sanitizeBasicHTML(normalizeMultilinePlainText(decodedDetails));
  const rulesHTML = sanitizeBasicHTML(normalizeMultilinePlainText(decodedRules));
  const proceduresHTML = sanitizeBasicHTML(normalizeMultilinePlainText(decodedProcedures));

  modalDetails.innerHTML = detailsHTML || "<em class='muted'>No details.</em>";
  modalRules.innerHTML = rulesHTML || "<em class='muted'>No rules.</em>";
  modalProcedures.innerHTML = proceduresHTML || "<em class='muted'>No procedures.</em>";

  // show modal
  lastFocus = document.activeElement;
  modalEl.hidden = false;
  document.body.style.overflow = "hidden";

  // set hash (deep-link)
  const id = getFieldCI(rec, ["id", "slug", "uid"]) || makeSlug(rec.name || rec.title || "item");
  history.pushState({ id }, "", "#" + id);

  // focus trap (simple): focus close button
  modalCloseBtn.focus();
}

function closeModal() {
  modalEl.hidden = true;
  document.body.style.overflow = "";
  // clear hash if it matches an id
  if (location.hash) history.pushState({}, "", location.pathname + location.search);
  // restore focus
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
}

modalCloseBtn.addEventListener("click", closeModal);
modalEl.addEventListener("click", (e) => {
  if (e.target.matches(".modal__backdrop") || e.target.dataset.close === "backdrop") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (!modalEl.hidden && e.key === "Escape") closeModal();
});

// Open modal if user navigates to a hash (back/forward or manual)
window.addEventListener("hashchange", () => {
  const id = location.hash.replace(/^#/, "");
  if (!id) { if (!modalEl.hidden) closeModal(); return; }
  const rec = findRecordById(id);
  if (rec) openModalForRecord(rec);
});

/* ---------------------------
   Pagination + controls
---------------------------- */
function debounce(fn, ms=200) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
searchEl.addEventListener("input", debounce((e) => { currentQuery = e.target.value; applyFilters(); }));
roleEl.addEventListener("change", (e) => { currentRole = e.target.value; applyFilters(); });
pageSizeEl.addEventListener("change", (e) => { pageSize = parseInt(e.target.value, 10) || 10; currentPage = 1; render(); });
prevBtn.addEventListener("click", () => { currentPage = Math.max(1, currentPage - 1); render(); });
nextBtn.addEventListener("click", () => { currentPage += 1; render(); });
fuzzyToggle.addEventListener("change", (e) => { fuzzyEnabled = e.target.checked; applyFilters(); });

/* ---------------------------
   Contact + CTA (existing)
---------------------------- */
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
document.getElementById("cta-button").addEventListener("click", () => { alert("Welcome aboard! Let's build your starry website ⭐️"); });

/* ---------------------------
   Boot
---------------------------- */
loadCSVFile();
