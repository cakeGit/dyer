"use strict";

const {
  getPixel,
  parseRgbaKey,
  rgbToOklch,
  rgbaKey,
} = require("./color-utils");
const { normalizeUnmatchedColorConfig } = require("./unmatched-color-config");

function mostCommonOpaqueTarget(counter) {
  const sorted = [...counter.entries()].sort((left, right) => right[1] - left[1]);

  for (const [targetKey, count] of sorted) {
    const [, , , alpha] = parseRgbaKey(targetKey);
    if (alpha > 0) {
      return { targetKey, count };
    }
  }

  return null;
}

function preparePaletteMapping(mapping) {
  const unmatchedColor = normalizeUnmatchedColorConfig(mapping.unmatchedColor);
  const sourceToTarget = mapping.sourceToTarget || [];
  const approximatePalette = (mapping.approximatePalette || []).map((entry) => ({
    ...entry,
    sourceOklch: entry.sourceOklch || rgbToOklch(entry.source),
  }));

  return {
    ...mapping,
    unmatchedColor,
    sourceToTarget,
    sourceToTargetLookup: new Map(
      sourceToTarget.map((entry) => [rgbaKey(entry.source[0], entry.source[1], entry.source[2], entry.source[3]), entry.target]),
    ),
    approximatePalette,
  };
}

function buildPaletteMapping(referencePairs, options = {}) {
  const unmatchedColor = normalizeUnmatchedColorConfig(options.unmatchedColor);
  const sourceToTargets = new Map();
  const sourceUsageCounts = new Map();

  for (const pair of referencePairs) {
    const { originalImage, variantImage } = pair;

    if (originalImage.width !== variantImage.width || originalImage.height !== variantImage.height) {
      throw new Error(`Reference size mismatch between ${pair.originalId} and ${pair.variantId}`);
    }

    for (let index = 0; index < originalImage.data.length; index += 4) {
      const source = getPixel(originalImage.data, index);
      const target = getPixel(variantImage.data, index);

      if (source[3] === 0) {
        continue;
      }

      const sourceKey = rgbaKey(source[0], source[1], source[2], source[3]);
      const targetKey = rgbaKey(target[0], target[1], target[2], target[3]);

      if (!sourceToTargets.has(sourceKey)) {
        sourceToTargets.set(sourceKey, new Map());
      }

      const targetCounts = sourceToTargets.get(sourceKey);
      targetCounts.set(targetKey, (targetCounts.get(targetKey) || 0) + 1);
      sourceUsageCounts.set(sourceKey, (sourceUsageCounts.get(sourceKey) || 0) + 1);
    }
  }

  const sourceToTarget = [];
  const approximatePalette = [];

  for (const [sourceKey, counter] of [...sourceToTargets.entries()].sort()) {
    const bestOpaque = mostCommonOpaqueTarget(counter);
    if (!bestOpaque) {
      continue;
    }

    const source = parseRgbaKey(sourceKey);
    const target = parseRgbaKey(bestOpaque.targetKey);
    const sourceRgb = source.slice(0, 3);
    const targetRgb = target.slice(0, 3);

    sourceToTarget.push({
      source,
      target,
      sampleCount: sourceUsageCounts.get(sourceKey) || 0,
      chosenCount: bestOpaque.count,
    });

    approximatePalette.push({
      source: sourceRgb,
      target: targetRgb,
      sourceOklch: rgbToOklch(sourceRgb),
      sampleCount: sourceUsageCounts.get(sourceKey) || 0,
      chosenCount: bestOpaque.count,
    });
  }

  return {
    unmatchedColor,
    sourceToTarget,
    approximatePalette,
    stats: {
      referencePairs: referencePairs.length,
      sourceColors: sourceToTarget.length,
    },
  };
}

module.exports = {
  buildPaletteMapping,
  preparePaletteMapping,
};
