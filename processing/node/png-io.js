"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function readPng(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data,
  };
}

async function writePng(filePath, image) {
  ensureDir(path.dirname(filePath));
  await sharp(Buffer.from(image.data), {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4,
    },
  }).png().toFile(filePath);
}

module.exports = {
  ensureDir,
  readPng,
  writePng,
};
