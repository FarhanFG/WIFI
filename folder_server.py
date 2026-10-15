"""Chunked upload server — splits transfers into 1 MB pieces."""
from pathlib import Path
import shutil
import threading
import uuid

from flask import Flask, request, jsonify
from flask_cors import CORS

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "oupload"
TMP_DIR = BASE_DIR / ".upload_tmp"
UPLOAD_DIR.mkdir(exist_ok=True)
TMP_DIR.mkdir(exist_ok=True)

FOLDER_PORT = 8502
CHUNK_SIZE = 1 * 1024 * 1024  # 1 MB
_folder_server_started = False

COMMON_CSS = """
body {
  font-family: system-ui, -apple-system, sans-serif;
  margin: 0; padding: 20px;
  background: #0e1117; color: #fafafa;
}
h2 { margin: 0 0 8px; font-size: 1.25rem; }
p { color: #b0b0b0; font-size: 0.9rem; line-height: 1.4; }
.btn {
  display: block; width: 100%; box-sizing: border-box;
  margin: 12px 0; padding: 16px;
  border: 0; border-radius: 12px;
  font-size: 1.05rem; font-weight: 650; cursor: pointer;
  text-align: center;
}
.primary { background: #ff4b4b; color: #fff; }
.secondary { background: #262730; color: #fafafa; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* IMPORTANT: do NOT use display:none on file inputs — Android Chrome
   then often returns only 1 file even when multiple were selected. */
input[type=file].picker {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 12px 0;
  padding: 14px;
  border-radius: 12px;
  border: 1px dashed #555;
  background: #1a1d24;
  color: #fafafa;
}
#status {
  margin-top: 14px; padding: 12px; border-radius: 10px;
  background: #1a1d24; min-height: 1.2em; white-space: pre-wrap;
}
#fileList {
  margin-top: 10px; max-height: 220px; overflow: auto;
  padding: 10px 12px; border-radius: 10px;
  background: #1a1d24; font-size: 0.85rem; color: #c8c8c8;
  display: none;
}
#fileList.on { display: block; }
#fileList div { padding: 2px 0; border-bottom: 1px solid #2a2d36; }
.bar-wrap {
  display: none; margin-top: 12px; height: 14px;
  background: #262730; border-radius: 8px; overflow: hidden;
}
.bar-wrap.on { display: block; }
#bar {
  height: 100%; width: 0%; background: #ff4b4b;
  transition: width 0.1s linear;
}
#pct {
  display: none; margin-top: 8px; font-size: 1.4rem;
  font-weight: 700; text-align: center;
}
#pct.on { display: block; }
.ok { color: #3dd68c; }
.err { color: #ff6b6b; }
.nav a { color: #ff4b4b; margin-right: 12px; }
"""

CHUNK_JS = """
const CHUNK = 1 * 1024 * 1024; // 1 MB

function setProgress(pct, msg) {
  barWrap.classList.add("on");
  pctEl.classList.add("on");
  const p = Math.max(0, Math.min(100, pct));
  bar.style.width = p + "%";
  pctEl.textContent = p + "%";
  if (msg) status.textContent = msg;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function renderFileList(list) {
  if (!fileListEl) return;
  if (!list.length) {
    fileListEl.classList.remove("on");
    fileListEl.innerHTML = "";
    return;
  }
  fileListEl.classList.add("on");
  fileListEl.innerHTML = list.map((f, i) => {
    const label = f.webkitRelativePath || f.name;
    return "<div>" + (i + 1) + ". " + label + " (" + formatSize(f.size) + ")</div>";
  }).join("");
}

function mergeFiles(existing, incoming) {
  const map = new Map();
  for (const f of existing) {
    const key = (f.webkitRelativePath || f.name) + "::" + f.size + "::" + f.lastModified;
    map.set(key, f);
  }
  for (const f of incoming) {
    const key = (f.webkitRelativePath || f.name) + "::" + f.size + "::" + f.lastModified;
    map.set(key, f);
  }
  return Array.from(map.values());
}

async function postChunk(form, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch("/upload-chunk", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr || new Error("chunk upload failed");
}

async function uploadOneFile(file, relativePath, onPiece) {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK));
  const uploadId = (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now() + "-" + Math.random().toString(16).slice(2));
  const name = relativePath || file.name;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK;
    const blob = file.slice(start, Math.min(start + CHUNK, file.size));
    const form = new FormData();
    form.append("chunk", blob, "chunk.bin");
    form.append("upload_id", uploadId);
    form.append("filename", name);
    form.append("chunk_index", String(i));
    form.append("total_chunks", String(totalChunks));
    form.append("file_size", String(file.size));
    const data = await postChunk(form);
    onPiece(i + 1, totalChunks, name, data);
  }
}

async function uploadAll(fileList, pathFn) {
  const list = Array.from(fileList);
  if (!list.length) return;

  uploadBtn.disabled = true;
  if (typeof addBtn !== "undefined" && addBtn) addBtn.disabled = true;
  status.className = "";
  setProgress(0, "Starting chunked upload (1 MB pieces)…\\n" + list.length + " file(s)");

  let totalBytes = list.reduce((s, f) => s + f.size, 0) || 1;
  let sentBytes = 0;
  let saved = 0;
  const totalFiles = list.length;

  try {
    for (let fi = 0; fi < list.length; fi++) {
      const file = list[fi];
      const rel = pathFn(file);
      await uploadOneFile(file, rel, (doneChunks, totalChunks, name) => {
        const fileSent = Math.min(file.size, doneChunks * CHUNK);
        const overall = Math.min(100, Math.round(((sentBytes + fileSent) / totalBytes) * 100));
        const mbDone = ((sentBytes + fileSent) / (1024 * 1024)).toFixed(1);
        const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
        setProgress(
          overall,
          "File " + (fi + 1) + "/" + totalFiles + ": " + name +
          "\\nchunk " + doneChunks + "/" + totalChunks +
          " · " + overall + "% (" + mbDone + " / " + mbTotal + " MB)"
        );
        if (doneChunks === totalChunks) {
          sentBytes += file.size;
          saved += 1;
        }
      });
    }
    setProgress(100, "100% — Saved " + saved + " file(s) to oupload/ (1 MB chunks)");
    status.className = "ok";
  } catch (e) {
    status.className = "err";
    status.textContent = String(e.message || e);
    uploadBtn.disabled = false;
    if (typeof addBtn !== "undefined" && addBtn) addBtn.disabled = false;
  }
}
"""


