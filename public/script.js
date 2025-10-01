// === GOOGLE SHEETS (Published CSV) CONFIG ===
const SHEET_CSV_URL =
  // "https://docs.google.com/spreadsheets/d/<<SHEET_ID>>/export?format=csv&gid=<<GID>>";
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
        // Escaped quote "" -> a single "
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        // End of quoted section
        inQuotes = false;
        i++;
        continue;
      }
      // Any character (including \n) inside quotes is literal
      field += ch;
      i++;
      continue;
    }

    // Not in quotes
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Handle CRLF or lone CR
      if (csv[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush last field/row if any
  if (inQuotes) {
    // Malformed CSV (unterminated quote) — still push what we have
    inQuotes = false;
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
   Highlight helper (exact hits for plain text)
   Used for name/role fields.
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
   Safe HTML + HTML-aware highlighting for message
   (allows class on whitelisted tags, and safe <a href>)
---------------------------- */

// Allowed tags (allow only class attribute globally + special href for <a>)
const ALLOWED_TAGS = new Set(["P", "BR", "B", "I", "EM", "STRONG", "A", "SPAN"]);

// Validate http/https URL
function isSafeHttpUrl(url) {
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Sanitize "class" value: keep simple tokens (letters/numbers/_/-), drop others
function sanitizeClassValue(raw) {
  if (!raw) return "";
  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => /^[A-Za-z0-9_-]{1,64}$/.test(t));
  return tokens.join(" ");
}

// Decode &lt; &gt; &amp; etc. from CSV before sanitizing
function decodeEntities(str) {
  if (!str) return "";
  const el = document.createElement("textarea");
  el.innerHTML = str;
  return el.value;
}

// If a cell has no HTML tags, convert newlines to <br> so they render
function normalizeMultilinePlainText(str) {
  if (!str) return "";
  // If it looks like HTML already, don't touch it
  if (/[<][a-zA-Z]/.test(str)) return str;
  return str.replace(/\r?\n/g, "<br>");
}

// Sanitize: keep only allowed tags; keep only class (sanitized);
// for <a> also keep vetted href + add rel/target; unwrap disallowed tags.
function sanitizeBasicHTML(input) {
  if (!input) return "";
  const root = document.createElement("div");
  root.innerHTML = input;

  (function sanitize(node) {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toUpperCase();

        if (!ALLOWED_TAGS.has(tag)) {
          // unwrap element (preserve children, drop the element)
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }

        // Capture whitelisted attributes before strip
        const rawClass = child.getAttribute("class") || "";
        const cleanClass = sanitizeClassValue(rawClass);

        if (tag === "A") {
          const href = child.getAttribute("href") || "";
          // strip everything
          [...child.attributes].forEach((a) => child.removeAttribute(a.name));

          if (isSafeHttpUrl(href)) {
            child.setAttribute("href", href);
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noopener noreferrer");
          } else {
            // unsafe/missing href -> unwrap link entirely
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
            return;
          }

          if (cleanClass) child.setAttribute("class", cleanClass);
        } else {
          // Non-<a> allowed tags: strip everything, then restore class if present
          [...child.attributes].forEach((a) => child.removeAttribute(a.name));
          if (cleanClass) child.setAttribute("class", cleanClass);
        }

        // Recurse into children
        sanitize(child);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        node.removeChild(child);
      }
      // text nodes are fine
    });
  })(root);

  return root.innerHTML;
}

// Highlight matches inside TEXT nodes only, preserving HTML structure
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function highlightHTML(html, query) {
  if (!query || !query.trim()) return html;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return html;

  const rx = new RegExp("(" + tokens.map(escapeRegex).join("|") + ")", "gi");
  const container = document.createElement("div");
  container.innerHTML = html;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  textNodes.forEach((txt) => {
    const val = txt.nodeValue;
    if (!rx.test(val)) return;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    val.replace(rx, (m, _g1, idx) => {
      if (idx > lastIndex) frag.appendChild(document.createTextNode(val.slice(lastIndex, idx)));
      const mark = document.createElement("mark");
      mark.textContent = m;
      frag.appendChild(mark);
      lastIndex = idx + m.length;
    });
    if (lastIndex < val.length) frag.appendChild(document.createTextNode(val.slice(lastIndex)));
    txt.parentNode.replaceChild(frag, txt);
  });

  return container.innerHTML;
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
const fuzzyToggle = document.getElementById("fuzzy-hint") ? document.getElementById("fuzzy-toggle") : document.getElementById("fuzzy-toggle"); // keep existing wiring
const fuzzyHint = document.getElementById("fuzzy-hint");

/* ---------------------------
   Fetch + init
---------------------------- */
async function loadCSVFile() {
  try {
    const res = await fetch(withCacheBuster(SHEET_CSV_URL), CSV_FETCH_OPTS);
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    const text = await res.text();

    // Parse CSV robustly (preserves multi-line cells)
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

    // Message from sheet:
    // 1) decode entities (if CSV escaped as &lt;p&gt;)
    // 2) if plain text (no tags), convert newlines to <br> to preserve line breaks
    // 3) sanitize allowed tags/attrs
    // 4) highlight inside text nodes
    const raw = rec.message || "";
    const decoded = decodeEntities(raw);
    const withBreaks = normalizeMultilinePlainText(decoded);
    const safeMsg = sanitizeBasicHTML(withBreaks);
    const msg = highlightHTML(safeMsg, currentQuery);

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
  if (fuzzyHint) {
    fuzzyHint.textContent = fuzzyEnabled
      ? "Fuzzy search on: results include approximate matches. Exact hits are highlighted."
      : "";
  }
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

const fuzzyToggle = document.getElementById("fuzzy-toggle");
if (fuzzyToggle) {
  fuzzyToggle.addEventListener("change", (e) => {
    fuzzyEnabled = e.target.checked;
    applyFilters();
  });
}

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
