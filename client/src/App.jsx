import { useCallback, useEffect, useRef, useState } from "react";
import { formatSize, mergeFiles, uploadAll } from "./upload";
import "./App.css";

function Progress({ progress }) {
  if (!progress) return null;
  return (
    <div className="progress-block">
      <div className="bar-wrap">
        <div className="bar" style={{ width: `${progress.overall}%` }} />
      </div>
      <div className="pct">{progress.overall}%</div>
      <p className="status-line">
        {progress.finished
          ? `100% — Saved ${progress.saved}, skipped ${progress.skippedCount || 0} duplicate(s)`
          : progress.skipped
            ? `File ${progress.fileIndex}/${progress.totalFiles}: ${progress.name}\nSkipped (already exists)`
            : `File ${progress.fileIndex}/${progress.totalFiles}: ${progress.name}\n${progress.filePct}% of this file · ${progress.mbDone} / ${progress.mbTotal} MB`}
      </p>
    </div>
  );
}

function FileList({ files }) {
  if (!files.length) return null;
  return (
    <div className="file-list">
      {files.map((f, i) => (
        <div key={`${f.name}-${f.size}-${f.lastModified}-${i}`}>
          {i + 1}. {f.webkitRelativePath || f.name} ({formatSize(f.size)})
        </div>
      ))}
    </div>
  );
}