def unique_dest(directory: Path, name: str) -> Path:
    destination = directory / name
    if not destination.exists():
        return destination
    stem, suffix = destination.stem, destination.suffix
    i = 1
    while destination.exists():
        destination = directory / f"{stem}_{i}{suffix}"
        i += 1
    return destination


def safe_rel_path(raw: str) -> Path:
    cleaned = raw.replace("\\", "/").strip().lstrip("/")
    parts = [p for p in Path(cleaned).parts if p not in ("", ".", "..")]
    if not parts:
        parts = [f"file_{uuid.uuid4().hex[:8]}"]
    return Path(*parts)


def assemble_upload(upload_id: str, filename: str, total_chunks: int) -> str:
    part_dir = TMP_DIR / upload_id
    rel = safe_rel_path(filename)
    dest = UPLOAD_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = unique_dest(dest.parent, dest.name)

    with open(dest, "wb") as out:
        for i in range(total_chunks):
            part = part_dir / f"{i:08d}.part"
            if not part.is_file():
                raise FileNotFoundError(f"missing chunk {i}")
            with open(part, "rb") as inp:
                shutil.copyfileobj(inp, out, length=CHUNK_SIZE)

    shutil.rmtree(part_dir, ignore_errors=True)
    return str(dest.relative_to(UPLOAD_DIR))


def create_folder_app() -> Flask:
    app = Flask(__name__)
    CORS(app)
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

    @app.get("/")
    def folder_page():
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Select folder</title>
  <style>{COMMON_CSS}</style>
</head>
<body>
  <div class="nav"><a href="/">Folder</a><a href="/files">Files</a></div>
  <h2>Select a phone folder</h2>
  <p>Use the picker below (not a hidden button). Uploads in <b>1 MB chunks</b>.</p>

  <input id="folder" class="picker" type="file" webkitdirectory directory multiple />

  <button class="btn secondary" id="uploadBtn" disabled>Upload selected folder</button>
  <div id="fileList"></div>
  <div class="bar-wrap" id="barWrap"><div id="bar"></div></div>
  <div id="pct">0%</div>
  <div id="status">No folder selected yet.</div>

  <script>
    const folderInput = document.getElementById("folder");
    const uploadBtn = document.getElementById("uploadBtn");
    const status = document.getElementById("status");
    const bar = document.getElementById("bar");
    const barWrap = document.getElementById("barWrap");
    const pctEl = document.getElementById("pct");
    const fileListEl = document.getElementById("fileList");
    let files = [];
    {CHUNK_JS}

    folderInput.addEventListener("change", () => {{
      // Copy FileList immediately — some mobile browsers clear it later
      files = Array.from(folderInput.files || []);
      status.className = "";
      barWrap.classList.remove("on");
      pctEl.classList.remove("on");
      renderFileList(files);
      if (!files.length) {{
        status.textContent = "No folder selected yet.";
        uploadBtn.disabled = true;
        return;
      }}
      const root = (files[0].webkitRelativePath || files[0].name).split("/")[0];
      const mb = (files.reduce((s, f) => s + f.size, 0) / (1024*1024)).toFixed(1);
      status.textContent = "Folder: " + root + "\\n" + files.length +
        " file(s) selected · " + mb + " MB · 1 MB chunks";
      uploadBtn.disabled = false;
    }});

    uploadBtn.addEventListener("click", () => {{
      const snapshot = files.slice();
      uploadAll(snapshot, f => f.webkitRelativePath || f.name);
    }});
  </script>
