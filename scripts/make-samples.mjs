// Turns materials exported from the production app (samples-raw/<id>.json) into the built-in
// samples (public/samples). Level notes come from scripts/samples.meta.json; words per minute is
// measured from the caption times. Only public-domain videos are listed in the meta file.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const meta = JSON.parse(readFileSync("scripts/samples.meta.json", "utf8"));
const index = [];
for (const s of meta) {
  const raw = `samples-raw/${s.id}.json`;
  if (!existsSync(raw)) {
    console.log("missing", s.id);
    continue;
  }
  const m = JSON.parse(readFileSync(raw, "utf8"));
  const words = m.sentences.reduce((n, x) => n + x.words.length, 0);
  const ms = m.sentences.reduce((n, x) => n + (x.end - x.start), 0);
  const wpm = Math.round(words / (ms / 60000));
  const sample = { level: s.level, topic: s.topic, reason: s.reason.replace("{wpm}", String(wpm)), wpm, license: s.license, credit: s.credit, sourceUrl: `https://www.youtube.com/watch?v=${m.videoId}` };
  const out = { ...m, id: `sample_${s.id}`, sample, stats: undefined, requested: undefined };
  writeFileSync(`public/samples/${s.id}.json`, JSON.stringify(out));
  index.push({ id: s.id, videoId: m.videoId, title: m.title, author: m.author, start: m.start, end: m.end, duration: m.videoDuration, sentences: m.sentences.length, ...sample });
  console.log(s.level, s.id, `${m.sentences.length} sentences`, `${wpm} wpm`, `untranslated ${m.sentences.filter((x) => !x.ja).length}`);
}
writeFileSync("public/samples/index.json", JSON.stringify(index, null, 1));
