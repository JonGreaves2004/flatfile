// === GOOGLE SHEETS (Published CSV) CONFIG ===
const SHEET_CSV_URL =
//  "https://docs.google.com/spreadsheets/d/<<SHEET_ID>>/export?format=csv&gid=<<GID>>";
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTW0dfyxzzttB8ukYBZS8UygpXaRllwKctevJKB4-6mSFst21f36MEBbKa5pHhur5eUFRfr84UfcuGa/pub?gid=0&single=true&output=csv";

// Optional: disable browser caches for fresher reads
const CSV_FETCH_OPTS = { cache: "no-store" };

// Optional: add a cache-buster query each fetch (helps defeat intermediary caches)
function withCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set("_cb", Date.now().toString());
  return u.toString();
}



/* ---------------------------
   Utility: CSV parser w/ quotes
---------------------------- */
function parseCSV(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = splitCSVLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => (obj[h.trim()] = (values[i] ?? "").trim()));
    return obj;
  });
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Toggle quotes or escape double-quote ""
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* ---------------------------
   Fuzzy match helpers
---------------------------- */
// Basic Levenshtein distance for fuzzy scoring
function levenshtein(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // delete
        dp[i][j - 1] + 1, // insert
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // replace
      );
    }
  }
  return dp[a.length][b.length];
}

// Score a record against a query; higher is better
function scoreRecord(rec, q) {
  const text = `${rec.name} ${rec.role} ${rec.message}`.toLowerCase();
  const query = q.toLowerCase().trim();
  if (!query) return { score: 0, fuzzy: false };

  // Exact token hits: +3 each
  const tokens = query.split(/\s+/).filter(Boolean);
  let score = 0;
  let anyExact = false;

  for (const t of tokens) {
    if (text.includes(t)) {
      score += 3;
      anyExact = true;
    } else {
      // fuzzy: compare against each word-ish chunk in text; take best
      const chunks = text.split(/[^a-z0-9]+/i);
      let best = Infinity;
      for (const c of chunks) {
        if (!c) continue;
        const d = levenshtein(t, c);
        if (d < best) best = d;
      }
      // Reward near matches (distance 1–2) modestly
      if (best === 1) score += 2;
      else if (best === 2) score += 1;
    }
  }
  return { score, fuzzy: !anyExact && score > 0 };
}

/* ---------------------------
   Highlight helper (exact hits)
   NOTE: We highlight exact query tokens.
   Fuzzy-only hits get a "≈ fuzzy" badge.
---------------------------- */
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
}
function highlightExact(text, query) {
  if (!query.trim()) return escapeHTML(text);
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); // escape regex chars

  if (!tokens.length) return escapeHTML(text);

  const rx = new RegExp("(" + tokens.join("|") + ")", "gi");
  return escapeHTML(text).replace(rx, (m) => `<mark>${escapeHTML(m)}</mark>`);
}

/* ---------------------------
   State
---------------------------- */
let allRecords = [];
let filtered = [];
let currentPage = 1;
let pageSize = 10;
let currentRole = "";
let currentQuery = "";
let fuzzyEnabled = false;

/* ---------------------------
   DOM refs
---------------------------- */
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

/* ---------------------------
   Fetch + init
---------------------------- */
async function loadCSVFile() {
  try {
    const res = await fetch(withCacheBuster(SHEET_CSV_URL), CSV_FETCH_OPTS);
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    const text = await res.text();

    // Uses your existing robust CSV parser
    allRecords = parseCSV(text);

    // Rebuild the role dropdown
    const roles = [...new Set(allRecords.map(r => r.role).filter(Boolean))].sort();
    roleEl.innerHTML = '<option value="">All roles</option>';
    roles.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r;
      roleEl.appendChild(opt);
    });

    applyFilters();
  } catch (err) {
    console.error("Failed to load Google Sheet CSV:", err);
    // graceful UI message (optional)
    listEl.innerHTML = `<li style="color:#b91c1c">Failed to load data. Check your Sheet URL or publish settings.</li>`;
  }
}


/* ---------------------------
   Filtering + Searching
---------------------------- */
function applyFilters() {
  const q = currentQuery.trim().toLowerCase();

  // 1) role filter
  let temp = currentRole
    ? allRecords.filter(r => (r.role || "").toLowerCase() === currentRole.toLowerCase())
    : [...allRecords];

  // 2) search (exact or fuzzy)
  if (!q) {
    filtered = temp;
  } else if (!fuzzyEnabled) {
    filtered = temp.filter(r =>
      Object.values(r).some(val => (val || "").toLowerCase().includes(q))
    );
  } else {
    // fuzzy: keep items with positive score, sort by score desc
    const scored = temp
      .map(rec => ({ rec, s: scoreRecord(rec, q) }))
      .filter(x => x.s.score > 0)
      .sort((a, b) => b.s.score - a.s.score);
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
    const name = highlightExact(rec.name || "", currentQuery);
    const role = highlightExact(rec.role || "", currentQuery);
    const msg  = highlightExact(rec.message || "", currentQuery);

    const li = document.createElement("li");
    li.innerHTML = `
      <div class="entry-top">
        <div>
          <strong>${name}</strong>
          <span class="entry-role">— ${role}</span>
        </div>
        <div class="badges">
          <span class="badge secondary">CSV</span>
          ${fuzzyTag}
        </div>
      </div>
      <div class="entry-msg">${msg}</div>
    `;
    listEl.appendChild(li);
  }

  // Meta + pagination controls
  resultCount.textContent = `${total} result${total === 1 ? "" : "s"}`;
  pageInfo.textContent = `Page ${currentPage} / ${pages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= pages;

  // Fuzzy hint
  fuzzyHint.textContent = fuzzyEnabled
    ? "Fuzzy search on: results include approximate matches. Exact hits are highlighted."
    : "";
}

/* ---------------------------
   Events (with debounce)
---------------------------- */
function debounce(fn, ms=200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

searchEl.addEventListener("input", debounce((e) => {
  currentQuery = e.target.value;
  applyFilters();
}));

roleEl.addEventListener("change", (e) => {
  currentRole = e.target.value;
  applyFilters();
});

pageSizeEl.addEventListener("change", (e) => {
  pageSize = parseInt(e.target.value, 10) || 10;
  currentPage = 1;
  render();
});

prevBtn.addEventListener("click", () => {
  currentPage = Math.max(1, currentPage - 1);
  render();
});
nextBtn.addEventListener("click", () => {
  currentPage += 1;
  render();
});

fuzzyToggle.addEventListener("change", (e) => {
  fuzzyEnabled = e.target.checked;
  applyFilters();
});

/* ---------------------------
   Contact + CTA (existing)
---------------------------- */
document.getElementById("contact-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  const formData = { name: this.name.value, email: this.email.value, message: this.message.value };

  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData)
    });
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

/* ---------------------------
   Boot
---------------------------- */
loadCSVFile();
