const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

// API endpoint for contact form
app.post("/api/contact", (req, res) => {
  const { name, email, message } = req.body;
  console.log("Received contact:", { name, email, message });
  // Here you could store data, send an email, etc.
  res.json({ message: `Thanks for contacting us, ${name}!` });
});

// Use PORT environment variable or default 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
