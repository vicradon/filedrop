// Drop: a tiny cl1p-style file/text dropper on Cloudflare Workers + R2.
// Visit /<name>. Empty? Upload a file or paste text. Taken? View / download it.

// "once" = deleted after the first download (files) or view (text); 7-day fallback if never opened.
const TTLS = { "1h": 3600, "1d": 86400, "7d": 604800, once: 604800 };
const MAX_BYTES = 95 * 1024 * 1024; // Workers Free/Pro request body cap is 100 MB
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TOTAL = 500 * 1024 * 1024; // whole bucket cap: 500 MB
const SITE = "https://drop.osinachi.me"; // public URL, used for og:image / og:url
const DESC = "Drop a file or some text at any name, open the same name on another device. No accounts, auto-expiring.";
// Link-preview bots: they get meta tags only, so they never burn a one-time drop.
const BOT_RE = /bot|crawler|spider|facebookexternalhit|whatsapp|slack|telegram|discord|linkedin|skype|embedly|preview|vkshare|pinterest/i;
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2f6fed"/><path d="M32 14c-7 10-14 18-14 26a14 14 0 0 0 28 0c0-8-7-16-14-26z" fill="#fff"/></svg>`;

import OG_PNG from "./og.png";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    let name;
    try {
      name = decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, "");
    } catch {
      return text("Bad name\n", 400);
    }
    if (name === "og.png")
      return new Response(OG_PNG, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (name === "favicon.svg" || name === "favicon.ico")
      return new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    if (BOT_RE.test(req.headers.get("user-agent") || "") && req.method === "GET")
      return page(name || "Drop", "");
    if (!name) return page("Drop", homeBody());
    if (!NAME_RE.test(name)) return text("Names: letters, digits, . _ - (max 64)\n", 400);

    switch (req.method) {
      case "GET":
      case "HEAD":
        return handleGet(req, env, ctx, url, name);
      case "POST":
        return handleForm(req, env, name);
      case "PUT":
        return handlePut(req, env, url, name);
      default:
        return text("Method not allowed\n", 405);
    }
  },

  // Hourly cleanup of expired drops (see crons in wrangler.toml).
  async scheduled(_event, env) {
    let cursor;
    do {
      const list = await env.DROPS.list({ cursor, include: ["customMetadata"] });
      const dead = list.objects.filter(isExpired).map((o) => o.key);
      if (dead.length) await env.DROPS.delete(dead);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  },
};

// ---------- handlers ----------

