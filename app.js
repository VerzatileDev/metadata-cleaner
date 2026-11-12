const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const pickBtn = document.getElementById("pickBtn");
const results = document.getElementById("results");
const resultsActions = document.getElementById("resultsActions");
const downloadAll = document.getElementById("downloadAll");
const clearAll = document.getElementById("clearAll");
const qualityInput = document.getElementById("quality");
const qualityVal = document.getElementById("qualityVal");
const addSuffix = document.getElementById("addSuffix");

const SUPPORTED = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const MAX_ITEMS = 6; // when exceeded, the oldest entries are removed
const entries = []; // { li, nameEl, url, blob, base, ext, label }

/* ---------- settings ---------- */
qualityInput.addEventListener("input", () => {
  qualityVal.textContent = qualityInput.value + "%";
});
addSuffix.addEventListener("change", () => {
  entries.forEach((e) => {
    e.nameEl.textContent = getName(e);
  });
});

/* ---------- file input / drag & drop ---------- */
pickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  fileInput.value = ""; // lets you pick the same file again
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("over");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("over");
  }),
);
dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

/* ---------- processing ---------- */
async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (!SUPPORTED[file.type]) {
      addRow({ label: file.name + " (unsupported format)" });
      continue;
    }
    try {
      const blob = await cleanImage(file);
      addRow({
        blob,
        base: file.name.replace(/\.[^.]+$/, ""),
        ext: SUPPORTED[file.type],
      });
    } catch (err) {
      console.error(err);
      addRow({ label: file.name + " (failed)" });
    }
  }
}

async function cleanImage(file) {
  const bitmap = await createImageBitmap(file); // applies EXIF rotation
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  // Re-encoding writes a fresh file with no metadata.
  const quality =
    file.type === "image/png" ? undefined : Number(qualityInput.value) / 100;
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      file.type,
      quality,
    ),
  );
}

/* ---------- list ---------- */
function getName(e) {
  if (!e.blob) return e.label;
  return addSuffix.checked
    ? `${e.base}-cleaned.${e.ext}`
    : `${e.base}.${e.ext}`;
}

function addRow(data) {
  const entry = { ...data, url: null };
  const li = document.createElement("li");

  if (entry.blob) {
    entry.url = URL.createObjectURL(entry.blob);
    li.innerHTML = `<img src="${entry.url}" alt=""><span class="name"></span>
      <button type="button" class="download">Download</button>
      <button type="button" class="remove secondary" aria-label="Remove" title="Remove">✕</button>`;
    li.querySelector(".download").addEventListener("click", () =>
      saveBlob(entry.blob, getName(entry)),
    );
  } else {
    li.innerHTML = `<span class="name"></span>
      <button type="button" class="remove secondary" aria-label="Remove" title="Remove">✕</button>`;
  }

  entry.li = li;
  entry.nameEl = li.querySelector(".name");
  entry.nameEl.textContent = getName(entry);
  li.querySelector(".remove").addEventListener("click", () =>
    removeEntry(entry),
  );

  results.appendChild(li);
  entries.push(entry);

  // Keep only the newest MAX_ITEMS; drop the oldest first
  while (entries.length > MAX_ITEMS) removeEntry(entries[0]);

  updateButtons();
}

function removeEntry(entry) {
  const i = entries.indexOf(entry);
  if (i === -1) return;
  entries.splice(i, 1);
  entry.li.remove();
  if (entry.url) URL.revokeObjectURL(entry.url);
  updateButtons();
}

clearAll.addEventListener("click", () => {
  [...entries].forEach(removeEntry);
});

function updateButtons() {
  const downloadable = entries.filter((e) => e.blob).length;
  resultsActions.hidden = entries.length === 0;
  downloadAll.hidden = downloadable < 2;
}

/* ---------- downloads ---------- */
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Makes names unique inside the zip: photo.png, photo (1).png, ...
function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 1;
  while (used.has(`${base} (${n})${ext}`)) n++;
  const result = `${base} (${n})${ext}`;
  used.add(result);
  return result;
}

downloadAll.addEventListener("click", async () => {
  const original = downloadAll.textContent;
  downloadAll.disabled = true;
  downloadAll.textContent = "Zipping...";
  try {
    const used = new Set();
    const files = entries
      .filter((e) => e.blob)
      .map((e) => ({ name: uniqueName(getName(e), used), blob: e.blob }));
    saveBlob(await makeZip(files), "cleaned-images.zip");
  } catch (err) {
    console.error(err);
  } finally {
    downloadAll.disabled = false;
    downloadAll.textContent = original;
  }
});

/* ---------- tiny zip writer (no libraries, files stored uncompressed) ---------- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const d = new Date();
  const dosTime =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored, no compression
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
