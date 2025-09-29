// Convert CSV string to an array of objects
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

async function loadCSVFile() {
  try {
    const res = await fetch("/data.txt");
    const text = await res.text();
    const records = parseCSV(text);

    const list = document.getElementById("data-list");
    list.innerHTML = ""; // Clear previous

    records.forEach(record => {
      const li = document.createElement("li");
      li.innerHTML = `
        <strong>${record.name}</strong> — ${record.role}<br/>
        <em>${record.message}</em>
      `;
      list.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load CSV:", err);
  }
}

loadCSVFile();
