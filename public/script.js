let allRecords = []; // Store parsed data globally

function parseCSV(csv) {
  const [headerLine, ...lines] = csv.trim().split("\n");
  const headers = headerLine.split(",");

  return lines.map(line => {
    const values = line.split(",");
    const entry = {};
    headers.forEach((header, idx) => {
      entry[header.trim()] = values[idx].trim();
    });
    return entry;
  });
}

function renderList(records) {
  const list = document.getElementById("data-list");
  list.innerHTML = "";

  records.forEach(record => {
    const li = document.createElement("li");
    li.innerHTML = `
      <strong>${record.name}</strong> — ${record.role}<br/>
      <em>${record.message}</em>
    `;
    list.appendChild(li);
  });
}

async function loadCSVFile() {
  try {
    const res = await fetch("/data.txt");
    const text = await res.text();
    allRecords = parseCSV(text);
    renderList(allRecords);
  } catch (err) {
    console.error("Failed to load CSV:", err);
  }
}

// Filter handler
document.getElementById("search-input").addEventListener("input", function () {
  const query = this.value.toLowerCase();
  const filtered = allRecords.filter(record =>
    Object.values(record).some(val =>
      val.toLowerCase().includes(query)
    )
  );
  renderList(filtered);
});

loadCSVFile();
