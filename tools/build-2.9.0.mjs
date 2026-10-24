#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "2.9.0.0";
const BUILD_HASH = "80a089bc4a415ff3c5c554fe7f67a0ae17ef127d";
const NATIVE_SHA256 = "ee00fded1e4a42afb21bd36de06e306e3f485e8fbd875ef01254f28af6728923";
const RESOURCE_ROOT =
  "Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/frontend";
const TARGETS = [
  "settings-window-DDvw7Jei.js",
  "advanced-settings-page-definition-CwGdhJgj.js",
  "advanced-settings-view-Dq_TKBuz.js",
  "about-settings-view-BB41C99F.js",
  "about-settings-page-definition-iVkC4ABw.js",
  "use-cloud-sync-status-kind-C8wZA9Vk.js",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseTsv(text, name) {
  return text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      const fields = line.split("\t");
      if (fields.length !== 3) {
        throw new Error(`${name}:${index + 1}: 需要三列（文件、英文、中文）`);
      }
      return { file: fields[0], source: fields[1], target: fields[2] };
    });
}

function decodeJsString(raw) {
  let value = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== "\\") {
      value += char;
      continue;
    }

    i += 1;
    if (i >= raw.length) throw new Error("字符串以反斜杠结尾");
    const escaped = raw[i];
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (raw[i + 1] === "\n") i += 1;
      continue;
    }
    const simpleEscapes = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      0: "\0",
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      value += simpleEscapes[escaped];
      continue;
    }
    if (escaped === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`无效的十六进制转义：\\x${hex}`);
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (escaped === "u") {
      if (raw[i + 1] === "{") {
        const end = raw.indexOf("}", i + 2);
        const hex = end === -1 ? "" : raw.slice(i + 2, end);
        if (!/^[0-9a-fA-F]+$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) {
          throw new Error(`无效的 Unicode 转义：\\u{${hex}}`);
        }
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i = end;
        continue;
      }
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`无效的 Unicode 转义：\\u${hex}`);
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    // JavaScript treats \", \', \`, \\, \$ and unknown escapes as the escaped character.
    value += escaped;
  }
  return value;
}

function encodeDoubleQuotedString(value) {
  return JSON.stringify(value).slice(1, -1);
}

function encodeTemplateString(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function interpolationExpressions(value) {
  const expressions = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "$" || value[i + 1] !== "{") continue;
    const start = i + 2;
    let depth = 1;
    let j = start;
    for (; j < value.length && depth > 0; j += 1) {
      if (value[j] === "{") depth += 1;
      if (value[j] === "}") depth -= 1;
    }
    if (depth !== 0) throw new Error(`未闭合的模板插值：${value}`);
    expressions.push(value.slice(start, j - 1));
    i = j - 1;
  }
  return expressions;
}

function replaceStringLiterals(source, replacements, fileName) {
  const bySource = new Map();
  for (const replacement of replacements) {
    if (replacement.source === replacement.target) {
      throw new Error(`${fileName}: 原文与译文相同：${replacement.source}`);
    }
    if (bySource.has(replacement.source)) {
      throw new Error(`${fileName}: 重复英文原文：${replacement.source}`);
    }
    bySource.set(replacement.source, replacement.target);
  }

  const seen = new Map();
  let output = "";
  let cursor = 0;

  for (let i = 0; i < source.length; i += 1) {
    const quote = source[i];
    if (quote !== '"' && quote !== "`") continue;
    if (quote === '"' && source[i - 1] === "\\") continue;

    const start = i;
    i += 1;
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === quote) break;
      if (quote === '"' && source[i] === "\n") {
        throw new Error(`${fileName}: 未闭合的双引号，偏移 ${start}`);
      }
      i += 1;
    }
    if (i >= source.length) {
      throw new Error(`${fileName}: 未闭合的字符串，偏移 ${start}`);
    }

    const raw = source.slice(start + 1, i);
    const value = decodeJsString(raw);
    const target = bySource.get(value);
    if (target !== undefined) {
      if (quote === "`") {
        const originalExpressions = interpolationExpressions(value);
        const targetExpressions = interpolationExpressions(target);
        if (originalExpressions.join("\0") !== targetExpressions.join("\0")) {
          throw new Error(
            `${fileName}: 模板插值不一致：${value}\n原文：${originalExpressions.join(", ")}\n译文：${targetExpressions.join(", ")}`,
          );
        }
      }
      output += source.slice(cursor, start);
      const encoded =
        quote === '"' ? encodeDoubleQuotedString(target) : encodeTemplateString(target);
      output += quote + encoded + quote;
      cursor = i + 1;
      seen.set(value, (seen.get(value) ?? 0) + 1);
    }
  }

  output += source.slice(cursor);
  const missing = [...bySource.keys()].filter((value) => !seen.has(value));
  if (missing.length > 0) {
    throw new Error(`${fileName}: 未找到 ${missing.length} 条原文：\n${missing.join("\n")}`);
  }
  return { output, counts: seen };
}

function parseArgs(argv) {
  const args = { app: "/Applications/Raycast.app", out: join(ROOT, "build", VERSION) };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--app") args.app = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = resolve(args.app);
  const info = await readFile(join(app, "Contents/Info.plist"), "utf8");
  if (!info.includes(`<string>${VERSION}</string>`)) {
    throw new Error(`Raycast 版本不是 ${VERSION}`);
  }
  const native = await readFile(join(app, "Contents/MacOS/Raycast"));
  if (sha256(native) !== NATIVE_SHA256) {
    throw new Error("Raycast 原生程序 SHA-256 不匹配");
  }

  const rows = parseTsv(
    await readFile(join(ROOT, "localization/2.9.0.tsv"), "utf8"),
    "localization/2.9.0.tsv",
  );
  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }
  for (const fileName of byFile.keys()) {
    if (!TARGETS.includes(fileName)) throw new Error(`未登记的目标文件：${fileName}`);
  }
  for (const fileName of TARGETS) {
    if (!byFile.has(fileName)) throw new Error(`翻译表缺少目标文件：${fileName}`);
  }

  await rm(args.out, { recursive: true, force: true });
  const payloadRoot = join(args.out, "payload");
  const manifest = [];
  const report = {
    version: VERSION,
    architecture: "arm64",
    buildHash: BUILD_HASH,
    nativeSha256: NATIVE_SHA256,
    files: [],
    replacements: 0,
  };

  for (const fileName of TARGETS) {
    const rel = `${RESOURCE_ROOT}/${fileName}`;
    const original = await readFile(join(app, rel));
    const source = original.toString("utf8");
    const { output, counts } = replaceStringLiterals(
      source,
      byFile.get(fileName),
      fileName,
    );
    const payloadPath = join(payloadRoot, rel);
    await mkdir(dirname(payloadPath), { recursive: true });
    await writeFile(payloadPath, output);

    const replacements = [...counts.values()].reduce((sum, count) => sum + count, 0);
    report.replacements += replacements;
    report.files.push({
      path: rel,
      originalSha256: sha256(original),
      patchedSha256: sha256(output),
      replacementStrings: counts.size,
      occurrences: replacements,
    });
    manifest.push(`${sha256(original)}\t${sha256(output)}\t${rel}`);
  }

  await writeFile(join(args.out, "manifest.tsv"), `${manifest.join("\n")}\n`);
  await writeFile(join(args.out, "native-sha256.txt"), `${NATIVE_SHA256}\n`);
  await writeFile(join(args.out, "build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`已生成 ${TARGETS.length} 个资源，${report.replacements} 处替换：${args.out}`);
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
