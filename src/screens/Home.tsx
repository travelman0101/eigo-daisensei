import { useEffect, useState } from "react";
import type { Material } from "../../shared/types";
import { formatTime, parseYouTubeUrl } from "../../shared/youtube";
import { useApp } from "../App";
import { db, getKv, setKv, type Progress } from "../lib/db";
import { openSample, sampleIndex, thumb, type SampleMeta } from "../lib/samples";

const LEVELS = ["A1", "A2", "B1", "B2", "C1"] as const;

export function Home() {
  const { navigate, user, authAvailable, toast, version } = useApp();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<{ m: Material; p?: Progress }[] | null>(null);
  const [last, setLast] = useState<{ m: Material; p?: Progress } | null>(null);
  const [samples, setSamples] = useState<SampleMeta[]>([]);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("B1");
  const [firstVisit, setFirstVisit] = useState(false);

  useEffect(() => {
    (async () => {
      const [ms, ps] = await Promise.all([db().getAll("materials"), db().getAll("progress")]);
      const pm = new Map(ps.map((p) => [p.materialId, p]));
      const mine = ms
        .filter((m) => !m.sample)
        .map((m) => ({ m, p: pm.get(m.id) }))
        .sort((a, b) => (b.p?.lastAt ?? b.m.createdAt) - (a.p?.lastAt ?? a.m.createdAt));
      setRecent(mine);
      const lastId = await getKv<string | null>("lastMaterial", null);
      const lm = lastId ? ms.find((m) => m.id === lastId) : undefined;
      setLast(lm ? { m: lm, p: pm.get(lm.id) } : null);
      setFirstVisit(!(await getKv("seenHome", false)) && ms.length === 0);
    })();
    sampleIndex().then(setSamples);
  }, [version]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = parseYouTubeUrl(url);
    if (!r.ok) return setError(r.error);
    navigate(`/import?v=${r.videoId}${r.startMs ? `&t=${r.startMs}` : ""}`);
  };

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setUrl(t);
      const r = parseYouTubeUrl(t);
      if (r.ok) navigate(`/import?v=${r.videoId}${r.startMs ? `&t=${r.startMs}` : ""}`);
      else setError(r.error);
    } catch {
      setError("貼り付けできませんでした。入力欄を長押しして貼り付けてください");
    }
  };

  const startSample = async (s: SampleMeta) => {
    try {
      navigate(`/m/${encodeURIComponent(await openSample(s.id))}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <main>
      <div className="row between">
        <h1>英語大先生</h1>
        {!user && authAvailable && (
          <a className="btn sm" href="/api/auth/google">
            Google でログイン
          </a>
        )}
      </div>

      {firstVisit && (
        <div className="flash card" style={{ marginBottom: 14 }}>
          好きな YouTube 動画の一部を取り込んで、一文ずつ「聞く → まねる → 追いかけて話す」練習ができます。まずは下の見本で試せます（ログイン不要）。
          <div style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => (setFirstVisit(false), void setKv("seenHome", true))}>
              わかった
            </button>
          </div>
        </div>
      )}

      {last && (
        <button className="glass card item" style={{ marginBottom: 14 }} onClick={() => navigate(`/m/${encodeURIComponent(last.m.id)}`)}>
          <img className="thumb" src={thumb(last.m.videoId)} alt="" loading="lazy" />
          <div className="grow">
            <div className="small muted">続きから</div>
            <div className="title-2">{last.m.title}</div>
            <div className="small muted">
              {(last.p?.sentenceIndex ?? 0) + 1} / {last.m.sentences.length} 文目
            </div>
          </div>
          <span className="icon-btn big" aria-hidden>
            ▶
          </span>
        </button>
      )}

      <form className="glass card" onSubmit={submit}>
        <label className="label" htmlFor="url">
          YouTube のリンクを貼る
        </label>
        <div className="row">
          <input
            id="url"
            className="field grow"
            inputMode="url"
            autoComplete="off"
            placeholder="https://youtu.be/..."
            value={url}
            onChange={(e) => (setUrl(e.target.value), setError(""))}
          />
          <button className="btn primary" type="submit" disabled={!url.trim()}>
            開く
          </button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn sm" onClick={pasteFromClipboard}>
            クリップボードから貼り付け
          </button>
        </div>
        {error && (
          <p className="small" style={{ color: "var(--bad)", margin: "8px 0 0" }} role="alert">
            {error}
          </p>
        )}
      </form>

      <section className="glass card">
        <div className="row between">
          <h2>自分の教材</h2>
          {recent && recent.length > 3 && (
            <button className="btn sm ghost" onClick={() => navigate("/library")}>
              すべて
            </button>
          )}
        </div>
        {recent === null ? (
          <div className="sk" style={{ height: 54 }} />
        ) : recent.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            まだありません。上にリンクを貼ると、好きな区間を教材にできます。
          </p>
        ) : (
          recent.slice(0, 3).map(({ m, p }) => (
            <button key={m.id} className="item" onClick={() => navigate(`/m/${encodeURIComponent(m.id)}`)}>
              <img className="thumb" src={thumb(m.videoId)} alt="" loading="lazy" />
              <div className="grow">
                <div className="title-2">{m.title}</div>
                <div className="small muted">
                  {formatTime(m.start)}–{formatTime(m.end)}・{m.sentences.length} 文{p ? `・${p.plays} 回再生` : ""}
                </div>
              </div>
            </button>
          ))
        )}
      </section>

      <section className="glass card">
        <h2>レベル別の見本</h2>
        <p className="small muted" style={{ marginTop: -4 }}>
          どのレベルも自由に試せます。レベルは語彙・構文・話す速さなどからの目安です（公式の判定ではありません）。
        </p>
        <div className="chips" role="tablist" aria-label="レベル">
          {LEVELS.map((l) => (
            <button key={l} role="tab" aria-selected={level === l} className={`chip ${level === l ? "on" : ""}`} onClick={() => setLevel(l)}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8 }}>
          {samples.filter((s) => s.level === level).length === 0 && <p className="small muted">準備中です</p>}
          {samples
            .filter((s) => s.level === level)
            .map((s) => (
              <button key={s.id} className="item" onClick={() => startSample(s)}>
                <img className="thumb" src={thumb(s.videoId)} alt="" loading="lazy" />
                <div className="grow">
                  <div className="title-2">{s.title}</div>
                  <div className="small muted">
                    {s.topic}・{formatTime(s.start)}–{formatTime(s.end)}（全体 {formatTime(s.duration)}）・約 {s.wpm} 語/分
                  </div>
                </div>
              </button>
            ))}
        </div>
      </section>
      {!user && (
        <p className="small muted" style={{ textAlign: "center" }}>
          自分の動画の取り込みとバックアップには Google ログインが必要です。見本の練習・単語帳はログインなしで使えます。
        </p>
      )}
    </main>
  );
}
