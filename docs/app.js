const state = {
  dyes: [],
  dyeMap: new Map(),
  currentDye: null,
  threshold: 10,
  unmatchedMode: "nearest",
  sourceImage: null,
  sourceName: "Bundled demo",
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

function findNearestEntry(rgb) {
  if (!state.currentDye.entries.length) {
    return null;
  }

  const sourceOklch = rgbToOklch(rgb);
  let bestMatch = null;

  for (const entry of state.currentDye.entries) {
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
    const exact = currentDye.exactMap.get(rgb.join(","));

    if (exact) {
      data[index] = exact[0];
      data[index + 1] = exact[1];
      data[index + 2] = exact[2];
      stats.exact += 1;
      continue;
    }

    const transformed = transformPixel(rgb, findNearestEntry(rgb));
    data[index] = transformed.rgb[0];
    data[index + 1] = transformed.rgb[1];
    data[index + 2] = transformed.rgb[2];
    stats[transformed.type] += 1;
  }

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
}

async function boot() {
  attachEvents();
  updateModeHint();
  await loadMappings();
  await setSourceImage("assets/demo.png", "Bundled demo");
}

boot().catch((error) => {
  console.error(error);
  ui.resultLabel.textContent = error.message;
});
