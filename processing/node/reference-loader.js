"use strict";

const fs = require("fs");
const path = require("path");

const { buildPaletteMapping } = require("../core/palette-mapping");
const { readPng } = require("./png-io");

function listPngFiles(dirPath) {
  return fs.readdirSync(dirPath)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort();
}

function buildReferencePairs(originalDir, variantsDir) {
  const originalFiles = listPngFiles(originalDir);
  const originalEntries = originalFiles
    .map((fileName) => ({
      fileName,
      stem: path.basename(fileName, ".png"),
    }))
    .sort((left, right) => right.stem.length - left.stem.length);
  const variantFiles = listPngFiles(variantsDir);
  const pairsByDye = new Map();

  for (const variantFile of variantFiles) {
    const variantStem = path.basename(variantFile, ".png");
    const matchedOriginal = originalEntries.find((entry) => variantStem.startsWith(`${entry.stem}_`));

    if (!matchedOriginal) {
      continue;
    }

    const dye = variantStem.slice(matchedOriginal.stem.length + 1);
    if (!pairsByDye.has(dye)) {
      pairsByDye.set(dye, []);
    }

    pairsByDye.get(dye).push({
      originalPath: path.join(originalDir, matchedOriginal.fileName),
      originalId: matchedOriginal.fileName,
      variantPath: path.join(variantsDir, variantFile),
      variantId: variantFile,
    });
  }

  return {
    dyeNames: [...pairsByDye.keys()].sort(),
    pairsByDye,
  };
}

async function buildColorMappingsFromDirectories(options) {
  const { originalDir, variantsDir, unmatchedColor } = options;
  const { dyeNames, pairsByDye } = buildReferencePairs(originalDir, variantsDir);
  const mappings = {};

  for (const dye of dyeNames) {
    const referencePairs = [];

    for (const pair of pairsByDye.get(dye) || []) {
      referencePairs.push({
        ...pair,
        originalImage: await readPng(pair.originalPath),
        variantImage: await readPng(pair.variantPath),
      });
    }

    mappings[dye] = buildPaletteMapping(referencePairs, { unmatchedColor });
  }

  return mappings;
}

module.exports = {
  buildColorMappingsFromDirectories,
  buildReferencePairs,
  listPngFiles,
};
