// === GOOGLE SHEETS (Published CSV) CONFIG ===
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTW0dfyxzzttB8ukYBZS8UygpXaRllwKctevJKB4-6mSFst21f36MEBbKa5pHhur5eUFRfr84UfcuGa/pub?gid=0&single=true&output=csv";

const CSV_FETCH_OPTS = { cache: "no-store" };
function withCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set("_cb", Date.now().toString());
  return u.toString();
}

/* -------------------------------------------------
   Robust CSV parser (handles quoted newlines, quotes)
-------------------------------------------------- */
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
        if (csv[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue; // end quotes
      }
      field += ch; i++; continue; // literal (incl. \n)
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

/* -------------------------------------------------
   FIELD MAP for your sheet (case-insensitive)
-------------------------------------------------- */
const FIELD_MAP = {
  id:            ["id", "uid", "slug", "competition_id"],
  title:         ["Comp name"],
  date:          ["Date"],
  type:          ["Comp format (scoring type)", "Comp format"],

  // Card preview
  overview:      ["Comp Summary", "Comp Description"],

  // Overview body in modal (fallback is composed)
  details:       ["Comp Description", "Comp Summary"],

  // Optional link column if you ever add one
  link:          ["link", "url", "website", "info_url"]
};

// These are the exact headers you shared, paired with reader-friendly labels.
// We’ll render them as “Label: Value” lines in the modal.
const RULE_ITEMS = [
  { label:"Entrant criteria",            header:"Entrant criteria" },
  { label:"Acceptable for Handicap",     header:"Acceptable for Handicap" },
  { label:"Handicap Limit",              header:"Handicap Limit" },
  { label:"Handicap Allowance",          header:"Handicap Allowance" },
  { label:"Divisions",                   header:"Divisions" },
  { label:"Board Competition",           header:"Board Comp" },
  { label:"Criteria for Prizewinners",   header:"Criteria for Prizewinners" },
  { label:"2's competition",             header:"2's comp" },
  { label:"Merit Shield Contributor",    header:"Merit Shield Contributer" },
  { label:"Trophy",                      header:"Trophy" }
];

const PROCEDURE_ITEMS = [
  { label:"Start Sheet",                 header:"Start Sheet" },
  { label:"1st & last tee times",       header:"1st & last tee times" },
  { label:"Players per time",           header:"Players per time" },
  { label:"Interval",                   header:"Interval (10 Mins)" },
  { label:"Booking options enabled",    header:"Enable booking options" },
  { label:"Booking window",             header:"Enabled from and to" },
  { label:"Zones for drawn comps",      header:"Zones for drawn comps" },
  { label:"Sign in enabled",            header:"Enable Sign in" },
  { label:"Sign in options",            header:"Sign in options" },
  { label:"Sign in times",              header:"From and to times" }, // appears twice in your headers, we’ll show once here
  { label:"Sign In Message",            header:"Sign In Message" },
  { label:"Charges enabled",            header:"Enable Charges" },
  { label:"Member Fee",                 header:"Member Fee" },
  { label:"When to charge",             header:"When to charge" },
  { label:"Refund options",             header:"Refund options" },
  { label:"Score entry",                header:"Score entry" },
  { label:"Leaderboard",                header:"Leaderboard" },
  { label:"Sweep breakdown",            header:"Sweep breakdown" },
  { label:"Course Cards",               header:"Course Cards" }
];

/* -------------------------------------------------
   Case-insensitive field helpers
-------------------------------------------------- */
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

// Get a raw value by the exact header text (case-insensitive)
function getByHeader(rec, header) {
  if (!header) return "";
  const lc = buildLc(rec);
  return lc[header.toLowerCase()] ?? "";
}

/* -------------------------------------------------
   Build composed blocks & normalized record
-------------------------------------------------- */
function composeLabeledBlock(rec, labels) {
  const parts = [];
  for (const item of labels) {
    const val = getByHeader(rec, item.header);
    if (!val) continue;
    parts.push(`<p><strong>${item.label}:</strong> ${val}</p>`);
  }
  return parts.join("");
}

function normalizeRecord(rec) {
  const id    = getField(rec, "id") || makeSlug(getField(rec, "title") || "competition");
  const title = getField(rec, "title") || "Untitled competition";
  const date  = getField(rec, "date");
  const type  = getField(rec, "type");
  const overview = getField(rec, "overview");

  // Overview (modal): prefer “details”; else compose from summary/description
  let details = getField(rec, "details");
  if (!details) {
    details = composeLabeledBlock(rec, [
      { label:"Summary",     header:"Comp Summary" },
      { label:"Description", header:"Comp Description" }
    ]);
  }

  const link = getField(rec, "link");
  return { id, title, date, type, overview, details, link, __raw: rec };
}

/* -------------------------------------------------
   Fuzzy helpers
-------------------------------------------------- */
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
  const text = `${n.title} ${n.type} ${n.overview} ${n.details}`.toLowerCase();
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

/* -------------------------------------------------
   Plain text highlighter (name/type)
-------------------------------------------------- */
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

/* -------------------------------------------------
   Safe HTML + HTML-aware highlighting (content)
   - allows class on whitelisted tags
   - <a> only with http/https + target/rel
   - supports <span>
-------------------------------------------------- */
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

/* -------------------------------------------------
   Date helpers
-------------------------------------------------- */
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

/* -------------------------------------------------
   Utilities
-------------------------------------------------- */
function makeSlug(s) {
  return (s || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0,80) || "item";
}

// Build label:value pairs from an item list and a raw record
function buildPairs(recRaw, items) {
  const pairs = [];
  for (const { label, header } of items) {
    const val = getByHeader(recRaw, header);
    if (val != null && String(val).trim() !== "") {
      pairs.push({ label, value: String(val) });
    }
  }
  return pairs;
}

// Render pairs as a simple list: <li><strong>Label:</strong> Value</li>
// Value supports basic HTML via sanitize pipeline.
function renderLabelValueList(pairs, currentQuery) {
  if (!pairs.length) return `<p class="muted">No information.</p>`;
  const items = pairs.map(({ label, value }) => {
    const valHTML = highlightHTML(
      sanitizeBasicHTML(normalizeMultilinePlainText(decodeEntities(value))),
      currentQuery
    );
    return `<li><strong>${escapeHTML(label)}:</strong> <span class="kv-value">${valHTML}</span></li>`;
  }).join("");
  return `<ul class="kv-list">${items}</ul>`;
}

/* -------------------------------------------------
   State & DOM refs
-------------------------------------------------- */
let allRecords = [];
let filtered = [];
let currentPage = 1;
let pageSize = 10;
let currentRole = ""; // actually "type" in your data
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

// Modal refs
const modalEl = document.getElementById("record-modal");
const modalCloseBtn = document.getElementById("modal-close");
const modalTitle = document.getElementById("modal-title");
const modalMeta = document.getElementById("modal-meta");
const modalDetails = document.getElementById("modal-details");
const modalRules = document.getElementById("modal-rules");
const modalProcedures = document.getElementById("modal-procedures");
let lastFocus = null;

/* -------------------------------------------------
   Fetch + init
-------------------------------------------------- */
async function loadCSVFile() {
  try {
    const res = await fetch(withCacheBuster(SHEET_CSV_URL), CSV_FETCH_OPTS);
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    const text = await res.text();
    allRecords = parseCSV(text);

    // Build the type/category dropdown from your data
    const roles = [...new Set(allRecords
      .map(r => (getField(r, "type") || "").trim())
      .filter(Boolean))].sort();
    roleEl.innerHTML = '<option value="">All types</option>';
    roles.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r;
      roleEl.appendChild(opt);
    });

    applyFilters();

    // Open deep link if present
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

/* -------------------------------------------------
   Filtering + Searching
-------------------------------------------------- */
function applyFilters() {
  const q = currentQuery.trim().toLowerCase();

  // Filter by "type"
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

/* -------------------------------------------------
   Rendering (with pagination)
-------------------------------------------------- */
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

    // Overview preview (HTML or plain text)
    const decoded = decodeEntities(recN.overview || "");
    const withBreaks = normalizeMultilinePlainText(decoded);
    const safeMsg = sanitizeBasicHTML(withBreaks);
    const msg = highlightHTML(safeMsg, currentQuery);

    // Date & past dimming
    const eventDate = parseCompetitionDate(recN.date);
    const past = isPastDate(eventDate);
    const playedBadge = past ? '<span class="badge past" title="Completed">Played</span>' : "";

    // Optional link badge
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

  // Wire detail buttons
  listEl.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-view");
      const rec = findRecordById(id);
      if (rec) openModalForRecord(rec);
    });
  });
}

