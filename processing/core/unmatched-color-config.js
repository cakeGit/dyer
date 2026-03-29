"use strict";

const DEFAULT_UNMATCHED_COLOR_CONFIG = Object.freeze({
  mode: "nearest",
  distanceMetric: "oklch",
  threshold: 0.1,
});

function normalizeUnmatchedColorConfig(config = {}) {
  const normalized = {
    ...DEFAULT_UNMATCHED_COLOR_CONFIG,
    ...(config || {}),
  };

  if (!["preserve", "nearest"].includes(normalized.mode)) {
    throw new Error(`Unsupported unmatched color mode: ${normalized.mode}`);
  }

  if (normalized.mode === "preserve") {
    return {
      mode: "preserve",
      distanceMetric: DEFAULT_UNMATCHED_COLOR_CONFIG.distanceMetric,
      threshold: null,
    };
  }

  if (normalized.distanceMetric !== "oklch") {
    throw new Error(`Unsupported unmatched color distance metric: ${normalized.distanceMetric}`);
  }

  if (normalized.threshold == null) {
    return {
      mode: "nearest",
      distanceMetric: normalized.distanceMetric,
      threshold: null,
    };
  }

  if (!Number.isFinite(normalized.threshold) || normalized.threshold < 0) {
    throw new Error(`Invalid unmatched color threshold: ${normalized.threshold}`);
  }

  return {
    mode: "nearest",
    distanceMetric: normalized.distanceMetric,
    threshold: normalized.threshold,
  };
}

function shouldApproximateUnmatchedColor(config, distance) {
  if (config.mode !== "nearest") {
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
