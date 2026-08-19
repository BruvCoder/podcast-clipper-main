import "dotenv/config";
const { __testing } = await import("./src/lib/rapidapi.js");
const host = "cloud-api-hub-youtube-downloader.p.rapidapi.com";
async function freshUrl() {
  const r = await fetch(`https://${host}/download?id=-p8ZQ4XJlso&filter=video`, {
    headers: { "x-rapidapi-key": process.env.RAPIDAPI_KEY, "x-rapidapi-host": host },
  });
  const ranked = __testing.rankVideoFormats(await r.json());
  return ranked[0].url;
}
const CH = 128 * 1024;
let url = await freshUrl();
let pos = 0, refreshes = 0, chunks = 0;
const t0 = Date.now();
// Try to pull 12MB total, refreshing the URL whenever it gets exhausted.
const TARGET = 12 * 1024 * 1024;
while (pos < TARGET && Date.now() - t0 < 120000) {
  const end = pos + CH - 1;
  const r = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` } });
  if (r.status !== 206) {
    r.body?.cancel?.();
    if (refreshes >= 8) { console.log("gave up after", refreshes, "refreshes at", (pos/1024/1024).toFixed(2), "MB"); break; }
    refreshes++;
    url = await freshUrl();
    continue;
  }
  await r.arrayBuffer();
  chunks++; pos = end + 1;
}
const secs = (Date.now()-t0)/1000;
console.log(`pulled ${(pos/1024/1024).toFixed(2)} MB in ${secs.toFixed(1)}s using ${refreshes} URL refresh(es), ${chunks} chunks`);
console.log(`=> ${(pos/1024/1024/secs).toFixed(2)} MB/s effective`);
console.log(pos >= TARGET ? "RESULT: URL REFRESH WORKS" : "RESULT: INSUFFICIENT");
process.exit(0);