/* -------------------------------------------------
   Modal: open/close, populate, deep-link
-------------------------------------------------- */
function findRecordById(id) {
  if (!id) return null;
  let hit = allRecords.find(r => getField(r, "id") === id);
  if (hit) return hit;
  return allRecords.find(r => makeSlug(getField(r, "title") || "competition") === id) || null;
}

function openModalForRecord(recRaw) {
  const rec = normalizeRecord(recRaw);

  // Title + meta
  modalTitle.textContent = rec.title;
  const parts = [];
  if (rec.date) parts.push(`📅 ${escapeHTML(rec.date)}`);
  if (rec.type) parts.push(`🏷️ ${escapeHTML(rec.type)}`);
  modalMeta.innerHTML = parts.join(" &nbsp;•&nbsp; ") || "";

  // OVERVIEW (rich text)
  const overviewHTML = sanitizeBasicHTML(normalizeMultilinePlainText(decodeEntities(rec.details || "")));
  modalDetails.innerHTML = overviewHTML || "<em class='muted'>No overview.</em>";

  // RULES (Label: Value list)
  const rulePairs = buildPairs(rec.__raw, RULE_ITEMS);
  modalRules.innerHTML = renderLabelValueList(rulePairs, currentQuery);

  // PROCEDURES (Label: Value list)
  const procPairs = buildPairs(rec.__raw, PROCEDURE_ITEMS);
  modalProcedures.innerHTML = renderLabelValueList(procPairs, currentQuery);

  // Show modal + deep link
  lastFocus = document.activeElement;
  modalEl.hidden = false;
  document.body.style.overflow = "hidden";
  history.pushState({ id: rec.id }, "", "#" + rec.id);
  document.getElementById("modal-close").focus();
}

