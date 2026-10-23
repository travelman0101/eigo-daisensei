// Local helper for building the built-in samples: receives material JSON exported from the
// production app in the browser and writes it to samples-raw/. Run only while building samples.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = 4999;
createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://eigo-daisensei.ichi-apps.workers.dev");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.end();
  const name = new URL(req.url, "http://x").searchParams.get("name") ?? "";
  if (req.method !== "POST" || !/^[\w-]{1,40}$/.test(name)) return (res.statusCode = 400), res.end("bad");
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    JSON.parse(body);
    writeFileSync(`samples-raw/${name}.json`, body);
    console.log("saved", name, body.length);
    res.end("ok");
  });
}).listen(PORT, () => console.log(`receiver on ${PORT}`));
