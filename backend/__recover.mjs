import "dotenv/config";
const { __testing } = await import("./src/lib/rapidapi.js");
const host = "cloud-api-hub-youtube-downloader.p.rapidapi.com";
const res = await fetch(`https://${host}/download?id=-p8ZQ4XJlso&filter=video`, {
  headers: { "x-rapidapi-key": process.env.RAPIDAPI_KEY, "x-rapidapi-host": host },
});
const ranked = __testing.rankVideoFormats(await res.json());
const best = ranked[0];
const url = best.url;
console.log("format:", __testing.videoFormatLabel(best));
const p = await fetch(url, { headers: { Range: "bytes=0-0" } });
const total = Number(/\/(\d+)\s*$/.exec(p.headers.get("content-range"))[1]);
p.body?.cancel?.();
console.log("total:", (total/1024/1024).toFixed(1), "MB");

const CH = 128*1024;
let pos = 0, ok = 0;
while (pos < total) {
  const end = Math.min(pos+CH-1, total-1);
  const r = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` } });
  if (r.status !== 206) { r.body?.cancel?.(); break; }
  await r.arrayBuffer(); ok++; pos = end+1;
}
console.log(`served ${ok} chunks = ${(pos/1024/1024).toFixed(2)} MB before 403`);
console.log("");
console.log("recovery test on the blocked chunk:");
const blockedStart = pos, blockedEnd = Math.min(pos+CH-1, total-1);
for (const wait of [2, 5, 10, 20, 30]) {
  await new Promise(r => setTimeout(r, wait*1000));
  const r = await fetch(url, { headers: { Range: `bytes=${blockedStart}-${blockedEnd}` } });
  r.body?.cancel?.();
  console.log(`  after +${wait}s -> ${r.status}`);
  if (r.status === 206) { console.log("  RECOVERS"); process.exit(0); }
}
console.log("  never recovered within ~67s");
process.exit(0);
