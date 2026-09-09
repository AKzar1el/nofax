import { escapeHtml } from "./protocol";

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function page(title: string, body: string): Response {
  const safeTitle = escapeHtml(title);
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} · Nofax</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{width:min(92vw,38rem);box-sizing:border-box;padding:1.5rem}
.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:1rem;padding:1.25rem;box-shadow:0 .5rem 2rem color-mix(in srgb,CanvasText 8%,transparent)}
h1{font-size:1.35rem;margin:.1rem 0 .75rem}.message{white-space:pre-wrap;opacity:.8;margin-bottom:1rem}
label{display:block;font-weight:650;margin:.5rem 0}.hint{font-size:.9rem;opacity:.65}
textarea{box-sizing:border-box;width:100%;min-height:9rem;padding:.9rem;border-radius:.75rem;border:1px solid color-mix(in srgb,CanvasText 24%,transparent);font:inherit;resize:vertical}
button{width:100%;margin-top:1rem;padding:.9rem 1rem;border:0;border-radius:.75rem;font:inherit;font-weight:700;background:CanvasText;color:Canvas;cursor:pointer}
</style>
</head>
<body><main><section class="card">${body}</section></main></body>
</html>`, { status: 200, headers: SECURITY_HEADERS });
}

export function renderRefineForm({ token, title, message }: { token: string; title: string; message: string }): Response {
  const safeToken = escapeHtml(token);
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return page(title, `<h1>${safeTitle}</h1>
<p class="message">${safeMessage}</p>
<form method="post" action="/r/${safeToken}/refine">
<label for="text">What should I change?</label>
<textarea id="text" name="text" maxlength="2000" required autofocus></textarea>
<p class="hint">Type or use iPhone dictation, then send it back to the waiting agent.</p>
<button type="submit">Send refinement</button>
</form>`);
}

export function renderResultPage(title: string, message: string): Response {
  return page(title, `<h1>${escapeHtml(title)}</h1><p class="message">${escapeHtml(message)}</p>`);
}
