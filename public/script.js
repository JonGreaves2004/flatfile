// Handle contact form submission
document.getElementById("contact-form").addEventListener("submit", async function (e) {
  e.preventDefault();

  const formData = {
    name: this.name.value,
    email: this.email.value,
    message: this.message.value
  };

  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(formData)
    });

    const data = await res.json();
    document.getElementById("response-msg").textContent = data.message;
  } catch (err) {
    document.getElementById("response-msg").textContent = "Something went wrong!";
    console.error("Error submitting contact:", err);
  }
});

// Load the data.txt and display it
async function loadTextFile() {
  try {
    const res = await fetch("/data.txt");
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);

    const list = document.getElementById("data-list");
    lines.forEach(line => {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load data.txt:", err);
  }
}

loadTextFile();

// CTA button example
document.getElementById("cta-button").addEventListener("click", () => {
  alert("Welcome aboard! Let's build your starry website ⭐️");
});
