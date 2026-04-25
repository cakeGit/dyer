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

function rgbFromMappingValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 3);
  }

  if (typeof value === "string") {
    return parseRgbaKey(value).slice(0, 3);
  }

  throw new Error(`Invalid palette RGB value: ${value}`);
}

function rgbaFromMappingValue(value, fallbackAlpha = 255) {
  if (Array.isArray(value)) {
    return value.length >= 4 ? value : [value[0], value[1], value[2], fallbackAlpha];
  }

  if (typeof value === "string") {
    const channels = parseRgbaKey(value);
    return channels.length >= 4 ? channels : [channels[0], channels[1], channels[2], fallbackAlpha];
  }

  throw new Error(`Invalid palette RGBA value: ${value}`);
}

function preparePaletteMapping(mapping) {
  const unmatchedColor = normalizeUnmatchedColorConfig(mapping.unmatchedColor);
  const sourceToTarget = mapping.sourceToTarget || [];
  const approximatePalette = (mapping.approximatePalette || []).map((entry) => ({
    ...entry,
    source: rgbFromMappingValue(entry.sourceRgb || entry.source),
    target: rgbFromMappingValue(entry.targetRgb || entry.target),
    sourceOklch: entry.sourceOklch || rgbToOklch(rgbFromMappingValue(entry.sourceRgb || entry.source)),
  }));

  return {
    ...mapping,
    unmatchedColor,
    sourceToTarget,
    sourceToTargetLookup: new Map(
      sourceToTarget.map((entry) => {
        const source = rgbaFromMappingValue(entry.sourceRgba || entry.source);
        const target = rgbaFromMappingValue(entry.targetRgba || entry.target, source[3]);
        return [rgbaKey(source[0], source[1], source[2], source[3]), target];
      }),
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
