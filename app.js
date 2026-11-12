const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const pickBtn = document.getElementById("pickBtn");
const results = document.getElementById("results");
const downloadAll = document.getElementById("downloadAll");
const qualityInput = document.getElementById("quality");
const qualityVal = document.getElementById("qualityVal");

const SUPPORTED = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const MAX_ITEMS = 6; // when exceeded, the oldest entries are removed
const entries = []; // { li, url, blob, name }

qualityInput.addEventListener("input", () => {
  qualityVal.textContent = qualityInput.value + "%";
});

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

async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (!SUPPORTED[file.type]) {
      addRow(null, file.name + " (unsupported format)");
      continue;
    }
    try {
      const blob = await cleanImage(file);
      const ext = SUPPORTED[file.type];
      const base = file.name.replace(/\.[^.]+$/, "");
      addRow(blob, `${base}-clean.${ext}`);
    } catch (err) {
      console.error(err);
      addRow(null, file.name + " (failed)");
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

function addRow(blob, name) {
  const li = document.createElement("li");
  let url = null;

  if (blob) {
    url = URL.createObjectURL(blob);
    li.innerHTML = `<img src="${url}" alt=""><span class="name"></span>
      <button type="button">Download</button>`;
    li.querySelector(".name").textContent = name;
    li.querySelector("button").addEventListener("click", () =>
      saveBlob(blob, name),
    );
  } else {
    li.innerHTML = `<span class="name"></span>`;
    li.querySelector(".name").textContent = name;
  }

  results.appendChild(li);
  entries.push({ li, url, blob, name });

  // Keep only the newest MAX_ITEMS; drop the oldest first
  while (entries.length > MAX_ITEMS) {
    const old = entries.shift();
    old.li.remove();
    if (old.url) URL.revokeObjectURL(old.url);
  }

  downloadAll.hidden = entries.filter((e) => e.blob).length < 2;
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

downloadAll.addEventListener("click", () => {
  entries
    .filter((e) => e.blob)
    .forEach((e, i) => setTimeout(() => saveBlob(e.blob, e.name), i * 300));
});
