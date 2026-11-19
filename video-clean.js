/* video-clean.js
 * Strips container metadata from videos WITHOUT re-encoding.
 * Metadata regions are overwritten in place (same size), so no offsets shift
 * and the audio/video data is never touched. Only headers are read, so even
 * multi-GB files are handled almost instantly.
 *
 * Supported: MP4 / M4V / MOV / 3GP (ISO-BMFF), WebM / MKV (EBML), AVI (RIFF).
 */
const VideoCleaner = (() => {
  const MIME = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    "3gp": "video/3gpp",
    "3g2": "video/3gpp2",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
  };
  const DEFAULT_EXT = { mp4: "mp4", ebml: "webm", avi: "avi" };

  const ZERO = new Uint8Array(1 << 20);
  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const FREE = enc("free");
  const JUNK = enc("JUNK");

  const read = async (file, start, len) =>
    new Uint8Array(
      await file.slice(start, Math.min(start + len, file.size)).arrayBuffer(),
    );
  const ascii = (b, o) =>
    String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const u32 = (b, o) =>
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u32le = (b, o) =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  /* ---------- patch list ---------- */
  function makePatches() {
    const list = [];
    return {
      add: (offset, bytes) => list.push({ offset, bytes }),
      zero: (offset, len) => len > 0 && list.push({ offset, zero: len }),
      build(file) {
        list.sort((a, b) => a.offset - b.offset);
        const parts = [];
        let pos = 0;
        for (const p of list) {
          if (p.offset < pos) continue; // overlap guard
          parts.push(file.slice(pos, p.offset));
          if (p.bytes) {
            parts.push(p.bytes);
            pos = p.offset + p.bytes.length;
          } else {
            let left = p.zero;
            while (left > 0) {
              const n = Math.min(left, ZERO.length);
              parts.push(n === ZERO.length ? ZERO : ZERO.subarray(0, n));
              left -= n;
            }
            pos = p.offset + p.zero;
          }
        }
        parts.push(file.slice(pos));
        return parts;
      },
    };
  }

  /* ---------- MP4 / MOV / 3GP ---------- */
  const MP4_BLANK = new Set(["udta", "meta", "uuid", "XMP_", "free", "skip"]);
  const MP4_CONTAINERS = new Set(["moov", "trak", "mdia"]);
  const MP4_TIMES = new Set(["mvhd", "tkhd", "mdhd"]);

  async function walkMp4(file, start, end, patches) {
    let pos = start;
    while (pos + 8 <= end) {
      const h = await read(file, pos, 16);
      let size = u32(h, 0);
      let hdr = 8;
      const type = ascii(h, 4);
      if (size === 1) {
        size = u32(h, 8) * 4294967296 + u32(h, 12);
        hdr = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < hdr) break;
      size = Math.min(size, end - pos);
      const body = pos + hdr;

      if (MP4_BLANK.has(type)) {
        patches.add(pos + 4, FREE); // rename to "free", same size
        patches.zero(body, size - hdr);
      } else if (MP4_CONTAINERS.has(type)) {
        await walkMp4(file, body, pos + size, patches);
      } else if (MP4_TIMES.has(type) && size - hdr >= 20) {
        const v = (await read(file, body, 1))[0];
        patches.zero(body + 4, v === 1 ? 16 : 8); // creation + modification time
      }
      pos += size;
    }
  }

  /* ---------- WebM / MKV (EBML) ---------- */
  function vint(b, o, keepMarker) {
    const first = b[o];
    if (!first) return null;
    let len = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      mask >>= 1;
      len++;
    }
    if (o + len > b.length) return null;
    let v = keepMarker ? first : first & (mask - 1);
    let ones = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      v = v * 256 + b[o + i];
      if (b[o + i] !== 0xff) ones = false;
    }
    return { len, v, unknown: !keepMarker && ones };
  }

  async function* ebmlChildren(file, start, end) {
    let pos = start;
    while (pos + 2 <= end) {
      const h = await read(file, pos, 12);
      const id = vint(h, 0, true);
      if (!id) return;
      const sz = vint(h, id.len, false);
      if (!sz) return;
      const hdr = id.len + sz.len;
      const size = sz.unknown ? null : sz.v;
      yield { id: id.v, pos, hdr, size };
      if (size === null) return; // unknown size: can't skip past it
      pos += hdr + size;
    }
  }

  // Replace a whole element with an EBML Void element (0xEC) of identical size.
  function voidEl(patches, pos, total) {
    if (total < 2) return;
    for (let L = 1; L <= 8; L++) {
      const data = total - 1 - L;
      if (data < 0 || data >= 2 ** (7 * L) - 1) continue;
      const head = new Uint8Array(1 + L);
      head[0] = 0xec;
      let v = data;
      for (let i = L; i >= 1; i--) {
        head[i] = v % 256;
        v = Math.floor(v / 256);
      }
      head[1] |= 0x80 >> (L - 1);
      patches.add(pos, head);
      patches.zero(pos + 1 + L, data);
      return;
    }
  }

  const EBML = {
    SEGMENT: 0x18538067,
    INFO: 0x1549a966,
    TRACKS: 0x1654ae6b,
    TRACK_ENTRY: 0xae,
    TRACK_NAME: 0x536e,
    TITLE: 0x7ba9,
    MUXING_APP: 0x4d80,
    WRITING_APP: 0x5741,
    DATE_UTC: 0x4461,
    TAGS: 0x1254c367,
    ATTACHMENTS: 0x1941a469,
    CHAPTERS: 0x1043a770,
  };

  async function scanEbml(file, patches) {
    for await (const top of ebmlChildren(file, 0, file.size)) {
      if (top.id !== EBML.SEGMENT) continue;
      const start = top.pos + top.hdr;
      const end =
        top.size === null ? file.size : Math.min(start + top.size, file.size);

      for await (const el of ebmlChildren(file, start, end)) {
        if (el.size === null) break;
        const total = el.hdr + el.size;
        const inner = el.pos + el.hdr;

        if (
          el.id === EBML.TAGS ||
          el.id === EBML.ATTACHMENTS ||
          el.id === EBML.CHAPTERS
        ) {
          voidEl(patches, el.pos, total);
        } else if (el.id === EBML.INFO) {
          for await (const c of ebmlChildren(file, inner, inner + el.size)) {
            if (c.size === null) break;
            if (
              c.id === EBML.TITLE ||
              c.id === EBML.MUXING_APP ||
              c.id === EBML.WRITING_APP
            ) {
              voidEl(patches, c.pos, c.hdr + c.size);
            } else if (c.id === EBML.DATE_UTC) {
              patches.zero(c.pos + c.hdr, c.size);
            }
          }
        } else if (el.id === EBML.TRACKS) {
          for await (const t of ebmlChildren(file, inner, inner + el.size)) {
            if (t.size === null) break;
            if (t.id !== EBML.TRACK_ENTRY) continue;
            const tin = t.pos + t.hdr;
            for await (const c of ebmlChildren(file, tin, tin + t.size)) {
              if (c.size === null) break;
              if (c.id === EBML.TRACK_NAME)
                voidEl(patches, c.pos, c.hdr + c.size);
            }
          }
        }
      }
    }
  }

  /* ---------- AVI (RIFF) ---------- */
  const AVI_BLANK = new Set(["IDIT", "ISFT", "XMP_", "_PMX"]);

  async function scanAvi(file, patches) {
    let pos = 0;
    while (pos + 12 <= file.size) {
      const h = await read(file, pos, 12);
      if (ascii(h, 0) !== "RIFF") break;
      const size = u32le(h, 4);
      const end = Math.min(pos + 8 + size, file.size);

      let p = pos + 12;
      while (p + 12 <= end) {
        const c = await read(file, p, 12);
        const id = ascii(c, 0);
        const sz = u32le(c, 4);
        const total = 8 + sz;
        if (p + total > end) break;
        if (AVI_BLANK.has(id) || (id === "LIST" && ascii(c, 8) === "INFO")) {
          patches.add(p, JUNK);
          patches.zero(p + 8, sz);
        }
        p += total + (sz & 1);
      }
      pos = end + (size & 1);
    }
  }

  /* ---------- public API ---------- */
  async function detect(file) {
    const h = await read(file, 0, 16);
    if (h.length < 12) return null;
    if (ascii(h, 4) === "ftyp") return "mp4";
    if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3)
      return "ebml";
    if (ascii(h, 0) === "RIFF" && ascii(h, 8) === "AVI ") return "avi";
    if (["moov", "mdat", "wide"].includes(ascii(h, 4))) return "mp4"; // old QuickTime
    return null;
  }

  async function clean(file, fmt) {
    const patches = makePatches();
    if (fmt === "mp4") await walkMp4(file, 0, file.size, patches);
    else if (fmt === "ebml") await scanEbml(file, patches);
    else if (fmt === "avi") await scanAvi(file, patches);
    else throw new Error("unsupported video format");

    const m = file.name.match(/\.([^.]+)$/);
    let ext = m ? m[1].toLowerCase() : "";
    if (!MIME[ext]) ext = DEFAULT_EXT[fmt];

    const blob = new Blob(patches.build(file), { type: MIME[ext] });
    return { blob, ext };
  }

  return { detect, clean };
})();