async function handleGet(req, env, ctx, url, name) {
  const raw = url.searchParams.has("dl") || isCli(req);
  const head = await env.DROPS.head(name);

  if (!head || isExpired(head)) {
    if (head) await env.DROPS.delete(name);
    return raw ? text("empty\n", 404) : page(name, uploadBody(name));
  }

  const m = head.customMetadata;
  const once = m.once === "1";

  // Uploader's confirmation page: never shows (or burns) the content.
  if (url.searchParams.has("sent") && !raw) return page(name, sentBody(name, head));

  if (url.searchParams.has("img") && (head.httpMetadata?.contentType || "").startsWith("image/")) {
    const obj = await env.DROPS.get(name);
    if (!obj) return text("empty\n", 404);
    return new Response(obj.body, {
      headers: { "Content-Type": head.httpMetadata.contentType, "Cache-Control": "no-store", "Content-Disposition": "inline" },
    });
  }

  if (raw) {
    const obj = await env.DROPS.get(name);
    if (!obj) return text("empty\n", 404);
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("Content-Length", String(obj.size));
    h.set(
      "Content-Disposition",
      m.kind === "text" ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(m.filename)}`
    );
    h.set("Cache-Control", "no-store");
    if (req.method === "HEAD") return new Response(null, { headers: h });
    if (!once) return new Response(obj.body, { headers: h });
    // One-time: stream it out, then delete once the transfer finishes.
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(obj.body.pipeTo(writable).then(() => env.DROPS.delete(name)));
    return new Response(readable, { headers: h });
  }

  let preview = "";
  if (m.kind === "text") {
    preview = await (await env.DROPS.get(name)).text();
    if (once) await env.DROPS.delete(name); // viewing a one-time text burns it
  }
  return page(name, viewBody(name, head, preview));
}

async function handleForm(req, env, name) {
  const form = await req.formData();

  const existing = await env.DROPS.head(name);
  if (existing && !isExpired(existing)) return taken();

  const key = form.get("ttl");
  const ttl = TTLS[key] ?? TTLS["1d"];
  const expires = String(Date.now() + ttl * 1000);
  const once = key === "once" ? "1" : "";
  const file = form.get("file");

  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_BYTES) return text("File too large (max ~95 MB)\n", 413);
    if (await isFull(env, file.size)) return full();
    await env.DROPS.put(name, file, {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { kind: "file", filename: file.name || name, expires, once },
    });
  } else {
    const t = String(form.get("text") || "");
    if (!t.trim()) return text("Nothing to drop\n", 400);
    if (await isFull(env, new TextEncoder().encode(t).byteLength)) return full();
    await env.DROPS.put(name, t, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { kind: "text", filename: `${name}.txt`, expires, once },
    });
  }
  return new Response(null, { status: 303, headers: { Location: `/${name}?sent` } });
}

// curl -T file.pdf https://<worker>/<name>?ttl=1h
async function handlePut(req, env, url, name) {
  const existing = await env.DROPS.head(name);
  if (existing && !isExpired(existing)) return taken();

  const body = await req.arrayBuffer();
  if (!body.byteLength) return text("Empty body\n", 400);
  if (body.byteLength > MAX_BYTES) return text("File too large (max ~95 MB)\n", 413);
  if (await isFull(env, body.byteLength)) return full();

  const key = url.searchParams.get("ttl");
  const ttl = TTLS[key] ?? TTLS["1d"];
  await env.DROPS.put(name, body, {
    httpMetadata: { contentType: req.headers.get("content-type") || "application/octet-stream" },
    customMetadata: {
      kind: "file",
      filename: url.searchParams.get("filename") || name,
      expires: String(Date.now() + ttl * 1000),
      once: key === "once" ? "1" : "",
    },
  });
  return text(`${url.origin}/${name}\n`, 201);
}

// ---------- helpers ----------

// Sums live drops (deleting expired ones on the way) and checks the cap.
async function isFull(env, incoming) {
  let total = 0, cursor;
  const dead = [];
  do {
    const list = await env.DROPS.list({ cursor, include: ["customMetadata"] });
    for (const o of list.objects) isExpired(o) ? dead.push(o.key) : (total += o.size);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  if (dead.length) await env.DROPS.delete(dead);
  return total + incoming > MAX_TOTAL;
}
const full = () => text("Storage full (500 MB cap). Try again once some drops expire.\n", 507);
const taken = () => text("That name is taken. Pick another one.\n", 409);

const isExpired = (o) => Number(o.customMetadata?.expires || 0) < Date.now();
const isCli = (req) => /curl|wget|httpie/i.test(req.headers.get("user-agent") || "");
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtSize(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (+n.toFixed(i ? 1 : 0) >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// File-type icon: a page outline with a colored extension badge. Self-contained on purpose:
// the browser gets this function's source via toString() (see UPLOAD_JS), so no outer references.
function fileIcon(name, type) {
  var n = String(name || ""), t = String(type || "");
  var dot = n.lastIndexOf("."), raw = dot > 0 ? n.slice(dot + 1).toLowerCase() : "", ext = "";
  for (var i = 0; i < raw.length && ext.length < 4; i++) {
    var c = raw.charAt(i);
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) ext += c; // keep only safe chars
  }
  var groups = [
    ["#e5484d", " pdf "],
    ["#2f6fed", " doc docx odt rtf pages "],
    ["#2e9d5b", " xls xlsx csv tsv ods numbers "],
    ["#e8833a", " ppt pptx odp key "],
    ["#8e5cf0", " zip rar 7z tar gz tgz bz2 xz "],
    ["#d6409f", " mp3 wav flac aac ogg m4a opus mp4 mov mkv avi webm m4v "],
    ["#0e9aa7", " js mjs ts jsx tsx json html css py rb go rs java c cpp h sh yml yaml xml sql md "],
  ];
  var color = "";
  for (var g = 0; g < groups.length; g++) {
    if (ext && groups[g][1].indexOf(" " + ext + " ") >= 0) { color = groups[g][0]; break; }
  }
  if (!color) color = t.indexOf("audio/") === 0 || t.indexOf("video/") === 0 ? "#d6409f" : "#6b7280";
  var label = (ext || "file").toUpperCase();
  return '<svg viewBox="0 0 40 48" width="40" height="48" aria-hidden="true">' +
    '<path d="M8 2h18l10 10v30a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4zM26 2v10h10" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"/>' +
    '<rect x="1" y="25" width="38" height="15" rx="3" fill="' + color + '"/>' +
    '<text x="20" y="35.7" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">' + label + '</text></svg>';
}

function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

// ---------- HTML ----------

function page(title, body) {
  const path = title === "Drop" ? "" : title;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(path ? `/${path}` : "Drop")}${path ? " · Drop" : ""}</title>
<meta name="description" content="${DESC}">
<meta name="theme-color" content="#2f6fed">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Drop">
<meta property="og:title" content="${esc(path ? `/${path} · Drop` : "Drop · quick file & text sharing")}">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${SITE}/${esc(path)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--mute:#6b6a66;--line:#e2e0da;--acc:#2f6fed;--accfg:#fff;--danger:#c23b2a}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--fg:#ecebe8;--mute:#9a9893;--line:#2e2e2c;--acc:#6d9bff;--accfg:#0d0d0d;--danger:#ff7a68}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 4px}
.mute{color:var(--mute);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:20px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=text],textarea,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
input[type=text]{flex:1;min-width:0}
textarea{width:100%;min-height:140px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:14px}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 16px;background:var(--acc);color:var(--accfg);cursor:pointer;text-decoration:none;display:inline-block}
.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.danger{background:transparent;color:var(--danger);border:1px solid var(--line)}
.zone{position:relative;display:block;border:2px dashed var(--line);border-radius:12px;padding:28px 16px;text-align:center;cursor:pointer;color:var(--mute)}
.zone.over{border-color:var(--acc);color:var(--fg)}
.zone input{display:none}
.clear{position:absolute;top:8px;right:8px;width:28px;height:28px;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--card);color:var(--mute);border:1px solid var(--line)}
.clear:hover{color:var(--danger)}
.clear[hidden]{display:none}
#ic{display:block;line-height:0;margin-bottom:10px}
#ic:empty{display:none}
.fold{display:grid;grid-template-rows:1fr;transition:grid-template-rows .25s ease,opacity .2s ease}
.fold>div{min-height:0;overflow:hidden;padding:3px;margin:-3px}
.fold.shut{grid-template-rows:0fr;opacity:0}
.fold.shut>div{visibility:hidden;transition:visibility 0s .25s}
@media (prefers-reduced-motion:reduce){.fold{transition:none}}
.or{text-align:center;color:var(--mute);font-size:13px;margin:14px 0}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:14px;max-height:60vh;overflow:auto}
progress{width:100%;height:8px;margin-top:12px}
a{color:var(--acc)}
.prefix{color:var(--mute);font-family:ui-monospace,Menlo,monospace;font-size:14px}
</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

function homeBody() {
  return `<h1>Drop</h1>
<p class="mute">Pick a name, drop a file or some text there, open the same name on another device.</p>
<div class="card">
<form class="row" onsubmit="event.preventDefault();var v=this.n.value.trim();if(v)location='/'+encodeURIComponent(v)">
<span class="prefix">${"/"}</span><input type="text" name="n" placeholder="any-name" autofocus autocapitalize="off" autocomplete="off" pattern="[A-Za-z0-9._\\-]{1,64}">
<button>Go</button>
</form>
<p class="mute" style="margin:12px 0 0">or <a href="#" onclick="location='/'+Math.random().toString(36).slice(2,8);return false">use a random name</a></p>
</div>`;
}

// Client script for the upload page. String.raw keeps backslashes (e.g. the /^image\//
// regex) intact; in a plain template literal "\/" silently becomes "/" and breaks the script.
const UPLOAD_JS = String.raw`
${fmtSize}
${fileIcon}
var z = document.getElementById('z'), fi = document.getElementById('file'),
    zl = document.getElementById('zl'), pv = document.getElementById('pv'),
    f = document.getElementById('f'), xb = document.getElementById('x'),
    ic = document.getElementById('ic'), zw = document.getElementById('zw'), dv = document.getElementById('dv'), tx = document.getElementById('tx'),
    ta = document.querySelector('textarea[name=text]');
var LABEL = 'Tap to choose, drag, or paste an image';
var isImg = function (t) { return /^image\//.test(t); };

function show() {
  var file = fi.files[0];
  xb.hidden = !file;
  sync();
  zl.textContent = file ? file.name + ' (' + fmtSize(file.size) + ')' : LABEL;
  ic.innerHTML = file && !isImg(file.type) ? fileIcon(file.name, file.type) : '';
  if (pv.src) URL.revokeObjectURL(pv.src);
  if (file && isImg(file.type)) {
    pv.src = URL.createObjectURL(file);
    pv.style.display = 'block';
  } else {
    pv.removeAttribute('src');
    pv.style.display = 'none';
  }
}
fi.onchange = show;
xb.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); fi.value = ''; show(); };

// A file wins over text. File chosen: fold away the text box. Typing: fold away the picker.
function sync() {
  var file = fi.files[0], typing = !file && ta.value.trim() !== '';
  zw.classList.toggle('shut', typing);
  tx.classList.toggle('shut', !!file);
  dv.classList.toggle('shut', typing || !!file);
}
ta.addEventListener('input', sync);

function setFile(file) {
  var dt = new DataTransfer();
  dt.items.add(file);
  fi.files = dt.files;
  show();
}

document.addEventListener('paste', function (ev) {
  var items = Array.prototype.slice.call((ev.clipboardData || {}).items || []);
  var it = items.find(function (i) { return i.kind === 'file' && isImg(i.type); });
  if (!it) return; // plain text paste goes to the textarea as usual
  ev.preventDefault();
  var b = it.getAsFile(), d = new Date();
  var p = function (n) { return String(n).padStart(2, '0'); };
  var ext = (b.type.split('/')[1] || 'png').split('+')[0].replace('jpeg', 'jpg');
  var nm = 'pasted-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext;
  setFile(new File([b], nm, { type: b.type }));
});

['dragenter', 'dragover'].forEach(function (e) {
  z.addEventListener(e, function (ev) { ev.preventDefault(); z.classList.add('over'); });
});
['dragleave', 'drop'].forEach(function (e) {
  z.addEventListener(e, function (ev) { ev.preventDefault(); z.classList.remove('over'); });
});
z.addEventListener('drop', function (ev) {
  if (ev.dataTransfer.files.length) { fi.files = ev.dataTransfer.files; show(); }
});

f.onsubmit = function (ev) {
  ev.preventDefault();
  var p = document.getElementById('p'), b = document.getElementById('go');
  var reset = function () { b.disabled = false; b.textContent = 'Drop it'; p.hidden = true; };
  var x = new XMLHttpRequest();
  x.open('POST', location.pathname);
  p.hidden = false; b.disabled = true; b.textContent = 'Uploading\u2026';
  x.upload.onprogress = function (e) { if (e.lengthComputable) p.value = e.loaded / e.total; };
  x.onload = function () {
    if (x.status < 400) location.href = location.pathname + '?sent';
    else { alert(x.responseText); reset(); }
  };
  x.onerror = function () { alert('Upload failed'); reset(); };
  x.send(new FormData(f));
};
`;

function uploadBody(name) {
  return `<h1>/${esc(name)}</h1>
<p class="mute">Empty. Drop something here.</p>
<form class="card" id="f" method="post" enctype="multipart/form-data">
<div class="fold" id="zw"><div><label class="zone" id="z"><input type="file" name="file" id="file"><img id="pv" alt="" style="display:none;max-width:100%;max-height:200px;margin:0 auto 10px;border-radius:8px"><span id="ic"></span><span id="zl">Tap to choose, drag, or paste an image</span><button type="button" class="clear" id="x" aria-label="Remove file" title="Remove" hidden><svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg></button></label></div></div>
<div class="fold" id="dv"><div><div class="or">or paste text</div></div></div>
<div class="fold" id="tx"><div><textarea name="text" placeholder="Text, a link, whatever"></textarea></div></div>
<div class="row" style="margin-top:14px;justify-content:space-between">
<label class="mute">Expires in <select name="ttl"><option value="1h">1 hour</option><option value="1d" selected>1 day</option><option value="7d">7 days</option><option value="once">After first download / view</option></select></label>
<button id="go">Drop it</button>
</div>
<progress id="p" max="1" value="0" hidden></progress>
</form>
<script>${UPLOAD_JS}</script>`;
}

function viewBody(name, head, preview) {
  const m = head.customMetadata;
  const once = m.once === "1";
  const status = once
    ? m.kind === "text"
      ? "One-time text: it has now been deleted, so copy it before leaving this page."
      : "One-time file: it gets deleted after the first download."
    : `Expires in ${fmtLeft(Number(m.expires) - Date.now())}`;
  const ct = head.httpMetadata?.contentType || "", isImg = ct.startsWith("image/");
  const content =
    m.kind === "text"
      ? `<pre id="t">${esc(preview)}</pre>
<div class="row"><button onclick="navigator.clipboard.writeText(document.getElementById('t').textContent).then(()=>this.textContent='Copied')">Copy text</button>
${once ? "" : '<a class="btn ghost" href="?dl">Raw</a>'}</div>`
      : `<div class="row" style="flex-wrap:nowrap;gap:14px;margin:0 0 16px">${isImg ? "" : `<span style="line-height:0;flex:none">${fileIcon(m.filename, ct)}</span>`}
<div style="min-width:0"><p style="margin:0 0 4px;font-weight:600;word-break:break-all">${esc(m.filename)}</p>
<p class="mute" style="margin:0">${fmtSize(head.size)}</p></div></div>
${isImg ? `<img src="?img" alt="" style="max-width:100%;border-radius:8px;margin:0 0 16px;display:block">` : ""}
<div class="row"><a class="btn" href="?dl">Download</a></div>`;
  return `<h1>/${esc(name)}</h1>
<p class="mute">${status}</p>
<div class="card">${content}</div>
${once && m.kind === "text" ? "" : copyLink()}`;
}

// Shown to the uploader right after dropping; never reveals or burns the content.
function sentBody(name, head) {
  const m = head.customMetadata;
  const what = m.kind === "text" ? "Text" : esc(m.filename);
  const note =
    m.once === "1"
      ? `It will be deleted after the first ${m.kind === "text" ? "view" : "download"} (or in 7 days if nobody opens it).`
      : `Expires in ${fmtLeft(Number(m.expires) - Date.now())}.`;
  return `<h1>/${esc(name)}</h1>
<div class="card"><p style="margin:0 0 4px;font-weight:600;word-break:break-all">${what} dropped</p>
<p class="mute" style="margin:0">${note}</p></div>
${copyLink()}`;
}

const copyLink = () => `<div class="row" style="margin-top:16px">
<button class="ghost" onclick="navigator.clipboard.writeText(location.origin+location.pathname).then(()=>this.textContent='Link copied')">Copy link</button>
</div>`;
