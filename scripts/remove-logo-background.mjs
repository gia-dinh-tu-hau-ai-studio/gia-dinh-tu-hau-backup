import sharp from "sharp";
import { fileURLToPath } from "node:url";

const input = fileURLToPath(new URL("../public/logo.png", import.meta.url));
const output = fileURLToPath(new URL("../public/logo-transparent.png", import.meta.url));
const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

for (let i = 0; i < data.length; i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const dominance = g - Math.max(r, b);
  if (g > 135 && dominance > 45) {
    const alpha = Math.max(0, Math.min(255, 255 - (dominance - 45) * 3.6));
    data[i + 3] = alpha;
    if (alpha > 0) data[i + 1] = Math.min(g, Math.max(r, b) + 18);
  }
}

await sharp(data, { raw: info }).png().toFile(output);
