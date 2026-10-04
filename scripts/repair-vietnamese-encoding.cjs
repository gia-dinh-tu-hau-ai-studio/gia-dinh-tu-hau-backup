const fs = require("fs");
const ts = require("typescript");

const file = process.argv[2] || "app/page.tsx";
const shouldWrite = process.argv.includes("--write");
const source = fs.readFileSync(file, "utf8");

const cp1252 = new Map([
  [0x20ac,0x80],[0x201a,0x82],[0x0192,0x83],[0x201e,0x84],[0x2026,0x85],[0x2020,0x86],[0x2021,0x87],
  [0x02c6,0x88],[0x2030,0x89],[0x0160,0x8a],[0x2039,0x8b],[0x0152,0x8c],[0x017d,0x8e],
  [0x2018,0x91],[0x2019,0x92],[0x201c,0x93],[0x201d,0x94],[0x2022,0x95],[0x2013,0x96],[0x2014,0x97],
  [0x02dc,0x98],[0x2122,0x99],[0x0161,0x9a],[0x203a,0x9b],[0x0153,0x9c],[0x017e,0x9e],[0x0178,0x9f],
]);

function suspiciousScore(value) {
  const checks = [/Ã/g,/Â/g,/Ä/g,/Æ/g,/á[º»]/g,/â[€šž¦™œ]/g,/ðŸ/g,/[\u0080-\u009f]/g,/�/g];
  return checks.reduce((score, pattern) => score + (value.match(pattern)?.length || 0), 0);
}

function undoMojibake(value) {
  const bytes = [];
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point <= 0xff) bytes.push(point);
    else if (cp1252.has(point)) bytes.push(cp1252.get(point));
    else return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function improve(value) {
  let result = value;
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const whole = undoMojibake(result);
    if (whole !== null && suspiciousScore(whole) < suspiciousScore(result)) {
      result = whole;
      changed = true;
    }
    result = result.replace(/\S+/g, token => {
      let fixed = token;
      for (let nested = 0; nested < 4; nested += 1) {
        const candidate = undoMojibake(fixed);
        if (candidate === null || suspiciousScore(candidate) >= suspiciousScore(fixed)) break;
        fixed = candidate;
      }
      if (fixed !== token) changed = true;
      return fixed;
    });
    if (!changed) break;
  }
  const isolatedRepairs = [
    ["â‡„", "⇄"],
    ["ĐĒng", "Đăng"],
    ["thỒ", "thể"],
    ["ĐỒ", "Để"],
    ["NĒm", "Năm"],
    ["⬦", "…"],
  ];
  for (const [broken, fixed] of isolatedRepairs) result = result.split(broken).join(fixed);
  return result;
}

const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const replacements = [];

function add(start, end, value, kind) {
  const fixed = improve(value);
  if (fixed !== value) replacements.push({ start, end, value, fixed, kind });
}

function visit(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    add(node.getStart(sourceFile) + 1, node.getEnd() - 1, node.text, ts.SyntaxKind[node.kind]);
  } else if (ts.isTemplateHead(node)) {
    add(node.getStart(sourceFile) + 1, node.getEnd() - 2, node.text, "TemplateHead");
  } else if (ts.isTemplateMiddle(node)) {
    add(node.getStart(sourceFile) + 1, node.getEnd() - 2, node.text, "TemplateMiddle");
  } else if (ts.isTemplateTail(node)) {
    add(node.getStart(sourceFile) + 1, node.getEnd() - 1, node.text, "TemplateTail");
  } else if (ts.isJsxText(node)) {
    add(node.getStart(sourceFile), node.getEnd(), node.getText(sourceFile), "JsxText");
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);

let output = source;
for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
  output = output.slice(0, replacement.start) + replacement.fixed + output.slice(replacement.end);
}

console.log(`Found ${replacements.length} safe text repairs in ${file}.`);
for (const item of replacements.slice(0, 30).reverse()) console.log(`${item.kind}: ${JSON.stringify(item.value)} -> ${JSON.stringify(item.fixed)}`);
if (replacements.length > 30) console.log(`...and ${replacements.length - 30} more.`);
if (shouldWrite) fs.writeFileSync(file, output, "utf8");
