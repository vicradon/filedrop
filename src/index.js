// Drop: a tiny cl1p-style file/text dropper on Cloudflare Workers + R2.
// Visit /<name>. Empty? Upload a file or paste text. Taken? View / download it.

const TTLS = { "1h": 3600, "1d": 86400, "7d": 604800 };
const MAX_BYTES = 95 * 1024 * 1024; // Workers Free/Pro request body cap is 100 MB
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let name;
    try {
      name = decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, "");
    } catch {
      return text("Bad name\n", 400);
    }
    if (!name) return page("Drop", homeBody());
    if (!NAME_RE.test(name)) return text("Names: letters, digits, . _ - (max 64)\n", 400);

    switch (req.method) {
      case "GET":
      case "HEAD":
        return handleGet(req, env, url, name);
      case "POST":
        return handleForm(req, env, name);
      case "PUT":
        return handlePut(req, env, url, name);
      case "DELETE":
        await env.DROPS.delete(name);
        return text("deleted\n");
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

async function handleGet(req, env, url, name) {
  const raw = url.searchParams.has("dl") || isCli(req);
  const head = await env.DROPS.head(name);

  if (!head || isExpired(head)) {
    if (head) await env.DROPS.delete(name);
    return raw ? text("empty\n", 404) : page(name, uploadBody(name));
  }

  const m = head.customMetadata;
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
    return new Response(req.method === "HEAD" ? null : obj.body, { headers: h });
  }

  let preview = "";
  if (m.kind === "text") preview = await (await env.DROPS.get(name)).text();
  return page(name, viewBody(name, head, preview));
}

async function handleForm(req, env, name) {
  const form = await req.formData();

  if (form.get("action") === "delete") {
    await env.DROPS.delete(name);
    return redirect(name);
  }

  const existing = await env.DROPS.head(name);
  if (existing && !isExpired(existing)) return text("That name is taken. Delete it first.\n", 409);

  const ttl = TTLS[form.get("ttl")] ?? TTLS["1d"];
  const expires = String(Date.now() + ttl * 1000);
  const file = form.get("file");

  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_BYTES) return text("File too large (max ~95 MB)\n", 413);
    await env.DROPS.put(name, file, {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { kind: "file", filename: file.name || name, expires },
    });
  } else {
    const t = String(form.get("text") || "");
    if (!t.trim()) return text("Nothing to drop\n", 400);
    await env.DROPS.put(name, t, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { kind: "text", filename: `${name}.txt`, expires },
    });
  }
  return redirect(name);
}

// curl -T file.pdf https://<worker>/<name>?ttl=1h
async function handlePut(req, env, url, name) {
  const existing = await env.DROPS.head(name);
  if (existing && !isExpired(existing)) return text("That name is taken. DELETE it first.\n", 409);

  const body = await req.arrayBuffer();
  if (!body.byteLength) return text("Empty body\n", 400);
  if (body.byteLength > MAX_BYTES) return text("File too large (max ~95 MB)\n", 413);

  const ttl = TTLS[url.searchParams.get("ttl")] ?? TTLS["1d"];
  await env.DROPS.put(name, body, {
    httpMetadata: { contentType: req.headers.get("content-type") || "application/octet-stream" },
    customMetadata: {
      kind: "file",
      filename: url.searchParams.get("filename") || name,
      expires: String(Date.now() + ttl * 1000),
    },
  });
  return text(`${url.origin}/${name}\n`, 201);
}

// ---------- helpers ----------

const isExpired = (o) => Number(o.customMetadata?.expires || 0) < Date.now();
const isCli = (req) => /curl|wget|httpie/i.test(req.headers.get("user-agent") || "");
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const redirect = (name) => new Response(null, { status: 303, headers: { Location: `/${name}` } });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtSize(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

// ---------- HTML ----------

function page(title, body) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Drop</title>
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
.zone{display:block;border:2px dashed var(--line);border-radius:12px;padding:28px 16px;text-align:center;cursor:pointer;color:var(--mute)}
.zone.over{border-color:var(--acc);color:var(--fg)}
.zone input{display:none}
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

function uploadBody(name) {
  return `<h1>/${esc(name)}</h1>
<p class="mute">Empty. Drop something here.</p>
<form class="card" id="f" method="post" enctype="multipart/form-data">
<label class="zone" id="z"><input type="file" name="file" id="file"><span id="zl">Tap to choose a file, or drag one here</span></label>
<div class="or">or paste text</div>
<textarea name="text" placeholder="Text, a link, whatever"></textarea>
<div class="row" style="margin-top:14px;justify-content:space-between">
<label class="mute">Expires in <select name="ttl"><option value="1h">1 hour</option><option value="1d" selected>1 day</option><option value="7d">7 days</option></select></label>
<button id="go">Drop it</button>
</div>
<progress id="p" max="1" value="0" hidden></progress>
</form>
<script>
var z=document.getElementById('z'),fi=document.getElementById('file'),zl=document.getElementById('zl'),f=document.getElementById('f');
function show(){zl.textContent=fi.files.length?fi.files[0].name+' ('+(fi.files[0].size/1048576).toFixed(1)+' MB)':'Tap to choose a file, or drag one here'}
fi.onchange=show;
['dragenter','dragover'].forEach(function(e){z.addEventListener(e,function(ev){ev.preventDefault();z.classList.add('over')})});
['dragleave','drop'].forEach(function(e){z.addEventListener(e,function(ev){ev.preventDefault();z.classList.remove('over')})});
z.addEventListener('drop',function(ev){if(ev.dataTransfer.files.length){fi.files=ev.dataTransfer.files;show()}});
f.onsubmit=function(ev){ev.preventDefault();var p=document.getElementById('p'),b=document.getElementById('go');
var x=new XMLHttpRequest();x.open('POST',location.pathname);p.hidden=false;b.disabled=true;b.textContent='Uploading…';
x.upload.onprogress=function(e){if(e.lengthComputable)p.value=e.loaded/e.total};
x.onload=function(){if(x.status<400)location.reload();else{alert(x.responseText);b.disabled=false;b.textContent='Drop it';p.hidden=true}};
x.onerror=function(){alert('Upload failed');b.disabled=false;b.textContent='Drop it'};
x.send(new FormData(f))};
</script>`;
}

function viewBody(name, head, preview) {
  const m = head.customMetadata;
  const left = fmtLeft(Number(m.expires) - Date.now());
  const content =
    m.kind === "text"
      ? `<pre id="t">${esc(preview)}</pre>
<div class="row"><button onclick="navigator.clipboard.writeText(document.getElementById('t').textContent).then(()=>this.textContent='Copied')">Copy text</button>
<a class="btn ghost" href="?dl">Raw</a></div>`
      : `<p style="margin:0 0 4px;font-weight:600;word-break:break-all">${esc(m.filename)}</p>
<p class="mute" style="margin:0 0 16px">${fmtSize(head.size)}</p>
<div class="row"><a class="btn" href="?dl">Download</a></div>`;
  return `<h1>/${esc(name)}</h1>
<p class="mute">Expires in ${left}</p>
<div class="card">${content}</div>
<div class="row" style="margin-top:16px;justify-content:space-between">
<button class="ghost" onclick="navigator.clipboard.writeText(location.href).then(()=>this.textContent='Link copied')">Copy link</button>
<form method="post" onsubmit="return confirm('Delete this drop?')"><input type="hidden" name="action" value="delete"><button class="danger">Delete</button></form>
</div>`;
}