function UploadFiles({ onDone }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const addRef = useRef(null);

  const summary = (() => {
    if (!files.length) return "No files selected yet.";
    const mb = (files.reduce((s, f) => s + f.size, 0) / (1024 * 1024)).toFixed(1);
    return `${files.length} file(s) · ${mb} MB — uploaded one by one`;
  })();

  const onPick = (e, merge) => {
    const incoming = Array.from(e.target.files || []);
    setFiles((prev) => (merge ? mergeFiles(prev, incoming) : incoming));
    setError("");
    setProgress(null);
    e.target.value = "";
  };

  const startUpload = async () => {
    if (!files.length || busy) return;
    setBusy(true);
    setError("");
    try {
      await uploadAll(files, (f) => f.name, setProgress);
      setFiles([]);
      onDone?.();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Upload files</h2>
      <p className="hint">
        Pick multiple files. If “Select all” only returns one, use{" "}
        <b>Add more</b> and stack batches. Files upload <b>one after another</b> (full file, no chunks).
      </p>

      <input
        className="picker"
        type="file"
        multiple
        accept="*/*"
        onChange={(e) => onPick(e, false)}
        disabled={busy}
      />
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() => addRef.current?.click()}
      >
        Add more files
      </button>
      <input
        ref={addRef}
        type="file"
        multiple
        accept="*/*"
        hidden
        onChange={(e) => onPick(e, true)}
      />

      <p className="summary">{summary}</p>
      <FileList files={files} />

      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={!files.length || busy}
          onClick={startUpload}
        >
          {busy ? "Uploading…" : "Upload all"}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!files.length || busy}
          onClick={() => {
            setFiles([]);
            setProgress(null);
          }}
        >
          Clear
        </button>
      </div>

      <Progress progress={progress} />
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function UploadFolder({ onDone }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const folderRef = useRef(null);

  useEffect(() => {
    const el = folderRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  }, []);

  const onPick = (e) => {
    setFiles(Array.from(e.target.files || []));
    setError("");
    setProgress(null);
  };

  const startUpload = async () => {
    if (!files.length || busy) return;
    setBusy(true);
    setError("");
    try {
      await uploadAll(
        files,
        (f) => f.webkitRelativePath || f.name,
        setProgress
      );
      setFiles([]);
      onDone?.();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const root = files[0]
    ? (files[0].webkitRelativePath || files[0].name).split("/")[0]
    : "";

  return (
    <section className="panel">
      <h2>Select folder</h2>
      <p className="hint">
        Choose a whole folder. Best in Chrome on Android. Files upload one after another.
      </p>

      <input
        ref={folderRef}
        className="picker"
        type="file"
        multiple
        onChange={onPick}
        disabled={busy}
      />

      <p className="summary">
        {files.length
          ? `Folder: ${root} · ${files.length} file(s) · ${(
              files.reduce((s, f) => s + f.size, 0) /
              (1024 * 1024)
            ).toFixed(1)} MB`
          : "No folder selected yet."}
      </p>
      <FileList files={files} />

      <button
        type="button"
        className="btn primary"
        disabled={!files.length || busy}
        onClick={startUpload}
      >
        {busy ? "Uploading…" : "Upload folder"}
      </button>

      <Progress progress={progress} />
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ZipFolder() {
  const [browse, setBrowse] = useState(null);
  const [zips, setZips] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadBrowse = useCallback(async (p) => {
    const qs = p ? `?path=${encodeURIComponent(p)}` : "";
    const res = await fetch(`/api/browse${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "browse failed");
    setBrowse(data);
  }, []);

  const loadZips = useCallback(async () => {
    const res = await fetch("/api/zips");
    const data = await res.json();
    setZips(data.zips || []);
  }, []);

  useEffect(() => {
    loadBrowse().catch((e) => setError(String(e.message || e)));
    loadZips().catch(() => {});
  }, [loadBrowse, loadZips]);

  const createZip = async () => {
    if (!browse?.path || busy) return;
    setBusy(true);
    setError("");
    setMessage("Zipping…");
    try {
      const res = await fetch("/api/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: browse.path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "zip failed");
      setMessage(`Created ${data.name}`);
      await loadZips();
    } catch (err) {
      setError(String(err.message || err));
      setMessage("");
    } finally {
      setBusy(false);
    }
  };

  if (!browse) {
    return (
      <section className="panel">
        <h2>Zip a folder</h2>
        <p className="hint">{error || "Loading…"}</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Zip a folder</h2>
      <p className="hint">Tap folders to browse — no path typing.</p>

      <div className="shortcuts">
        {Object.entries(browse.shortcuts || {}).map(([label, p]) => (
          <button
            key={label}
            type="button"
            className="chip"
            onClick={() => loadBrowse(p).catch((e) => setError(String(e.message || e)))}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="row">
        <button
          type="button"
          className="btn ghost"
          onClick={() =>
            loadBrowse(browse.parent).catch((e) => setError(String(e.message || e)))
          }
        >
          Up
        </button>
        <code className="path">{browse.path}</code>
      </div>

      <p className="summary">{browse.fileCount} file(s) in this folder</p>

      <div className="subdir-list">
        {(browse.subdirs || []).map((d) => (
          <button
            key={d.path}
            type="button"
            className="subdir"
            onClick={() => loadBrowse(d.path).catch((e) => setError(String(e.message || e)))}
          >
            {d.name}
          </button>
        ))}
        {!browse.subdirs?.length && <p className="hint">No subfolders here.</p>}
      </div>

      <button
        type="button"
        className="btn primary"
        disabled={!browse.fileCount || busy}
        onClick={createZip}
      >
        {busy ? "Zipping…" : "Create zip of this folder"}
      </button>

      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}

      <h3>Previous zips</h3>
      <ul className="zip-list">
        {zips.map((z) => (
          <li key={z.name}>
            <a href={z.url}>{z.name}</a> ({formatSize(z.size)})
          </li>
        ))}
        {!zips.length && <li className="hint">None yet.</li>}
      </ul>
    </section>
  );
}

function UploadedList({ refreshKey }) {
  const [files, setFiles] = useState([]);

  useEffect(() => {
    fetch("/api/uploads")
      .then((r) => r.json())
      .then((d) => setFiles(d.files || []))
      .catch(() => {});
  }, [refreshKey]);

  return (
    <section className="panel muted">
      <h3>In oupload ({files.length})</h3>
      <ul className="zip-list">
        {files.slice(0, 80).map((f) => (
          <li key={f.name}>
            {f.name} ({formatSize(f.size)})
          </li>
        ))}
        {!files.length && <li className="hint">Empty.</li>}
      </ul>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState("files");
  const [info, setInfo] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, []);

  const bump = () => setRefreshKey((k) => k + 1);
  const phoneUrl = info
    ? `http://${info.ip}:5173`
    : `http://${window.location.hostname}:5173`;

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden="true" />

      <header className="hero">
        <div className="hero-media">
          <img src="/hero.gif" alt="" className="hero-gif" />
          <div className="hero-veil" />
        </div>
        <div className="hero-copy">
          <p className="brand">WIFI</p>
          <h1>Drop it over the air.</h1>
          <p className="sub">
            Phone → Mac on the same network. Full-file sequential uploads, up to 5 GB.
          </p>
          <div className="hero-meta">
            <span className="pill live">Live</span>
            <code className="url">{phoneUrl}</code>
          </div>
        </div>
      </header>

      <nav className="tabs">
        {[
          ["files", "Upload"],
          ["folder", "Folder"],
          ["zip", "Zip"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "tab on" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="stage" key={tab}>
        {tab === "files" && <UploadFiles onDone={bump} />}
        {tab === "folder" && <UploadFolder onDone={bump} />}
        {tab === "zip" && <ZipFolder />}
        <UploadedList refreshKey={refreshKey} />
      </main>
    </div>
  );
}
