"use strict";

function rgbaKey(r, g, b, a) {
  return `${r},${g},${b},${a}`;
}

function rgbKey(r, g, b) {
  return `${r},${g},${b}`;
}

function parseRgbaKey(key) {
  return key.split(",").map(Number);
}

function getPixel(data, index) {
  return [data[index], data[index + 1], data[index + 2], data[index + 3]];
}

function setPixel(data, index, rgba) {
  data[index] = rgba[0];
  data[index + 1] = rgba[1];
  data[index + 2] = rgba[2];
  data[index + 3] = rgba[3];
}

function srgbChannelToLinear(value) {
  const normalized = value / 255;
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }

  return ((normalized + 0.055) / 1.055) ** 2.4;
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
  const [lightness, a, b] = rgbToOklab(rgb);
  const chroma = Math.sqrt((a * a) + (b * b));
  let hue = Math.atan2(b, a) * (180 / Math.PI);

  if (hue < 0) {
    hue += 360;
  }

  return [lightness, chroma, hue];
}

function oklchToOklab(oklch) {
  const [lightness, chroma, hue] = oklch;
  const hueRadians = hue * (Math.PI / 180);

  return [
    lightness,
    chroma * Math.cos(hueRadians),
    chroma * Math.sin(hueRadians),
  ];
}

function oklchDistance(left, right) {
  const leftLab = oklchToOklab(left);
  const rightLab = oklchToOklab(right);
  const deltaLightness = leftLab[0] - rightLab[0];
  const deltaA = leftLab[1] - rightLab[1];
  const deltaB = leftLab[2] - rightLab[2];

  return Math.sqrt(
    (deltaLightness * deltaLightness) +
    (deltaA * deltaA) +
    (deltaB * deltaB),
  );
}

module.exports = {
  getPixel,
  oklchDistance,
  parseRgbaKey,
  rgbKey,
  rgbToOklab,
  rgbToOklch,
  rgbaKey,
  setPixel,
};
