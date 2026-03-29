"use strict";

const fs = require("fs");
const path = require("path");

const { rgbKey } = require("./processing/core/color-utils");
const { transformImage } = require("./processing/core/pixel-transform");
const {
  DEFAULT_UNMATCHED_COLOR_CONFIG,
  normalizeUnmatchedColorConfig,
} = require("./processing/core/unmatched-color-config");
const { ensureDir, readPng, writePng } = require("./processing/node/png-io");
const {
  buildColorMappingsFromDirectories,
  listPngFiles,
} = require("./processing/node/reference-loader");

const ROOT_DIR = __dirname;
const ORIGINAL_DIR = path.join(ROOT_DIR, "original");
const DYED_VARIANTS_DIR = path.join(ROOT_DIR, "dyedvariants");
const INPUT_DIR = path.join(ROOT_DIR, "in");
const OUTPUT_DIR = path.join(ROOT_DIR, "out");

function parseCliArgs(argv) {
  const options = {
    unmatchedColor: { ...DEFAULT_UNMATCHED_COLOR_CONFIG },
  };

  for (const arg of argv) {
    if (arg.startsWith("--unmatched-mode=")) {
      options.unmatchedColor.mode = arg.slice("--unmatched-mode=".length);
      continue;
    }

    if (arg.startsWith("--unmatched-threshold=")) {
      const threshold = arg.slice("--unmatched-threshold=".length);
      options.unmatchedColor.threshold = threshold === "none" ? null : Number(threshold);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.unmatchedColor = normalizeUnmatchedColorConfig(options.unmatchedColor);
  return options;
}

function createMappingReport(mappings) {
  const dyes = {};

  for (const [dye, mapping] of Object.entries(mappings)) {
    dyes[dye] = {
      unmatchedColor: mapping.unmatchedColor,
      stats: mapping.stats,
      sourceToTarget: mapping.sourceToTarget.map((entry) => ({
        source: rgbKey(entry.source[0], entry.source[1], entry.source[2]),
        target: rgbKey(entry.target[0], entry.target[1], entry.target[2]),
        sourceRgba: entry.source,
        targetRgba: entry.target,
        sampleCount: entry.sampleCount,
        chosenCount: entry.chosenCount,
      })),
      approximatePalette: mapping.approximatePalette.map((entry) => ({
        source: rgbKey(entry.source[0], entry.source[1], entry.source[2]),
        target: rgbKey(entry.target[0], entry.target[1], entry.target[2]),
        sourceRgb: entry.source,
        targetRgb: entry.target,
        sourceOklch: entry.sourceOklch,
        sampleCount: entry.sampleCount,
        chosenCount: entry.chosenCount,
      })),
    };
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    unmatchedColorDefaults: DEFAULT_UNMATCHED_COLOR_CONFIG,
    dyes,
  };
}

async function processInputImages(options) {
  const {
    inputDir,
    outputDir,
    mappingReportPath,
    mappings,
  } = options;

  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDir(outputDir);

  const inputFiles = listPngFiles(inputDir);
  const processingSummary = {};

  for (const [dye, mapping] of Object.entries(mappings)) {
    processingSummary[dye] = {
      files: {},
      totals: {
        exactMatches: 0,
        approximateMatches: 0,
        preservedPixels: 0,
        transparentPixels: 0,
      },
    };

    for (const inputFile of inputFiles) {
      const inputPath = path.join(inputDir, inputFile);
      const outputPath = path.join(outputDir, inputFile.replace(/\.png$/i, `_${dye}.png`));
      const input = await readPng(inputPath);
      const { image, stats } = transformImage(input, mapping);

      await writePng(outputPath, image);

      processingSummary[dye].files[inputFile] = {
        outputFile: path.basename(outputPath),
        ...stats,
      };
      processingSummary[dye].totals.exactMatches += stats.exactMatches;
      processingSummary[dye].totals.approximateMatches += stats.approximateMatches;
      processingSummary[dye].totals.preservedPixels += stats.preservedPixels;
      processingSummary[dye].totals.transparentPixels += stats.transparentPixels;
    }
  }

  fs.writeFileSync(
    mappingReportPath,
    `${JSON.stringify({
      ...createMappingReport(mappings),
      processingSummary,
    }, null, 2)}\n`,
    "utf8",
  );

  return {
    dyes: Object.keys(mappings).length,
    filesPerDye: inputFiles.length,
    mappingReportPath,
  };
}

async function main() {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const mappings = await buildColorMappingsFromDirectories({
    originalDir: ORIGINAL_DIR,
    variantsDir: DYED_VARIANTS_DIR,
    unmatchedColor: cliOptions.unmatchedColor,
  });
  const summary = await processInputImages({
    inputDir: INPUT_DIR,
    outputDir: OUTPUT_DIR,
    mappingReportPath: path.join(OUTPUT_DIR, "color-mappings.json"),
    mappings,
  });

  console.log(`Generated ${summary.filesPerDye} input texture(s) for ${summary.dyes} dye(s).`);
  console.log(`Mappings written to ${path.relative(ROOT_DIR, summary.mappingReportPath)}.`);
  console.log(`Unmatched colors: ${cliOptions.unmatchedColor.mode}${cliOptions.unmatchedColor.threshold == null ? "" : ` (threshold ${cliOptions.unmatchedColor.threshold})`}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
