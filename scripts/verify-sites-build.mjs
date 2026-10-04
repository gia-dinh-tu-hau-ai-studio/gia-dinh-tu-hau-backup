import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return extname(entry.name) === ".js" ? [path] : [];
  }));
  return files.flat();
}

const files = await javascriptFiles("dist");
let hasSupabaseEndpoint = false;

for (const file of files) {
  const source = await readFile(file, "utf8");
  if (source.includes("supabase.co")) {
    hasSupabaseEndpoint = true;
    break;
  }
}

if (!hasSupabaseEndpoint) {
  throw new Error("Gói xuất bản thiếu NEXT_PUBLIC_SUPABASE_URL. Không được phép triển khai bản build này.");
}

console.log("Đã kiểm tra cấu hình kết nối trong gói xuất bản.");

