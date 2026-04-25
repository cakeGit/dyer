"use strict";

const {
  getPixel,
  oklchDistance,
  rgbToOklch,
  rgbaKey,
  setPixel,
} = require("./color-utils");
const { preparePaletteMapping } = require("./palette-mapping");
const {
  normalizeUnmatchedColorConfig,
  shouldApproximateUnmatchedColor,
} = require("./unmatched-color-config");

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function blendChannel(source, target, strength) {
  return clampChannel(source + ((target - source) * strength));
}

function getEntryConfidence(entry) {
  if (!entry.sampleCount || !entry.chosenCount) {
    return 1;
  }

  return Math.max(0.05, Math.min(1, entry.chosenCount / entry.sampleCount));
}

function getSortedPaletteMatches(rgb, approximatePalette) {
  const sourceOklch = rgbToOklch(rgb);
  return approximatePalette
    .map((entry) => ({
      distance: oklchDistance(sourceOklch, entry.sourceOklch),
      source: entry.source,
      target: entry.target,
      confidence: getEntryConfidence(entry),
    }))
    .sort((left, right) => left.distance - right.distance);
}

function findNearestPaletteColor(rgb, approximatePalette) {
  if (!approximatePalette.length) {
    return null;
  }

  return getSortedPaletteMatches(rgb, approximatePalette)[0] || null;
}

function findPaletteBlendColor(rgb, approximatePalette, unmatchedColor) {
  if (!approximatePalette.length) {
    return null;
  }

  const matches = getSortedPaletteMatches(rgb, approximatePalette);
  const nearest = matches[0];
  if (!nearest || !shouldApproximateUnmatchedColor(unmatchedColor, nearest.distance)) {
    return null;
  }

  const sampleCount = unmatchedColor.blendSampleCount || 6;
  const selected = matches.slice(0, sampleCount);
  const farthestSelected = selected[selected.length - 1] || nearest;
  const threshold = unmatchedColor.threshold == null ? 0 : unmatchedColor.threshold;
  const radius = Math.max(threshold, farthestSelected.distance, 0.12);
  let totalWeight = 0;
  const drift = [0, 0, 0];

  for (const match of selected) {
    const normalizedDistance = match.distance / radius;
    const proximity = 1 / (1 + (normalizedDistance * normalizedDistance * 4));
    const confidenceWeight = 0.25 + (0.75 * match.confidence);
    const weight = proximity * confidenceWeight;

    drift[0] += (match.target[0] - match.source[0]) * weight;
    drift[1] += (match.target[1] - match.source[1]) * weight;
    drift[2] += (match.target[2] - match.source[2]) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    return null;
  }

  const strength = unmatchedColor.threshold == null || unmatchedColor.threshold === 0
    ? 1
    : Math.max(0, Math.min(1, 1 - (nearest.distance / unmatchedColor.threshold)));

  return {
    distance: nearest.distance,
    target: [
      clampChannel(rgb[0] + ((drift[0] / totalWeight) * strength)),
      clampChannel(rgb[1] + ((drift[1] / totalWeight) * strength)),
      clampChannel(rgb[2] + ((drift[2] / totalWeight) * strength)),
    ],
  };
}

function assertCompatibleMask(image, maskImage) {
  if (!maskImage) {
    return;
  }

  if (image.width !== maskImage.width || image.height !== maskImage.height) {
    throw new Error(`Mask size ${maskImage.width}x${maskImage.height} does not match image size ${image.width}x${image.height}`);
  }
}

function getMaskStrength(maskImage, index) {
  if (!maskImage) {
    return 1;
  }

  const [r, g, b, a] = getPixel(maskImage.data, index);
  if (a === 0) {
    return 0;
  }

  const luminance = ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255;
  return Math.max(0, Math.min(1, luminance * (a / 255)));
}

function applyMaskStrength(sourcePixel, transformedRgb, maskStrength) {
  if (maskStrength >= 1) {
    return [transformedRgb[0], transformedRgb[1], transformedRgb[2], sourcePixel[3]];
  }

  return [
    blendChannel(sourcePixel[0], transformedRgb[0], maskStrength),
    blendChannel(sourcePixel[1], transformedRgb[1], maskStrength),
    blendChannel(sourcePixel[2], transformedRgb[2], maskStrength),
    sourcePixel[3],
  ];
}

function transformImage(image, mapping, options = {}) {
  const preparedMapping = mapping.sourceToTargetLookup ? mapping : preparePaletteMapping(mapping);
  const unmatchedColor = normalizeUnmatchedColorConfig(
    options.unmatchedColor || preparedMapping.unmatchedColor,
  );
  const output = {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data.length),
  };
  const maskImage = options.maskImage || null;
  assertCompatibleMask(image, maskImage);
  const stats = {
    totalPixels: image.data.length / 4,
    transparentPixels: 0,
    exactMatches: 0,
    approximateMatches: 0,
    paletteBlendMatches: 0,
    maskedPixels: 0,
    preservedPixels: 0,
  };

  for (let index = 0; index < image.data.length; index += 4) {
    const sourcePixel = getPixel(image.data, index);
    const [r, g, b, a] = sourcePixel;

    if (a === 0) {
      setPixel(output.data, index, sourcePixel);
      stats.transparentPixels += 1;
      continue;
    }

    const maskStrength = getMaskStrength(maskImage, index);
    if (maskStrength <= 0) {
      setPixel(output.data, index, sourcePixel);
      stats.maskedPixels += 1;
      stats.preservedPixels += 1;
      continue;
    }

    const exactMatch = preparedMapping.sourceToTargetLookup.get(rgbaKey(r, g, b, a));
    if (exactMatch && unmatchedColor.mode !== "blend") {
      setPixel(output.data, index, applyMaskStrength(sourcePixel, exactMatch, maskStrength));
      stats.exactMatches += 1;
      if (maskStrength < 1) {
        stats.maskedPixels += 1;
      }
      continue;
    }

    if (unmatchedColor.mode === "blend") {
      const blend = findPaletteBlendColor([r, g, b], preparedMapping.approximatePalette, unmatchedColor);
      if (blend) {
        setPixel(output.data, index, applyMaskStrength(sourcePixel, blend.target, maskStrength));
        stats.approximateMatches += 1;
        stats.paletteBlendMatches += 1;
        if (maskStrength < 1) {
          stats.maskedPixels += 1;
        }
        continue;
      }
    } else {
      const nearest = findNearestPaletteColor([r, g, b], preparedMapping.approximatePalette);
      if (nearest && shouldApproximateUnmatchedColor(unmatchedColor, nearest.distance)) {
        setPixel(output.data, index, applyMaskStrength(sourcePixel, nearest.target, maskStrength));
        stats.approximateMatches += 1;
        if (maskStrength < 1) {
          stats.maskedPixels += 1;
        }
        continue;
      }
    }

    if (exactMatch) {
      setPixel(output.data, index, applyMaskStrength(sourcePixel, exactMatch, maskStrength));
      stats.exactMatches += 1;
      if (maskStrength < 1) {
        stats.maskedPixels += 1;
      }
      continue;
    }

    setPixel(output.data, index, sourcePixel);
    stats.preservedPixels += 1;
  }

  return {
    image: output,
    stats: {
      ...stats,
      unmatchedColor,
    },
  };
}

module.exports = {
  findNearestPaletteColor,
  findPaletteBlendColor,
  transformImage,
};
