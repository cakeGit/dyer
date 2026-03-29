const state = {
  dyes: [],
  dyeMap: new Map(),
  currentDye: null,
  threshold: 10,
  unmatchedMode: "nearest",
  sourceImage: null,
  sourceName: "Bundled demo",
  mappingSource: "bundled",
  // Preserved so the user can revert to bundled after applying custom mappings.
  bundledState: { dyes: [], dyeMap: new Map() },
};

const ui = {
  dyeSelect: document.getElementById("dyeSelect"),
  swatchGrid: document.getElementById("swatchGrid"),
  unmatchedMode: document.getElementById("unmatchedMode"),
  thresholdRange: document.getElementById("thresholdRange"),
  thresholdNumber: document.getElementById("thresholdNumber"),
  modeHint: document.getElementById("modeHint"),
  imageInput: document.getElementById("imageInput"),
  loadDemo: document.getElementById("loadDemo"),
  downloadLink: document.getElementById("downloadLink"),
  exportZipButton: document.getElementById("exportZipButton"),
  beforeCanvas: document.getElementById("beforeCanvas"),
  afterCanvas: document.getElementById("afterCanvas"),
  sourceLabel: document.getElementById("sourceLabel"),
  resultLabel: document.getElementById("resultLabel"),
  exactMatches: document.getElementById("exactMatches"),
  fallbackMatches: document.getElementById("fallbackMatches"),
  untouchedPixels: document.getElementById("untouchedPixels"),
  thresholdBadge: document.getElementById("thresholdBadge"),
  recipeStrip: document.getElementById("recipeStrip"),
  recipeChipTemplate: document.getElementById("recipeChipTemplate"),
  mappingCount: document.getElementById("mappingCount"),
  mappingSource: document.getElementById("mappingSource"),
  pairRowList: document.getElementById("pairRowList"),
  pairRowTemplate: document.getElementById("pairRowTemplate"),
  addPairRow: document.getElementById("addPairRow"),
  deriveCustom: document.getElementById("deriveCustom"),
  resetBundled: document.getElementById("resetBundled"),
  bulkImportInput: document.getElementById("bulkImportInput"),
  bulkImportResults: document.getElementById("bulkImportResults"),
};

const previewContexts = {
  before: ui.beforeCanvas.getContext("2d", { willReadFrequently: true }),
  after: ui.afterCanvas.getContext("2d", { willReadFrequently: true }),
};

function parseRgbKey(key) {
  return key.split(",").map(Number);
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toTitleCase(value) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// OKLCH color math — mirrors processing/core/color-utils.js so the browser
// uses the same perceptually-uniform distance metric as the CLI pipeline.
function srgbChannelToLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function rgbToOklab(rgb) {
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);
  const l = Math.cbrt((0.4122214708 * r) + (0.5363325363 * g) + (0.0514459929 * b));
  const m = Math.cbrt((0.2119034982 * r) + (0.6806995451 * g) + (0.1073969566 * b));
  const s = Math.cbrt((0.0883024619 * r) + (0.2817188376 * g) + (0.6299787005 * b));
  return [
    (0.2104542553 * l) + (0.793617785 * m) - (0.0040720468 * s),
    (1.9779984951 * l) - (2.428592205 * m) + (0.4505937099 * s),
    (0.0259040371 * l) + (0.7827717662 * m) - (0.808675766 * s),
  ];
}

function rgbToOklch(rgb) {
  const [L, a, b] = rgbToOklab(rgb);
  const C = Math.sqrt((a * a) + (b * b));
  let H = Math.atan2(b, a) * (180 / Math.PI);
  if (H < 0) { H += 360; }
  return [L, C, H];
}

function oklchToOklab(oklch) {
  const hRad = oklch[2] * (Math.PI / 180);
  return [oklch[0], oklch[1] * Math.cos(hRad), oklch[1] * Math.sin(hRad)];
}

function oklchDistance(left, right) {
  const lLab = oklchToOklab(left);
  const rLab = oklchToOklab(right);
  const dL = lLab[0] - rLab[0];
  const da = lLab[1] - rLab[1];
  const db = lLab[2] - rLab[2];
  return Math.sqrt((dL * dL) + (da * da) + (db * db));
}

