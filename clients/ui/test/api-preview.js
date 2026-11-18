// Isolated visual fixture only; never bundled into native apps.
import '../app.js';
let attempts = 0;
const ready = setInterval(() => {
  const button = document.querySelector('[data-action="api-docs"]');
  if (button) { clearInterval(ready); button.click(); }
  if (++attempts >= 100) clearInterval(ready);
}, 30);
