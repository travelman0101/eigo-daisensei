import { useEffect, useMemo, useRef, useState } from "react";
import { materialId, RANGE_MESSAGES, transcriptHash, validateRange, MAX_RANGE_MS, type RangeSuggestion } from "../../shared/material";
import { MAX_SUBTITLE_BYTES, parsePastedTranscript, parseSubtitles } from "../../shared/subtitles";
import type { Material, Segment, Transcript } from "../../shared/types";
import { formatTime, parseTime, watchUrl } from "../../shared/youtube";
import { useApp } from "../App";
import { ApiError, api, post } from "../lib/api";
import { db, SaveError } from "../lib/db";
import { build, localTranscript, prepare, saveTranscript, type CallStats, type Prepared, type Progress } from "../lib/importer";
import { createYouTube, type PlayerLike } from "../player/yt";

type Phase =
  | { k: "select" }
  | { k: "transcript" }
  | { k: "work"; p: Progress }
  | { k: "confirm"; prep: Prepared; sugg: RangeSuggestion[] }
  | { k: "error"; message: string; canRetry: boolean; noCaptions?: boolean }
  | { k: "cancelled" };

const ID = /^[A-Za-z0-9_-]{11}$/;

export function Import() {
  const { query, navigate, user, toast, authAvailable } = useApp();
  const videoId = query.get("v") ?? "";
  const startParam = Number(query.get("t") ?? "") || 0;
  const [meta, setMeta] = useState<{ title: string; author: string } | null>(null);
  const [metaError, setMetaError] = useState("");
  const [duration, setDuration] = useState(0);
  const [startText, setStartText] = useState(formatTime(startParam));
  const [endText, setEndText] = useState(formatTime(startParam + 5 * 60_000));
  const [phase, setPhase] = useState<Phase>({ k: "select" });
  const [existing, setExisting] = useState<Material[]>([]);
  const [playerError, setPlayerError] = useState("");
  const [now, setNow] = useState(0);
  const [fallback, setFallback] = useState<"none" | "file" | "paste">("none");
  const [pasteText, setPasteText] = useState("");
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerLike | null>(null);
  const abort = useRef<AbortController | null>(null);
  const previewEnd = useRef<number | null>(null);
  const busy = useRef(false);
  const confirmRef = useRef<((s: number, e: number) => Promise<void>) | null>(null);

  const start = parseTime(startText);
  const end = parseTime(endText);
  const rangeError = validateRange(start, end, duration || null);

  useEffect(() => {
    if (!ID.test(videoId)) return;
    let alive = true;
    api<{ title: string; author: string }>(`/api/video/${videoId}`)
      .then((m) => alive && setMeta(m))
      .catch((e: ApiError) => alive && setMetaError(e.message));
    db()
      .getAllFromIndex("materials", "byVideo", videoId)
      .then((ms) => alive && setExisting(ms.filter((m) => !m.sample)));
    let p: PlayerLike | null = null;
    createYouTube(holder.current!, videoId, startParam, (e) => {
      if (e.type === "ready" && p) setDuration(p.duration());
      if (e.type === "error") setPlayerError(e.message);
    })
      .then((pl) => {
        p = pl;
        player.current = pl;
        if (!alive) pl.destroy();
        else if (pl.duration()) setDuration(pl.duration());
      })
      .catch((e: Error) => setPlayerError(e.message));
    const iv = setInterval(() => {
      const pl = player.current;
      if (!pl) return;
      const t = pl.time();
      setNow(t);
      if (!duration && pl.duration()) setDuration(pl.duration());
      if (previewEnd.current != null && t >= previewEnd.current) {
        pl.pause();
        previewEnd.current = null;
      }
    }, 100);
    return () => {
      alive = false;
      clearInterval(iv);
      abort.current?.abort();
      p?.destroy();
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const sameRange = useMemo(
    () => existing.find((m) => (m.requested && m.requested.start === start && m.requested.end === end) || (m.start === start && m.end === end)),
    [existing, start, end],
  );

  if (!ID.test(videoId))
    return (
      <main>
        <h1>取り込み</h1>
        <p>動画が指定されていません。</p>
        <button className="btn" onClick={() => navigate("/")}>
          ホームへ
        </button>
      </main>
    );

  const setPreset = (mins: number) => {
    const s = start ?? 0;
    let e = s + mins * 60_000;
    if (duration) e = Math.min(e, duration);
    setEndText(formatTime(e));
  };

  const preview = () => {
    const p = player.current;
    if (!p || start == null || end == null) return;
    p.seek(start);
    p.play();
    previewEnd.current = end;
  };

  async function getTranscript(signal: AbortSignal): Promise<Transcript> {
    const local = await localTranscript(videoId);
    if (local) return local;
    for (let i = 0; i < 40; i++) {
      signal.throwIfAborted();
      const r = await post<{ transcript?: Transcript; pending?: boolean; _status?: number }>("/api/transcript", { videoId }, signal);
      if (r.transcript) {
        await saveTranscript(r.transcript);
        return r.transcript;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new ApiError(504, "timeout", "字幕の準備に時間がかかっています。少し待ってから再試行してください");
  }

  async function run(transcriptOverride?: Transcript) {
    if (busy.current || start == null || end == null || rangeError) return;
    if (sameRange) {
      toast("保存済みの教材を開きました（AI は使っていません）");
      return navigate(`/m/${encodeURIComponent(sameRange.id)}`);
    }
    busy.current = true;
    const ctl = new AbortController();
    abort.current = ctl;
    const calls: CallStats = { ai: 0, cached: 0 };
    const t0 = performance.now();
    try {
      setPhase({ k: "transcript" });
      const t = transcriptOverride ?? (await getTranscript(ctl.signal));
      const t1 = performance.now();
      const mid = await materialId(videoId, t.lang, t.hash, start, end);
      const already = await db().get("materials", mid);
      if (already) {
        toast("保存済みの教材を開きました（AI は使っていません）");
        return navigate(`/m/${encodeURIComponent(mid)}`);
      }
      const inRange = t.segments.some((s) => s.start < end && s.start + s.dur > start);
      if (!inRange) throw new ApiError(400, "empty_range", "この区間には字幕がありません。範囲を変えてください");
      const prep = await prepare(t, { title: meta?.title || videoId, author: meta?.author ?? "", duration }, start, end, (p) => setPhase({ k: "work", p }), ctl.signal, calls);
      const t2 = performance.now();
      const finish = async (s: number, e: number) => {
        const m = await build(t, prep, s, e, (p) => setPhase({ k: "work", p }), ctl.signal, calls, {
          transcriptMs: Math.round(t1 - t0),
          punctMs: Math.round(t2 - t1),
          translateMs: 0, // measured inside build()
          aiCalls: 0,
          cachedCalls: 0,
        });
        toast(`教材にしました（${m.sentences.length} 文・${Math.round((performance.now() - t0) / 1000)} 秒）`);
        navigate(`/m/${encodeURIComponent(m.id)}`, true);
      };
      if (prep.suggestions.length) {
        busy.current = false;
        setPhase({ k: "confirm", prep, sugg: prep.suggestions });
        confirmRef.current = finish;
        return;
      }
      await finish(start, end);
    } catch (e) {
      if ((e as Error).name === "AbortError") setPhase({ k: "cancelled" });
      else if (e instanceof SaveError) setPhase({ k: "error", message: e.message, canRetry: true });
      else {
        const ae = e as ApiError;
        const noCaptions = ["no_transcript", "no_english", "provider_limit", "provider_config"].includes(ae.code);
        setPhase({ k: "error", message: ae.message ?? "うまくいきませんでした", canRetry: !noCaptions && ae.status !== 401, noCaptions });
        if (noCaptions) setFallback("file");
      }
    } finally {
      busy.current = false;
    }
  }
  const chooseSuggestion = async (s: number, e: number) => {
    const f = confirmRef.current;
    if (!f || busy.current) return;
    busy.current = true;
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await f(s, e);
    } catch (err) {
      if ((err as Error).name === "AbortError") setPhase({ k: "cancelled" });
      else setPhase({ k: "error", message: (err as Error).message, canRetry: true });
    } finally {
      busy.current = false;
    }
  };

  const fromSegments = async (segments: Segment[], source: "upload" | "paste") => {
    if (!segments.length) return toast("字幕を読み取れませんでした（SRT / VTT、または「0:05 テキスト」の形式）", "error");
    const t: Transcript = { videoId, lang: "en", hash: await transcriptHash(segments), source, segments };
    await saveTranscript(t);
    setFallback("none");
    void run(t);
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_SUBTITLE_BYTES) return toast("ファイルが大きすぎます（2MB まで）", "error");
    void fromSegments(parseSubtitles(await f.text()), "upload");
  };

  const working = phase.k === "transcript" || phase.k === "work";
  const loginHref = `/api/auth/google?next=${encodeURIComponent(`/import?v=${videoId}&t=${start ?? 0}`)}`;

  return (
    <main>
      <div className="row between">
        <button className="btn sm ghost" onClick={() => navigate("/")}>
          ← 戻る
        </button>
        <a className="btn sm ghost" href={watchUrl(videoId, start ?? 0)} target="_blank" rel="noreferrer">
          YouTube で開く
        </a>
      </div>
      <div className={`video ${window.__FAKE_YT__ ? "fake" : ""}`} ref={holder} style={{ margin: "8px 0 12px" }} />
      {playerError && <div className="flash error">{playerError}</div>}
      <div style={{ margin: "0 4px 12px" }}>
        {meta ? <div className="title-2">{meta.title}</div> : metaError ? <div className="flash error small">{metaError}</div> : <div className="sk" style={{ height: 18, width: "70%" }} />}
        <div className="small muted" style={{ marginTop: 4 }}>
          {meta?.author} {duration ? `・全体 ${formatTime(duration)}` : ""}
        </div>
      </div>

      {existing.length > 0 && (
        <section className="glass card">
          <h2>この動画の保存済み教材</h2>
          {existing.map((m) => (
            <button key={m.id} className="item" onClick={() => navigate(`/m/${encodeURIComponent(m.id)}`)}>
              <div className="grow">
                {formatTime(m.start)}–{formatTime(m.end)}・{m.sentences.length} 文
              </div>
              <span className="badge">開く</span>
            </button>
          ))}
        </section>
      )}

      <section className="glass card" aria-disabled={working}>
        <h2>練習する区間</h2>
        <div className="row">
          <div className="grow">
            <label className="label" htmlFor="st">
              開始
            </label>
            <input id="st" className="field" inputMode="text" value={startText} onChange={(e) => setStartText(e.target.value)} onBlur={() => start != null && setStartText(formatTime(start, start % 1000 !== 0))} disabled={working} />
          </div>
          <div className="grow">
            <label className="label" htmlFor="en">
              終了
            </label>
            <input id="en" className="field" inputMode="text" value={endText} onChange={(e) => setEndText(e.target.value)} onBlur={() => end != null && setEndText(formatTime(end, end % 1000 !== 0))} disabled={working} />
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => setStartText(formatTime(Math.round(now), true))} disabled={working}>
            今の位置（{formatTime(now)}）を開始に
          </button>
          <button className="btn sm" onClick={() => setEndText(formatTime(Math.round(now), true))} disabled={working}>
            今の位置を終了に
          </button>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <span className="small muted">開始から</span>
          {[1, 3, 5, 10].map((m) => (
            <button key={m} className="chip" onClick={() => setPreset(m)} disabled={working}>
              {m} 分間
            </button>
          ))}
        </div>
        <p className="small" style={{ margin: "10px 0 0" }}>
          {start != null && end != null && end > start ? (
            <>
              区間の長さ <b>{formatTime(end - start)}</b>
              {duration ? <span className="muted">（動画全体 {formatTime(duration)}）</span> : null}
            </>
          ) : null}
        </p>
        {rangeError && <p className="small" style={{ color: "var(--bad)", margin: "6px 0 0" }} role="alert">{RANGE_MESSAGES[rangeError]}</p>}
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          AI が処理するのはこの区間だけです（1 回 {MAX_RANGE_MS / 60000} 分まで）。字幕は全体を 1 回だけ取得して端末に保存します。
        </p>
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button className="btn" onClick={preview} disabled={!!rangeError || working || !!playerError}>
            ▶ 区間を試聴
          </button>
          {sameRange ? (
            <button className="btn primary grow" onClick={() => navigate(`/m/${encodeURIComponent(sameRange.id)}`)}>
              保存済みの教材を開く
            </button>
          ) : user ? (
            <button className="btn primary grow" onClick={() => void run()} disabled={!!rangeError || working}>
              この区間を教材にする
            </button>
          ) : authAvailable ? (
            <a className="btn primary grow" href={loginHref}>
              Google でログインして取り込む
            </a>
          ) : (
            <span className="small muted">ログインが使えません</span>
          )}
        </div>
      </section>

      {phase.k === "transcript" && (
        <section className="glass card" aria-live="polite">
          <h2>字幕を取得しています…</h2>
          <div className="bar">
            <div style={{ width: "15%" }} />
          </div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => abort.current?.abort()}>
            キャンセル
          </button>
        </section>
      )}
      {phase.k === "work" && (
        <section className="glass card" aria-live="polite">
          <h2>{phase.p.stage === "punct" ? "文の区切りを決めています" : phase.p.stage === "translate" ? "訳と意味のまとまりを作っています" : "保存しています"}</h2>
          <div className="bar">
            <div style={{ width: `${phase.p.stage === "punct" ? 15 + (35 * phase.p.done) / Math.max(1, phase.p.total) : phase.p.stage === "translate" ? 50 + (45 * phase.p.done) / Math.max(1, phase.p.total) : 98}%` }} />
          </div>
          <p className="small muted">
            {phase.p.done} / {phase.p.total}　済んだ部分は保存されるので、中断しても続きから再開できます
          </p>
          <button className="btn sm" onClick={() => abort.current?.abort()}>
            キャンセル
          </button>
        </section>
      )}
      {phase.k === "confirm" && start != null && end != null && (
        <section className="glass card">
          <h2>区間の端が文の途中です</h2>
          {phase.sugg.map((s) => (
            <div key={s.edge} className="flash small" style={{ marginBottom: 8 }}>
              {s.edge === "start" ? "開始" : "終了"} {formatTime(s.edge === "start" ? start : end, true)} が「{s.sentenceText.slice(0, 60)}{s.sentenceText.length > 60 ? "…" : ""}」の途中です。
            </div>
          ))}
          <div className="stack">
            <button
              className="btn primary"
              style={{ width: "100%" }}
              onClick={() => {
                const sS = phase.sugg.find((x) => x.edge === "start");
                const sE = phase.sugg.find((x) => x.edge === "end");
                void chooseSuggestion(sS?.widen ?? start, sE?.widen ?? end);
              }}
            >
              文が切れないように広げる（{formatTime(phase.sugg.find((x) => x.edge === "start")?.widen ?? start, true)}–{formatTime(phase.sugg.find((x) => x.edge === "end")?.widen ?? end, true)}）
            </button>
            {phase.sugg.every((x) => x.narrow != null) && (
              <button
                className="btn"
                style={{ width: "100%" }}
                onClick={() => {
                  const sS = phase.sugg.find((x) => x.edge === "start");
                  const sE = phase.sugg.find((x) => x.edge === "end");
                  void chooseSuggestion(sS?.narrow ?? start, sE?.narrow ?? end);
                }}
              >
                途中の文を外して狭める
              </button>
            )}
            <button className="btn ghost" style={{ width: "100%" }} onClick={() => void chooseSuggestion(start, end)}>
              このまま（端の文は「区間外を含む文」として表示）
            </button>
          </div>
        </section>
      )}
      {phase.k === "cancelled" && (
        <div className="flash card">
          中断しました。済んだ部分は保存してあります。
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void run()}>
            続きから再開
          </button>
        </div>
      )}
      {phase.k === "error" && (
        <div className="flash error card" role="alert">
          {phase.message}
          {phase.canRetry && (
            <div style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => void run()}>
                再試行（済んだ部分は再利用）
              </button>
            </div>
          )}
        </div>
      )}

      {user && (
        <section className="glass card">
          <h2>字幕が取れないとき</h2>
          <p className="small muted" style={{ marginTop: -4 }}>
            利用してよい字幕ファイル（SRT / VTT）か、YouTube の「文字起こしを表示」の内容を貼り付けて、この動画に紐づけられます。単語ごとの時刻が入った VTT（YouTube の自動字幕の形式）なら、その時刻をそのまま使います。
          </p>
          <div className="chips">
            <button className={`chip ${fallback === "file" ? "on" : ""}`} onClick={() => setFallback(fallback === "file" ? "none" : "file")}>
              字幕ファイル
            </button>
            <button className={`chip ${fallback === "paste" ? "on" : ""}`} onClick={() => setFallback(fallback === "paste" ? "none" : "paste")}>
              文字起こしを貼り付け
            </button>
          </div>
          {fallback === "file" && (
            <div style={{ marginTop: 10 }}>
              <input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" aria-label="字幕ファイル" onChange={(e) => void onFile(e.target.files?.[0])} disabled={working || !!rangeError} />
              {rangeError && <p className="small muted">先に区間を正しく指定してください</p>}
            </div>
          )}
          {fallback === "paste" && (
            <div style={{ marginTop: 10 }}>
              <textarea className="field" aria-label="文字起こし" placeholder={"0:00\nhello and welcome\n0:04\ntoday we're going to..."} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
              <p className="small muted">時刻は 1 秒単位なので、文の区切りの時刻は推定になります。</p>
              <button className="btn sm" onClick={() => void fromSegments(parsePastedTranscript(pasteText), "paste")} disabled={!pasteText.trim() || working || !!rangeError}>
                この字幕で取り込む
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