function closeModal() {
  modalEl.hidden = true;
  document.body.style.overflow = "";
  if (location.hash) history.pushState({}, "", location.pathname + location.search);
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
}

document.getElementById("modal-close")?.addEventListener("click", closeModal);
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
  if (rec) openModalForRecord(rec);
});

/* -------------------------------------------------
   Controls: search, filters, pagination, fuzzy toggle
-------------------------------------------------- */
function debounce(fn, ms=200) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
searchEl.addEventListener("input", debounce((e) => { currentQuery = e.target.value; applyFilters(); }));
roleEl.addEventListener("change", (e) => { currentRole = e.target.value; applyFilters(); });
pageSizeEl.addEventListener("change", (e) => { pageSize = parseInt(e.target.value, 10) || 10; currentPage = 1; render(); });
prevBtn.addEventListener("click", () => { currentPage = Math.max(1, currentPage - 1); render(); });
nextBtn.addEventListener("click", () => { currentPage += 1; render(); });
fuzzyToggle.addEventListener("change", (e) => { fuzzyEnabled = e.target.checked; applyFilters(); });

/* -------------------------------------------------
   Contact + CTA (existing)
-------------------------------------------------- */
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

/* -------------------------------------------------
   Boot
-------------------------------------------------- */
loadCSVFile();