</body>
</html>"""

    @app.get("/files")
    def files_page():
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Upload files</title>
  <style>{COMMON_CSS}</style>
</head>
<body>
  <div class="nav"><a href="/">Folder</a><a href="/files">Files</a></div>
  <h2>Upload files</h2>
  <p>
    Select many files below. If “Select all” only returns one, use
    <b>Add more files</b> and pick in batches — they stack up.
  </p>

  <input id="picker" class="picker" type="file" multiple accept="*/*" />
  <button class="btn secondary" id="addBtn" type="button">➕ Add more files</button>
  <input id="pickerAdd" class="picker" type="file" multiple accept="*/*" style="display:none" />

  <button class="btn primary" id="uploadBtn" disabled>Upload all selected</button>
  <button class="btn secondary" id="clearBtn" type="button" disabled>Clear selection</button>
  <div id="fileList"></div>
  <div class="bar-wrap" id="barWrap"><div id="bar"></div></div>
  <div id="pct">0%</div>
  <div id="status">No files selected yet.</div>

  <script>
    const picker = document.getElementById("picker");
    const pickerAdd = document.getElementById("pickerAdd");
    const addBtn = document.getElementById("addBtn");
    const clearBtn = document.getElementById("clearBtn");
    const uploadBtn = document.getElementById("uploadBtn");
    const status = document.getElementById("status");
    const bar = document.getElementById("bar");
    const barWrap = document.getElementById("barWrap");
    const pctEl = document.getElementById("pct");
    const fileListEl = document.getElementById("fileList");
    let files = [];
    {CHUNK_JS}

    function refreshStatus() {{
      status.className = "";
      barWrap.classList.remove("on");
      pctEl.classList.remove("on");
      renderFileList(files);
      if (!files.length) {{
        status.textContent = "No files selected yet.";
        uploadBtn.disabled = true;
        clearBtn.disabled = true;
        return;
      }}
      const mb = (files.reduce((s, f) => s + f.size, 0) / (1024*1024)).toFixed(1);
      const chunks = files.reduce((s, f) => s + Math.max(1, Math.ceil(f.size / CHUNK)), 0);
      status.textContent = files.length + " file(s) selected · " + mb +
        " MB · " + chunks + " chunk(s) of 1 MB";
      uploadBtn.disabled = false;
      clearBtn.disabled = false;
    }}

    picker.addEventListener("change", () => {{
      // Replace with this pick (first selection)
      files = Array.from(picker.files || []);
      refreshStatus();
      // Reset so the same files can be re-chosen later if needed
      picker.value = "";
    }});

    addBtn.addEventListener("click", () => pickerAdd.click());
    pickerAdd.addEventListener("change", () => {{
      const incoming = Array.from(pickerAdd.files || []);
      files = mergeFiles(files, incoming);
      refreshStatus();
      pickerAdd.value = "";
    }});

    clearBtn.addEventListener("click", () => {{
      files = [];
      picker.value = "";
      pickerAdd.value = "";
      refreshStatus();
    }});

    uploadBtn.addEventListener("click", () => {{
      const snapshot = files.slice();
      uploadAll(snapshot, f => f.name);
    }});
  </script>
</body>
</html>"""

    @app.post("/upload-chunk")
    def upload_chunk():
        chunk = request.files.get("chunk")
        upload_id = (request.form.get("upload_id") or "").strip()
        filename = request.form.get("filename") or "upload.bin"
        try:
            chunk_index = int(request.form.get("chunk_index", "-1"))
            total_chunks = int(request.form.get("total_chunks", "0"))
        except ValueError:
            return jsonify({"error": "invalid chunk metadata"}), 400

        if not chunk or not upload_id or chunk_index < 0 or total_chunks < 1:
            return jsonify({"error": "missing chunk fields"}), 400
        if chunk_index >= total_chunks:
            return jsonify({"error": "chunk_index out of range"}), 400
        if "/" in upload_id or "\\" in upload_id or ".." in upload_id:
            return jsonify({"error": "invalid upload_id"}), 400

        part_dir = TMP_DIR / upload_id
        part_dir.mkdir(parents=True, exist_ok=True)
        part_path = part_dir / f"{chunk_index:08d}.part"
        chunk.save(part_path)

        received = len(list(part_dir.glob("*.part")))
        done = received >= total_chunks
        saved_as = None
        if done:
            try:
                saved_as = assemble_upload(upload_id, filename, total_chunks)
            except Exception as exc:  # noqa: BLE001
                return jsonify({"error": f"assemble failed: {exc}"}), 500

        return jsonify(
            {
                "received": received,
                "total_chunks": total_chunks,
                "done": done,
                "saved_as": saved_as,
                "pct": int(received / total_chunks * 100),
            }
        )

    return app


def ensure_folder_server() -> None:
    global _folder_server_started
    if _folder_server_started:
        return
    _folder_server_started = True

    def run():
        try:
            create_folder_app().run(
                host="0.0.0.0",
                port=FOLDER_PORT,
                debug=False,
                use_reloader=False,
                threaded=True,
            )
        except OSError:
            pass

    threading.Thread(target=run, daemon=True).start()


if __name__ == "__main__":
    create_folder_app().run(
        host="0.0.0.0",
        port=FOLDER_PORT,
        debug=False,
        use_reloader=False,
        threaded=True,
    )
