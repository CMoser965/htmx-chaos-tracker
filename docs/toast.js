// The only hand-written JS: render toasts for the server-sent HX-Trigger "showToast" event.
// Server responses carry:  HX-Trigger: {"showToast": {"message": "...", "level": "success"}}
document.addEventListener("showToast", (evt) => {
  const { message, level = "info" } = evt.detail || {};
  const box = document.getElementById("toasts");
  if (!box || !message) return;
  const t = document.createElement("div");
  t.className = `toast toast-${level}`;
  t.innerHTML = `<span class="hx-badge">HX-Trigger</span> `;
  t.append(document.createTextNode(message));
  box.append(t);
  setTimeout(() => t.classList.add("leaving"), 3200);
  setTimeout(() => t.remove(), 3700);
});
