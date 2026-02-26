import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const DEFAULT_URL = "https://cricsheet.org/downloads/all_json.zip";

export async function downloadAndExtract(options: {
  url?: string;
  dataDir: string;
  force?: boolean;
}): Promise<string[]> {
  const url = options.url ?? DEFAULT_URL;
  const dataDir = options.dataDir;
  const jsonDir = path.join(dataDir, "json");
  const zipPath = path.join(dataDir, "all_json.zip");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Check if we already have extracted files and not forcing
  if (!options.force && fs.existsSync(jsonDir)) {
    const existing = fs
      .readdirSync(jsonDir)
      .filter((f) => f.endsWith(".json"));
    if (existing.length > 0) {
      console.error(
        `Found ${existing.length} existing JSON files. Use --force to re-download.`
      );
      return existing.map((f) => path.join(jsonDir, f));
    }
  }

  // Download
  console.error(`Downloading from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  console.error(
    `Download size: ${totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) + " MB" : "unknown"}`
  );

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));
  console.error(`Downloaded to ${zipPath}`);

  // Extract
  console.error("Extracting ZIP...");
  if (fs.existsSync(jsonDir)) {
    fs.rmSync(jsonDir, { recursive: true });
  }
  fs.mkdirSync(jsonDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let extracted = 0;

  for (const entry of entries) {
    if (entry.entryName.endsWith(".json") && !entry.isDirectory) {
      const fileName = path.basename(entry.entryName);
      fs.writeFileSync(
        path.join(jsonDir, fileName),
        entry.getData()
      );
      extracted++;
      if (extracted % 2000 === 0) {
        console.error(`  Extracted ${extracted} files...`);
      }
    }
  }

  console.error(`Extracted ${extracted} JSON files`);

  // Clean up ZIP
  fs.unlinkSync(zipPath);

  return fs
    .readdirSync(jsonDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(jsonDir, f));
}
