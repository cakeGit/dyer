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

function findNearestPaletteColor(rgb, approximatePalette) {
  if (!approximatePalette.length) {
    return null;
  }

  const sourceOklch = rgbToOklch(rgb);
  let bestMatch = null;

  for (const entry of approximatePalette) {
    const distance = oklchDistance(sourceOklch, entry.sourceOklch);
    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = {
        distance,
        source: entry.source,
        target: entry.target,
      };
    }
  }

  return bestMatch;
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
  const stats = {
    totalPixels: image.data.length / 4,
    transparentPixels: 0,
    exactMatches: 0,
    approximateMatches: 0,
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

    const exactMatch = preparedMapping.sourceToTargetLookup.get(rgbaKey(r, g, b, a));
    if (exactMatch) {
      setPixel(output.data, index, [exactMatch[0], exactMatch[1], exactMatch[2], a]);
      stats.exactMatches += 1;
      continue;
    }

    const nearest = findNearestPaletteColor([r, g, b], preparedMapping.approximatePalette);
    if (nearest && shouldApproximateUnmatchedColor(unmatchedColor, nearest.distance)) {
      setPixel(output.data, index, [nearest.target[0], nearest.target[1], nearest.target[2], a]);
      stats.approximateMatches += 1;
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
  transformImage,
};