function buildDye(name, rawMapping) {
  // Exact-match lookup: maps "r,g,b" → [r,g,b] for direct palette hits.
  const sourceList = rawMapping?.sourceToTarget || [];
  const exactMap = new Map(
    sourceList.map((entry) => [entry.source, parseRgbKey(entry.target)]),
  );

  // Approximate palette: used for nearest/approximate fallback.  The JSON
  // stores pre-computed sourceOklch so we don't recompute it per pixel.
  const approxList = rawMapping?.approximatePalette || [];
  const entries = approxList.map((entry) => {
    const source = entry.sourceRgb || parseRgbKey(entry.source);
    const target = entry.targetRgb || parseRgbKey(entry.target);
    return {
      source,
      target,
      sourceOklch: entry.sourceOklch || rgbToOklch(source),
      delta: [target[0] - source[0], target[1] - source[1], target[2] - source[2]],
      sampleCount: entry.sampleCount,
    };
  });

  const totalSamples = entries.reduce((sum, entry) => sum + entry.sampleCount, 0) || 1;
  const representative = entries.reduce((acc, entry) => {
    const weight = entry.sampleCount / totalSamples;
    acc[0] += entry.target[0] * weight;
    acc[1] += entry.target[1] * weight;
    acc[2] += entry.target[2] * weight;
    return acc;
  }, [0, 0, 0]).map(clampChannel);

  return {
    key: name,
    label: toTitleCase(name),
    entries,
    exactMap,
    representative,
  };
}

function normaliseMode(mode) {
  const map = {
    preserve: "keep",
    keep: "keep",
    nearest: "nearest",
    approximate: "approximate",
  };
  return map[mode] || "nearest";
}

function updateModeHint() {
  const messages = {
    keep: "Exact recipe colors are recolored; everything else stays untouched.",
    nearest: "Unfamiliar shades snap to the nearest mapped palette color when they fall inside the threshold.",
    approximate: "Unfamiliar shades borrow the nearest recipe's color drift, blended by distance for softer recolors.",
  };
  ui.modeHint.textContent = messages[state.unmatchedMode];
}

function syncThreshold(value) {
  // Display range 0–100 maps to OKLCH distance 0.0–1.0, matching the CLI's
  // distanceMetric:"oklch" with threshold 0.1 → display value 10.
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  state.threshold = safeValue;
  ui.thresholdRange.value = String(safeValue);
  ui.thresholdNumber.value = String(safeValue);
  ui.thresholdBadge.textContent = `threshold ${safeValue}`;
}

function setCurrentDye(dyeKey) {
  const dye = state.dyeMap.get(dyeKey);
  if (!dye) {
    return;
  }

  state.currentDye = dye;
  ui.dyeSelect.value = dye.key;

  for (const button of ui.swatchGrid.querySelectorAll(".swatch-button")) {
    button.setAttribute("aria-pressed", String(button.dataset.dye === dye.key));
  }

  renderRecipeStrip();
  renderPreview();
}

function renderDyePicker() {
  ui.dyeSelect.innerHTML = "";
  ui.swatchGrid.innerHTML = "";

  for (const dye of state.dyes) {
    const option = document.createElement("option");
    option.value = dye.key;
    option.textContent = dye.label;
    ui.dyeSelect.append(option);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch-button";
    button.dataset.dye = dye.key;
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = `
      <span class="swatch-tone" style="background: linear-gradient(120deg, rgb(${dye.representative.join(",")}), rgba(255,255,255,0.1));"></span>
      <span class="swatch-name">${dye.label}</span>
    `;
    button.addEventListener("click", () => setCurrentDye(dye.key));
    ui.swatchGrid.append(button);
  }

  ui.mappingCount.textContent = `${state.dyes.length} vats loaded`;
  updateMappingSourceBadge();
}

