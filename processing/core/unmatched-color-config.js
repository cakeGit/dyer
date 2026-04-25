"use strict";

const DEFAULT_UNMATCHED_COLOR_CONFIG = Object.freeze({
  mode: "blend",
  distanceMetric: "oklch",
  threshold: 0.1,
  blendSampleCount: 6,
});

const MODE_ALIASES = Object.freeze({
  approximate: "blend",
  blend: "blend",
  keep: "preserve",
  nearest: "nearest",
  preserve: "preserve",
});

function normalizeUnmatchedColorConfig(config = {}) {
  const normalized = {
    ...DEFAULT_UNMATCHED_COLOR_CONFIG,
    ...(config || {}),
  };
  const mode = MODE_ALIASES[normalized.mode];

  if (!mode) {
    throw new Error(`Unsupported unmatched color mode: ${normalized.mode}`);
  }

  if (mode === "preserve") {
    return {
      mode: "preserve",
      distanceMetric: DEFAULT_UNMATCHED_COLOR_CONFIG.distanceMetric,
      threshold: null,
      blendSampleCount: DEFAULT_UNMATCHED_COLOR_CONFIG.blendSampleCount,
    };
  }

  if (normalized.distanceMetric !== "oklch") {
    throw new Error(`Unsupported unmatched color distance metric: ${normalized.distanceMetric}`);
  }

  if (normalized.threshold == null) {
    return {
      mode,
      distanceMetric: normalized.distanceMetric,
      threshold: null,
      blendSampleCount: normalizeBlendSampleCount(normalized.blendSampleCount),
    };
  }

  if (!Number.isFinite(normalized.threshold) || normalized.threshold < 0) {
    throw new Error(`Invalid unmatched color threshold: ${normalized.threshold}`);
  }

  return {
    mode,
    distanceMetric: normalized.distanceMetric,
    threshold: normalized.threshold,
    blendSampleCount: normalizeBlendSampleCount(normalized.blendSampleCount),
  };
}

function normalizeBlendSampleCount(value) {
  const sampleCount = Number(value);
  if (!Number.isFinite(sampleCount) || sampleCount < 1) {
    return DEFAULT_UNMATCHED_COLOR_CONFIG.blendSampleCount;
  }

  return Math.max(1, Math.round(sampleCount));
}

function shouldApproximateUnmatchedColor(config, distance) {
  if (config.mode === "preserve") {
    return false;
  }

  if (config.threshold == null) {
    return true;
  }

  return distance <= config.threshold;
}

module.exports = {
  DEFAULT_UNMATCHED_COLOR_CONFIG,
  normalizeUnmatchedColorConfig,
  shouldApproximateUnmatchedColor,
};
