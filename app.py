from pathlib import Path
import socket
import zipfile
from datetime import datetime

import streamlit as st
import streamlit.components.v1 as components

from folder_server import FOLDER_PORT, UPLOAD_DIR, ensure_folder_server

BASE_DIR = Path(__file__).parent
ZIP_DIR = BASE_DIR / "zips"
ZIP_DIR.mkdir(exist_ok=True)

st.set_page_config(page_title="File Upload", page_icon="📁", layout="centered")


def local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "localhost"


def zip_folder(folder: Path, progress=None) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_path = ZIP_DIR / f"{folder.name}_{stamp}.zip"
    files = [p for p in folder.rglob("*") if p.is_file()]
    total = len(files) or 1
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for i, path in enumerate(files, start=1):
            zf.write(path, path.relative_to(folder))
            if progress is not None:
                pct = int(i / total * 100)
                progress.progress(pct / 100, text=f"Zipping… {pct}%")
    if progress is not None:
        progress.progress(1.0, text="100% — done")
    return zip_path


ip = local_ip()
ensure_folder_server()

st.title("File Upload & Zip")
st.caption(f"Phone URL: **http://{ip}:8501** · Chunk size: **1 MB**")

tab_upload, tab_folder, tab_zip = st.tabs(
    ["Upload files", "Select phone folder", "Zip a folder"]
)

with tab_upload:
    st.info(
        "Large files upload in **1 MB chunks**. "
        "On phones, open the uploader in a **new tab** (button below) — "
        "iframes often only keep 1 selected file. Use **Add more files** if needed."
    )
    files_url = f"http://{ip}:{FOLDER_PORT}/files"
    st.link_button("Open file uploader (recommended)", files_url, type="primary")
    components.iframe(files_url, height=560)

    existing = sorted(
        p.name for p in UPLOAD_DIR.iterdir() if p.is_file() and p.name != ".gitkeep"
    )
    st.divider()
    st.subheader(f"Files in oupload ({len(existing)})")
    for name in existing[:100]:
        st.write(f"- `{name}`")
    if len(existing) > 100:
        st.caption(f"…and {len(existing) - 100} more")

with tab_folder:
    st.write(
        "Select a whole folder — also uploaded as **1 MB chunks** with live %."
    )
    st.info("Works best in **Chrome** on Android.")
    folder_url = f"http://{ip}:{FOLDER_PORT}/"
    st.link_button("Open folder picker", folder_url, type="primary")
    components.iframe(folder_url, height=480)

    phone_folders = sorted(p.name for p in UPLOAD_DIR.iterdir() if p.is_dir())
    st.divider()
    st.subheader("Folders uploaded from phone")
    if phone_folders:
        for name in phone_folders:
            count = sum(1 for _ in (UPLOAD_DIR / name).rglob("*") if _.is_file())
            st.write(f"- `{name}/` ({count} files)")
    else:
        st.caption("No phone folders uploaded yet.")

with tab_zip:
    st.write("Tap folders to browse — no path typing.")

    shortcuts = {
        "oupload": UPLOAD_DIR,
        "Desktop": Path.home() / "Desktop",
        "Downloads": Path.home() / "Downloads",
        "Home": Path.home(),
    }

    if "browse_path" not in st.session_state:
        st.session_state.browse_path = str(UPLOAD_DIR)

    cols = st.columns(len(shortcuts))
    for col, (label, path) in zip(cols, shortcuts.items()):
        if col.button(label, use_container_width=True):
            st.session_state.browse_path = str(path)
            st.rerun()

    current = Path(st.session_state.browse_path).expanduser()
    if not current.is_dir():
        st.session_state.browse_path = str(UPLOAD_DIR)
        current = UPLOAD_DIR

    top = st.columns([1, 4])
    with top[0]:
        if st.button("⬆️ Up", use_container_width=True) and current != current.parent:
            st.session_state.browse_path = str(current.parent)
            st.rerun()
    with top[1]:
        st.code(str(current), language=None)

    file_count = sum(1 for p in current.rglob("*") if p.is_file())
    st.caption(f"{file_count} file(s) in this folder (including subfolders)")

    subdirs = sorted(
        [p for p in current.iterdir() if p.is_dir() and not p.name.startswith(".")],
        key=lambda p: p.name.lower(),
    )
    if subdirs:
        st.write("Subfolders:")
        for d in subdirs:
            if st.button(f"📁 {d.name}", key=f"enter_{d}", use_container_width=True):
                st.session_state.browse_path = str(d)
                st.rerun()
    else:
        st.caption("No subfolders here.")

    if st.button("Create zip of this folder", type="primary", disabled=file_count == 0):
        zip_progress = st.progress(0, text="Zipping… 0%")
        zip_path = zip_folder(current, progress=zip_progress)
        st.session_state["last_zip"] = str(zip_path)
        st.success(f"Created `{zip_path.name}`")

    last_zip = st.session_state.get("last_zip")
    if last_zip and Path(last_zip).is_file():
        zip_file = Path(last_zip)
        st.download_button(
            label=f"Download {zip_file.name}",
            data=zip_file.read_bytes(),
            file_name=zip_file.name,
            mime="application/zip",
        )
        st.caption(f"Saved at: `{zip_file}`")

    zips = sorted(ZIP_DIR.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    st.divider()
    st.subheader(f"Previous zips ({len(zips)})")
    for z in zips[:20]:
        size_mb = z.stat().st_size / (1024 * 1024)
        st.write(f"- `{z.name}` ({size_mb:.1f} MB)")