function renderRecipeStrip() {
  if (!state.currentDye) {
    ui.recipeStrip.innerHTML = "";
    return;
  }

  const fragment = document.createDocumentFragment();
  const featuredEntries = [...state.currentDye.entries]
    .sort((left, right) => right.sampleCount - left.sampleCount)
    .slice(0, 8);

  for (const entry of featuredEntries) {
    const node = ui.recipeChipTemplate.content.cloneNode(true);
    node.querySelector(".color-source").style.background = `rgb(${entry.source.join(",")})`;
    node.querySelector(".color-target").style.background = `rgb(${entry.target.join(",")})`;
    node.querySelector(".recipe-name").textContent = `${entry.source.join(", ")} → ${entry.target.join(", ")}`;
    node.querySelector(".recipe-count").textContent = `${entry.sampleCount} sampled pixels`;
    fragment.append(node);
  }

  ui.recipeStrip.innerHTML = "";
  ui.recipeStrip.append(fragment);
}

function drawImageToCanvas(image, canvas, context) {
  canvas.width = image.width;
  canvas.height = image.height;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
}

function findNearestEntry(rgb, dye) {
  const activeDye = dye || state.currentDye;
  if (!activeDye.entries.length) {
    return null;
  }

  const sourceOklch = rgbToOklch(rgb);
  let bestMatch = null;

  for (const entry of activeDye.entries) {
    const distance = oklchDistance(sourceOklch, entry.sourceOklch);
    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { distance, entry };
    }
  }

  return bestMatch;
}

function transformPixel(pixel, nearest) {
  // state.threshold is in display units (0–100); OKLCH distance is 0.0–1.0.
  const oklchThreshold = state.threshold / 100;
  if (!nearest || nearest.distance > oklchThreshold) {
    return { rgb: pixel, type: "untouched" };
  }

  if (state.unmatchedMode === "nearest") {
    return { rgb: nearest.entry.target, type: "fallback" };
  }

  if (state.unmatchedMode === "approximate") {
    const intensity = oklchThreshold === 0 ? 0 : 1 - (nearest.distance / oklchThreshold);
    const drifted = [
      pixel[0] + (nearest.entry.delta[0] * intensity),
      pixel[1] + (nearest.entry.delta[1] * intensity),
      pixel[2] + (nearest.entry.delta[2] * intensity),
    ];
    return { rgb: drifted.map(clampChannel), type: "fallback" };
  }

  return { rgb: pixel, type: "untouched" };
}

function transformImageDataWithDye(imageData, dye) {
  const { data } = imageData;
  const stats = {
    exact: 0,
    fallback: 0,
    untouched: 0,
    opaque: 0,
  };

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha === 0) {
      continue;
    }

    stats.opaque += 1;
    const rgb = [data[index], data[index + 1], data[index + 2]];
    const exact = dye.exactMap.get(rgb.join(","));

    if (exact) {
      data[index] = exact[0];
      data[index + 1] = exact[1];
      data[index + 2] = exact[2];
      stats.exact += 1;
      continue;
    }

    const transformed = transformPixel(rgb, findNearestEntry(rgb, dye));
    data[index] = transformed.rgb[0];
    data[index + 1] = transformed.rgb[1];
    data[index + 2] = transformed.rgb[2];
    stats[transformed.type] += 1;
  }

  return stats;
}

function transformCurrentImage() {
  const { sourceImage, currentDye } = state;
  if (!sourceImage || !currentDye) {
    return null;
  }

  drawImageToCanvas(sourceImage, ui.beforeCanvas, previewContexts.before);
  ui.afterCanvas.width = sourceImage.width;
  ui.afterCanvas.height = sourceImage.height;
  previewContexts.after.clearRect(0, 0, ui.afterCanvas.width, ui.afterCanvas.height);
  previewContexts.after.imageSmoothingEnabled = false;
  previewContexts.after.drawImage(sourceImage, 0, 0);

  const imageData = previewContexts.after.getImageData(0, 0, ui.afterCanvas.width, ui.afterCanvas.height);
  const stats = transformImageDataWithDye(imageData, currentDye);
  previewContexts.after.putImageData(imageData, 0, 0);
  return stats;
}

function updateStats(stats) {
  const total = stats?.opaque || 0;
  const asPercent = (value) => (total ? `${Math.round((value / total) * 100)}%` : "0%");
  ui.exactMatches.textContent = asPercent(stats?.exact || 0);
  ui.fallbackMatches.textContent = asPercent(stats?.fallback || 0);
  ui.untouchedPixels.textContent = asPercent(stats?.untouched || 0);
}

function refreshDownloadLink() {
  if (!state.sourceImage) {
    ui.downloadLink.href = "#";
    return;
  }

  ui.downloadLink.href = ui.afterCanvas.toDataURL("image/png");
  const dyeSuffix = state.currentDye ? state.currentDye.key : "preview";
  ui.downloadLink.download = `${state.sourceName.replace(/\.[^.]+$/, "")}_${dyeSuffix}.png`;
}

// ─── Bulk ZIP export ──────────────────────────────────────────────────────────

async function exportAllAsZip() {
  if (!state.sourceImage) {
    window.alert("Load a source image first.");
    return;
  }
  if (!state.dyes.length) {
    window.alert("No dye mappings are loaded.");
    return;
  }
  // JSZip is loaded via CDN; guard against offline / blocked script.
  if (typeof JSZip === "undefined") {
    window.alert("JSZip library did not load. Check your internet connection and reload the page.");
    return;
  }

  const button = ui.exportZipButton;
  button.disabled = true;
  const origText = button.textContent;

  try {
    const zip = new JSZip();
    const baseName = state.sourceName.replace(/\.[^.]+$/, "");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    for (let i = 0; i < state.dyes.length; i++) {
      const dye = state.dyes[i];
      button.textContent = `Exporting ${i + 1} / ${state.dyes.length}\u2026`;

      canvas.width = state.sourceImage.width;
      canvas.height = state.sourceImage.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.sourceImage, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      transformImageDataWithDye(imageData, dye);
      ctx.putImageData(imageData, 0, 0);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) {
            resolve(value);
            return;
          }

          reject(new Error(`Failed to encode "${dye.key}" as PNG.`));
        }, "image/png");
      });
      zip.file(`${baseName}_${dye.key}.png`, blob);

      // Yield to keep the browser responsive between frames.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    button.textContent = "Building ZIP\u2026";
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}_all_dyes.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } finally {
    button.disabled = false;
    button.textContent = origText;
  }
}

// ─── Custom reference derivation ─────────────────────────────────────────────

function getImagePixelData(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function readFileAsImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Cannot load "${file.name}".`)); };
    img.src = url;
  });
}

// Mirrors processing/core/palette-mapping.js buildPaletteMapping() for the browser.
// Accepts multiple original+variant pairs (for one dye) to merge their tallies.
function buildPaletteMappingFromPairs(pairs) {
  const tally = new Map();    // srcKey -> Map(tgtKey -> count)
  const srcCounts = new Map(); // srcKey -> total sample count

  for (const { original, variant } of pairs) {
    if (original.width !== variant.width || original.height !== variant.height) {
      throw new Error(
        `Reference pair dimensions must match (${original.width}x${original.height} vs ${variant.width}x${variant.height}).`,
      );
    }

    const origPixels = getImagePixelData(original);
    const varPixels = getImagePixelData(variant);
    const len = origPixels.length;

    for (let i = 0; i < len; i += 4) {
      if (origPixels[i + 3] === 0) {
        continue; // skip fully-transparent source pixels
      }

      const or = origPixels[i], og = origPixels[i + 1], ob = origPixels[i + 2];
      const vr = varPixels[i], vg = varPixels[i + 1], vb = varPixels[i + 2];
      const srcKey = `${or},${og},${ob}`;
      const tgtKey = `${vr},${vg},${vb}`;

      if (!tally.has(srcKey)) {
        tally.set(srcKey, new Map());
      }
      const t = tally.get(srcKey);
      t.set(tgtKey, (t.get(tgtKey) || 0) + 1);
      srcCounts.set(srcKey, (srcCounts.get(srcKey) || 0) + 1);
    }
  }

  const sourceToTarget = [];
  const approximatePalette = [];

  for (const [srcKey, tgtMap] of [...tally.entries()].sort()) {
    let bestTarget = null;
    let bestCount = 0;
    for (const [tgtKey, count] of tgtMap) {
      if (count > bestCount) {
        bestCount = count;
        bestTarget = tgtKey;
      }
    }
    if (!bestTarget) {
      continue;
    }

    const srcRgb = parseRgbKey(srcKey);
    const tgtRgb = parseRgbKey(bestTarget);
    const total = srcCounts.get(srcKey) || 0;

    sourceToTarget.push({ source: srcKey, target: bestTarget, sampleCount: total, chosenCount: bestCount });
    approximatePalette.push({
      source: srcKey,
      target: bestTarget,
      sourceRgb: srcRgb,
      targetRgb: tgtRgb,
      sourceOklch: rgbToOklch(srcRgb),
      sampleCount: total,
      chosenCount: bestCount,
    });
  }

  return { sourceToTarget, approximatePalette };
}

function addPairRow() {
  const row = ui.pairRowTemplate.content.cloneNode(true).firstElementChild;

  row.querySelector(".pair-remove").addEventListener("click", () => {
    row.remove();
    // Always keep at least one row so the section stays usable.
    if (!ui.pairRowList.querySelector(".pair-row")) {
      addPairRow();
    }
  });

  for (const fileInput of row.querySelectorAll("input[type='file']")) {
    const label = fileInput.closest(".upload-drop-sm").querySelector(".pair-file-label");
    fileInput.addEventListener("change", () => {
      label.textContent = fileInput.files[0]?.name ?? "Choose image";
    });
  }

  ui.pairRowList.append(row);
}

// ─── Bulk import variants ─────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Multi-word names must come first so "light_blue" is tested before "blue".
const KNOWN_DYE_NAMES = [
  "light_blue", "light_gray", "light_grey",
  "black", "blue", "brown", "cyan", "gray", "grey",
  "green", "lime", "magenta", "orange", "pink", "purple",
  "red", "white", "yellow",
];

function detectDyeFromFilename(filename) {
  const base = filename.toLowerCase()
    .replace(/\.[^.]+$/, "")   // strip extension
    .replace(/[\s-]/g, "_");   // normalise spaces and hyphens to underscores

  for (const dye of KNOWN_DYE_NAMES) {
    // Only match when the dye name appears as a whole token (adjacent to a
    // non-alpha character or a string boundary), so "blue" does not fire on
    // "lightblue" and "gray" does not fire on "light_gray".
    const re = new RegExp(`(?:^|[^a-z])${dye}(?:[^a-z]|$)`);
    if (re.test(base)) {
      if (dye === "grey") { return "gray"; }
      if (dye === "light_grey") { return "light_gray"; }
      return dye;
    }
  }
  return null;
}

function fileStemWithoutDye(filename, dyeName) {
  const base = filename.toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[\s-]/g, "_");

  // Canonical names may differ from the token in the filename (grey ↔ gray).
  const greyAliases = { gray: "grey", light_gray: "light_grey" };
  const alt = greyAliases[dyeName];
  // Use whichever form actually appears in the filename.
  const token = (alt && new RegExp(`(?:^|_)${alt}(?:_|$)`).test(base)) ? alt : dyeName;

  // Remove the token together with any surrounding separator underscores,
  // then collapse runs of underscores and strip leading/trailing ones.
  const cleaned = base
    .replace(new RegExp(`(?:^|_)${token}(?:_|$)`, "g"), "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return cleaned || base;
}

function parseBulkFiles(files) {
  const variants = [];   // { file, dyeName, stem }
  const originals = [];  // { file, stem }

  for (const file of files) {
    const dyeName = detectDyeFromFilename(file.name);
    if (dyeName) {
      variants.push({ file, dyeName, stem: fileStemWithoutDye(file.name, dyeName) });
    } else {
      const stem = file.name.toLowerCase()
        .replace(/\.[^.]+$/, "")
        .replace(/[\s-]/g, "_");
      originals.push({ file, stem });
    }
  }

  const matched = [];   // { dyeName, variantFile, originalFile, confidence }
  const unmatched = []; // { file, reason }

  for (const variant of variants) {
    if (originals.length === 0) {
      unmatched.push({ file: variant.file, reason: "No original files selected" });
      continue;
    }

    let bestOriginal = null;
    let confidence = "auto";

    if (originals.length === 1) {
      bestOriginal = originals[0];
      confidence = "single-original";
    } else {
      // Prefer an original whose stem exactly equals the variant's stem.
      const exactMatch = originals.find((o) => o.stem === variant.stem);
      // Fall back to a prefix match (one name starts with the other).
      const prefixMatch = originals.find((o) =>
        o.stem && variant.stem &&
        (variant.stem.startsWith(o.stem) || o.stem.startsWith(variant.stem)),
      );

      if (exactMatch) {
        bestOriginal = exactMatch;
        confidence = "stem-match";
      } else if (prefixMatch) {
        bestOriginal = prefixMatch;
        confidence = "prefix-match";
      } else {
        unmatched.push({
          file: variant.file,
          reason: `${originals.length} possible originals — stem "${variant.stem}" matched none`,
        });
        continue;
      }
    }

    matched.push({
      dyeName: variant.dyeName,
      variantFile: variant.file,
      originalFile: bestOriginal.file,
      confidence,
    });
  }

  // Originals with no variant end up unmatched so the user can decide what to do.
  const usedOriginals = new Set(matched.map((m) => m.originalFile));
  for (const original of originals) {
    if (!usedOriginals.has(original.file)) {
      unmatched.push({ file: original.file, reason: "No dye variants detected for this file" });
    }
  }

  return { matched, unmatched };
}

function renderBulkImportResults({ matched, unmatched }) {
  const container = ui.bulkImportResults;
  container.hidden = false;
  container.innerHTML = "";

  if (matched.length === 0 && unmatched.length === 0) {
    const msg = document.createElement("p");
    msg.className = "bulk-empty";
    msg.textContent = "No image files were selected.";
    container.append(msg);
    return;
  }

  if (matched.length > 0) {
    const heading = document.createElement("p");
    heading.className = "bulk-section-heading";
    heading.textContent = `${matched.length} pair${matched.length !== 1 ? "s" : ""} auto-detected:`;
    container.append(heading);

    const table = document.createElement("table");
    table.className = "bulk-table";
    table.innerHTML = `<thead><tr>
      <th>Dye</th><th>Original</th><th>Variant</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    const confidenceLabel = {
      "stem-match": "✓ stem",
      "prefix-match": "~ prefix",
      "single-original": "✓ only original",
      "auto": "✓ auto",
    };
    for (const row of matched) {
      const tr = document.createElement("tr");
      const conf = confidenceLabel[row.confidence] || row.confidence;
      const isExact = row.confidence === "stem-match" || row.confidence === "auto";
      tr.innerHTML = `
        <td><span class="bulk-dye-tag">${row.dyeName.replace(/_/g, "\u200B_")}</span></td>
        <td class="bulk-filename">${escapeHtml(row.originalFile.name)}</td>
        <td class="bulk-filename">${escapeHtml(row.variantFile.name)}</td>
        <td><span class="bulk-confidence ${isExact ? "bulk-confidence-exact" : "bulk-confidence-approx"}">${conf}</span></td>
      `;
      tbody.append(tr);
    }
    table.append(tbody);
    container.append(table);
  }

  if (unmatched.length > 0) {
    const heading = document.createElement("p");
    heading.className = "bulk-section-heading bulk-section-heading-warn";
    heading.textContent = `${unmatched.length} unmatched file${unmatched.length !== 1 ? "s" : ""} — add manually if needed:`;
    container.append(heading);

    const list = document.createElement("ul");
    list.className = "bulk-unmatched-list";
    for (const item of unmatched) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="bulk-filename">${escapeHtml(item.file.name)}</span><span class="bulk-reason">${escapeHtml(item.reason)}</span>`;
      list.append(li);
    }
    container.append(list);
  }

  if (matched.length > 0) {
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "button bulk-apply-button";
    applyBtn.textContent = `Populate ${matched.length} row${matched.length !== 1 ? "s" : ""} from detected`;
    applyBtn.addEventListener("click", () => applyBulkResults({ matched, unmatched }));
    container.append(applyBtn);
  }
}

function setFileInputFile(input, file) {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
  } catch {
    // DataTransfer not supported: the file label is still set visually, and the
    // user can re-choose the file if needed before clicking "Derive & apply".
  }
}

function applyBulkResults({ matched }) {
  // Replace all existing rows with the auto-detected ones.
  ui.pairRowList.innerHTML = "";

  for (const entry of matched) {
    const row = ui.pairRowTemplate.content.cloneNode(true).firstElementChild;

    row.querySelector(".pair-name").value = entry.dyeName;

    const origInput = row.querySelector(".pair-original");
    const varInput = row.querySelector(".pair-variant");
    setFileInputFile(origInput, entry.originalFile);
    setFileInputFile(varInput, entry.variantFile);

    origInput.closest(".upload-drop-sm").querySelector(".pair-file-label").textContent = entry.originalFile.name;
    varInput.closest(".upload-drop-sm").querySelector(".pair-file-label").textContent = entry.variantFile.name;

    row.querySelector(".pair-remove").addEventListener("click", () => {
      row.remove();
      if (!ui.pairRowList.querySelector(".pair-row")) {
        addPairRow();
      }
    });

    for (const fileInput of row.querySelectorAll("input[type='file']")) {
      const label = fileInput.closest(".upload-drop-sm").querySelector(".pair-file-label");
      fileInput.addEventListener("change", () => {
        label.textContent = fileInput.files[0]?.name ?? "Choose image";
      });
    }

    ui.pairRowList.append(row);
  }

  ui.bulkImportResults.hidden = true;
  ui.bulkImportInput.value = "";
  ui.pairRowList.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function deriveCustomMappings() {
  const rows = [...ui.pairRowList.querySelectorAll(".pair-row")];
  const groups = new Map(); // normalised name -> [{original, variant}]
  const errors = [];

  for (const row of rows) {
    const rawName = row.querySelector(".pair-name").value.trim();
    const origFile = row.querySelector(".pair-original").files[0];
    const varFile = row.querySelector(".pair-variant").files[0];

    if (!rawName && !origFile && !varFile) {
      continue; // silently skip blank rows
    }

    if (!rawName) { errors.push("Every filled row needs a dye name."); continue; }
    if (!origFile) { errors.push(`"${rawName}": choose an original image.`); continue; }
    if (!varFile) { errors.push(`"${rawName}": choose a dyed-variant image.`); continue; }

    const name = rawName.toLowerCase().replace(/\s+/g, "_");

    try {
      const [origImg, varImg] = await Promise.all([readFileAsImage(origFile), readFileAsImage(varFile)]);
      if (!groups.has(name)) {
        groups.set(name, []);
      }
      groups.get(name).push({ original: origImg, variant: varImg });
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length) {
    window.alert(`Fix these issues before deriving mappings:\n\n${errors.join("\n")}`);
    return;
  }

  if (groups.size === 0) {
    window.alert("Fill in at least one complete row (dye name + original image + variant image).");
    return;
  }

  const customDyes = [];
  const buildErrors = [];

  for (const [name, pairs] of groups) {
    let mapping;
    try {
      mapping = buildPaletteMappingFromPairs(pairs);
    } catch (err) {
      buildErrors.push(`"${name}": ${err.message}`);
      continue;
    }
    if (mapping.sourceToTarget.length === 0) {
      buildErrors.push(`"${name}": no color differences found — are the original and variant the same image?`);
      continue;
    }
    customDyes.push(buildDye(name, mapping));
  }

  if (buildErrors.length) {
    window.alert(buildErrors.join("\n"));
    return;
  }

  state.dyes = customDyes;
  state.dyeMap = new Map(customDyes.map((d) => [d.key, d]));
  state.mappingSource = "custom";

  renderDyePicker();
  setCurrentDye(state.dyes[0].key);
}

function resetToBundledMappings() {
  state.dyes = state.bundledState.dyes;
  state.dyeMap = state.bundledState.dyeMap;
  state.mappingSource = "bundled";

  renderDyePicker();
  if (state.dyes.length) {
    setCurrentDye(state.dyes[0].key);
  }
}

function updateMappingSourceBadge() {
  if (!ui.mappingSource) {
    return;
  }
  if (state.mappingSource === "custom") {
    const n = state.dyes.length;
    ui.mappingSource.textContent = `custom \u2014 ${n} dye${n !== 1 ? "s" : ""}`;
    ui.mappingSource.classList.add("is-custom");
  } else {
    ui.mappingSource.textContent = "bundled";
    ui.mappingSource.classList.remove("is-custom");
  }
}

function renderPreview() {
  if (!state.sourceImage || !state.currentDye) {
    return;
  }

  ui.sourceLabel.textContent = state.sourceName;
  ui.resultLabel.textContent = `${state.currentDye.label} transform`;
  const stats = transformCurrentImage();
  updateStats(stats);
  refreshDownloadLink();
}

function loadImage(src, name) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, name });
    image.onerror = () => reject(new Error(`Unable to load ${name}.`));
    image.src = src;
  });
}

async function setSourceImage(src, name) {
  const loaded = await loadImage(src, name);
  state.sourceImage = loaded.image;
  state.sourceName = loaded.name;
  renderPreview();
}

async function loadMappings() {
  const response = await fetch("color-mappings.json");
  if (!response.ok) {
    throw new Error("Unable to load color mappings.");
  }

  const rawMappings = await response.json();
  const mappingSource = rawMappings.dyes || rawMappings;
  const globalDefaults = rawMappings.unmatchedColorDefaults || {};
  state.unmatchedMode = normaliseMode(globalDefaults.mode || state.unmatchedMode);
  ui.unmatchedMode.value = state.unmatchedMode;
  // Convert OKLCH threshold (0.0–1.0) to display units (0–100).
  if (globalDefaults.threshold != null) {
    syncThreshold(Math.round(globalDefaults.threshold * 100));
  }
  const availableNames = Object.keys(mappingSource).sort();
  state.dyes = availableNames.map((name) => buildDye(name, mappingSource[name]));
  state.dyeMap = new Map(state.dyes.map((dye) => [dye.key, dye]));
  if (!state.dyes.length) {
    throw new Error("No dye mappings were found.");
  }

  // Preserve a copy for later reset.
  state.bundledState = { dyes: state.dyes, dyeMap: state.dyeMap };
  state.mappingSource = "bundled";

  renderDyePicker();
  setCurrentDye(state.dyes[0].key);
}

function attachEvents() {
  ui.dyeSelect.addEventListener("change", (event) => {
    setCurrentDye(event.target.value);
  });

  ui.unmatchedMode.addEventListener("change", (event) => {
    state.unmatchedMode = event.target.value;
    updateModeHint();
    renderPreview();
  });

  const onThresholdChange = (event) => {
    syncThreshold(event.target.value);
    renderPreview();
  };

  ui.thresholdRange.addEventListener("input", onThresholdChange);
  ui.thresholdNumber.addEventListener("input", onThresholdChange);

  ui.imageInput.addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      await setSourceImage(objectUrl, file.name);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  });

  ui.loadDemo.addEventListener("click", async () => {
    await setSourceImage("assets/demo.png", "Bundled demo");
  });

  ui.exportZipButton.addEventListener("click", exportAllAsZip);

  ui.addPairRow.addEventListener("click", addPairRow);

  ui.bulkImportInput.addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    if (!files.length) { return; }
    renderBulkImportResults(parseBulkFiles(files));
  });

  ui.deriveCustom.addEventListener("click", async () => {
    ui.deriveCustom.disabled = true;
    try {
      await deriveCustomMappings();
    } finally {
      ui.deriveCustom.disabled = false;
    }
  });

  ui.resetBundled.addEventListener("click", resetToBundledMappings);
}

async function boot() {
  attachEvents();
  updateModeHint();
  addPairRow(); // seed the custom-reference section with one empty row
  await loadMappings();
  await setSourceImage("assets/demo.png", "Bundled demo");
}

boot().catch((error) => {
  console.error(error);
  ui.resultLabel.textContent = error.message;
});
