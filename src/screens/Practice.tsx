import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Material } from "../../shared/types";
import { formatTime, watchUrl } from "../../shared/youtube";
import { useApp } from "../App";
import { DictSheet } from "../components/DictSheet";
import { Recorder } from "../components/Recorder";
import { db, getKv, getSettings, guard, setKv, type Progress, type Rating, type Settings } from "../lib/db";
import { openSample, refreshSample } from "../lib/samples";
import { markDirty } from "../lib/sync";
import { Engine, buildUnits, type EngineState } from "../player/engine";
import { createYouTube, type PlayerLike } from "../player/yt";

/** The suggested practice flow. Each step only presets settings; any step can be skipped or changed. */
export const STEPS: { n: number; name: string; hint: string; preset: Partial<Settings> }[] = [
  { n: 1, name: "聞く", hint: "字幕なしで内容と話し方をつかむ", preset: { mode: "listen", autoStop: false, unit: "sentence", showEn: false, showJa: false } },
  { n: 2, name: "意味を確認", hint: "一文ずつ止めて字幕・訳・単語を見る", preset: { mode: "listen", autoStop: true, unit: "sentence", showEn: true, showJa: true } },
  { n: 3, name: "区切ってまねる", hint: "止まったら声に出す（リピーティング）", preset: { mode: "repeat", unit: "chunk", repeats: 3, gapMode: "ratio", gapRatio: 1, showEn: true, showJa: false } },
  { n: 4, name: "追いかけて話す", hint: "止めずに少し遅れてまねる（シャドーイング）", preset: { mode: "shadow", unit: "sentence", repeats: 3, showEn: true, showJa: false } },
  { n: 5, name: "字幕なし", hint: "字幕を隠して一文〜数文で", preset: { mode: "shadow", unit: "multi", multiCount: 2, repeats: 2, showEn: false, showJa: false } },
];

const RATES = [0.5, 0.75, 0.9, 1, 1.25, 1.5];
const RATING_LABEL: Record<Rating, string> = { hard: "まだ難しい", again: "もう一度", ok: "できた" };

export function Practice({ id }: { id: string }) {
  const { navigate, toast } = useApp();
  const [m, setM] = useState<Material | null | undefined>(undefined);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [es, setEs] = useState<EngineState | null>(null);
  const [t, setT] = useState(0);
  const [ready, setReady] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [sheet, setSheet] = useState<{ s: number; from: number; to: number } | null>(null);
  const [panel, setPanel] = useState<"none" | "settings" | "timing">("none");
  const [tip, setTip] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [ab, setAb] = useState<{ a: number | null }>({ a: null });
  const [tapHint, setTapHint] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerLike | null>(null);
  const engine = useRef<Engine | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const progressRef = useRef<Progress | null>(null);

  // load material, progress and settings from the device (no network, no AI)
  useEffect(() => {
    (async () => {
      // a built-in sample opened by link for the first time on this device is copied in from the app
      if (id.startsWith("sample_") && !(await db().get("materials", id))) await openSample(id.slice(7)).catch(() => {});
      const mat = await db().get("materials", id);
      if (!mat) return setM(null);
      const p: Progress = (await db().get("progress", id)) ?? { materialId: id, sentenceIndex: 0, ratings: {}, adjust: {}, plays: 0, lastAt: Date.now(), updatedAt: Date.now() };
      progressRef.current = p;
      setProgress(p);
      setSettings(await getSettings());
      setM(mat);
      if (mat.sample && navigator.onLine) void refreshSample(id.slice(7)).then((fresh) => fresh && setM(fresh));
      setTip(!(await getKv("seenPracticeTip", false)));
      await setKv("lastMaterial", id);
    })();
  }, [id]);

  // rebuild units only when a timing correction changes (not on every play count or rating)
  const adjustKey = JSON.stringify(progress?.adjust ?? {});
  const adjustMap = useMemo(() => JSON.parse(adjustKey) as Progress["adjust"], [adjustKey]);
  const adjustOf = useCallback((i: number) => (m && adjustMap[m.sentences[i]!.id]) || { s: 0, e: 0 }, [m, adjustMap]);

  const units = useMemo(() => (m && settings ? buildUnits(m.sentences, settings.unit, settings.multiCount, adjustOf) : []), [m, settings?.unit, settings?.multiCount, adjustOf]);

  const persistProgress = useCallback((patch: Partial<Progress>) => {
    const cur = progressRef.current;
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    progressRef.current = next;
    setProgress(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      guard(db().put("progress", next))
        .then(() => markDirty("progress", next.materialId))
        .catch((e: Error) => toast(e.message, "error"));
    }, 600);
  }, [toast]);

  // player + engine
  useEffect(() => {
    if (!m || !settings || !holder.current) return;
    let alive = true;
    const startSentence = m.sentences[progressRef.current?.sentenceIndex ?? 0] ?? m.sentences[0];
    createYouTube(holder.current, m.videoId, Math.max(0, (startSentence?.start ?? m.start) - 500), (e) => {
      if (e.type === "ready") setReady(true);
      if (e.type === "error") setPlayerError(e.message);
      if (e.type === "state" && e.playing) setTapHint(false);
    })
      .then((p) => {
        if (!alive) return p.destroy();
        player.current = p;
        const eng = new Engine(p, units, settings, { start: m.start, end: m.end }, setEs);
        engine.current = eng;
        eng.setUnits(units, progressRef.current?.sentenceIndex ?? 0);
        setReady(true);
      })
      .catch((e: Error) => setPlayerError(e.message));
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      engine.current?.tick();
      if (now - last > 90 && player.current) {
        last = now;
        setT(player.current.time());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // animation frames stop while the page is not drawn (another tab or window in front),
    // so a timer keeps sentence-end stops working; browsers still run it at least once a second
    const iv = setInterval(() => engine.current?.tick(), 100);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearInterval(iv);
      engine.current?.destroy();
      player.current?.destroy();
      engine.current = null;
      player.current = null;
    };
    // the player is created once per material; units/settings are pushed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.id, !!settings]);

  useEffect(() => {
    if (engine.current && units.length) engine.current.setUnits(units, progressRef.current?.sentenceIndex ?? 0);
  }, [units]);
  useEffect(() => {
    if (engine.current && settings) engine.current.setSettings(settings);
  }, [settings]);

  // remember where we are
  const curUnit = es ? units[es.unit] : undefined;
  const curSentence = curUnit?.sentence ?? progress?.sentenceIndex ?? 0;
  useEffect(() => {
    if (progressRef.current && curSentence !== progressRef.current.sentenceIndex) persistProgress({ sentenceIndex: curSentence, lastAt: Date.now() });
  }, [curSentence, persistProgress]);
  const lastPhase = useRef<string>("idle");
  useEffect(() => {
    if (es?.phase === "playing" && lastPhase.current !== "playing") persistProgress({ plays: (progressRef.current?.plays ?? 0) + 1, lastAt: Date.now() });
    lastPhase.current = es?.phase ?? "idle";
  }, [es?.phase, persistProgress]);

  // keep the current sentence visible in list view
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${curSentence}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [curSentence, settings?.view]);

  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s!, ...patch };
      void setKv("settings", next).then(() => markDirty("settings", "settings")).catch((e: Error) => toast(e.message, "error"));
      return next;
    });
  };

  const firstPlay = (fn: () => void) => {
    fn();
    // mobile browsers may block the first programmatic play: ask for one tap on the video itself
    setTimeout(() => {
      if (player.current && !player.current.playing() && engine.current?.state.phase === "playing") setTapHint(true);
    }, 1800);
  };

  if (m === undefined || !settings) return <PracticeSkeleton />;
  if (m === null)
    return (
      <main>
        <p>教材が見つかりません（別のアカウントで保存したか、削除された可能性があります）。</p>
        <button className="btn" onClick={() => navigate("/")}>
          ホームへ
        </button>
      </main>
    );

  const sIdx = Math.min(curSentence, m.sentences.length - 1);
  const s = m.sentences[sIdx]!;
  const playing = es?.phase === "playing";
  const gapLeft = es?.phase === "gap" && es.gapUntil ? Math.max(0, es.gapUntil - performance.now()) : 0;
  const chunkIdx = settings.unit === "chunk" && curUnit ? units.slice(0, es!.unit + 1).filter((u) => u.sentence === sIdx).length - 1 : -1;
  const step = STEPS.find((x) => x.n === settings.step);
  const rating = progress?.ratings[s.id];
  const adj = progress?.adjust[s.id] ?? { s: 0, e: 0 };

  const tapWord = (si: number, wi: number) => {
    engine.current?.pause();
    setSheet({ s: si, from: wi, to: wi });
  };

  const renderEn = (si: number, big: boolean) => {
    const sen = m.sentences[si]!;
    const chunkStarts = new Set(sen.chunks);
    const isCur = si === sIdx;
    let ci = -1;
    return (
      <div className={`en ${!settings.showEn && !reveal ? "hidden-text" : ""}`} style={big ? undefined : { fontSize: 17 }}>
        {sen.words.map((w, wi) => {
          if (chunkStarts.has(wi)) ci++;
          const showSep = settings.unit === "chunk" && wi > 0 && chunkStarts.has(wi);
          const cls = settings.unit === "chunk" && isCur && chunkIdx >= 0 ? (ci === chunkIdx ? "chunk-on" : "chunk-off") : "";
          const sel = sheet && sheet.s === si && wi >= sheet.from && wi <= sheet.to;
          return (
            <span key={wi}>
              {showSep && <span className="sep">/</span>}
              <span
                className={`w ${cls} ${sel ? "sel" : ""}`}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  tapWord(si, wi);
                }}
                onKeyDown={(e) => e.key === "Enter" && tapWord(si, wi)}
              >
                {w.w}
              </span>{" "}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <main style={{ paddingBottom: 150 }}>
      <div className="practice-top">
        <div className="row between" style={{ marginBottom: 6 }}>
          <button className="btn sm ghost" onClick={() => navigate(m.sample ? "/" : "/library")}>
            ← 戻る
          </button>
          <div className="small muted grow" style={{ textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.title}
          </div>
          <a className="btn sm ghost" href={watchUrl(m.videoId, s.start)} target="_blank" rel="noreferrer">
            YouTube
          </a>
        </div>
        <div className={`video ${window.__FAKE_YT__ ? "fake" : ""}`} ref={holder} />
      </div>
      {playerError && <div className="flash error" style={{ marginBottom: 10 }}>{playerError}　字幕と単語テストは引き続き使えます。</div>}
      {tapHint && <div className="flash warn small">スマホでは最初の 1 回だけ、動画の上の再生ボタンを直接タップしてください（ブラウザの自動再生の制限）</div>}

      <div className="steps" role="tablist" aria-label="練習の流れ">
        {STEPS.map((x) => (
          <button key={x.n} role="tab" aria-selected={settings.step === x.n} className={`step ${settings.step === x.n ? "on" : ""}`} onClick={() => updateSettings({ ...x.preset, step: x.n })}>
            <b>{x.n}</b>
            {x.name}
          </button>
        ))}
      </div>
      {step && <p className="small muted one-line" style={{ margin: "0 4px 8px" }}>{step.hint}</p>}


      {m.sample && (
        <div className="small muted" style={{ margin: "0 4px 10px" }}>
          <span className="badge">{m.sample.level} の目安</span> {m.sample.reason}
          <br />
          出典: <a href={m.sample.sourceUrl} target="_blank" rel="noreferrer">{m.sample.credit}</a>（{m.sample.license}）。レベルは目安で、公式の判定ではありません。
        </div>
      )}

      {settings.view === "current" ? (
        <motion.div key={s.id} className="sentence-card" initial={{ opacity: 0.4, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} onClick={() => !settings.showEn && setReveal((r) => !r)}>
          <div className="row between small muted" style={{ marginBottom: 6 }}>
            <span>
              {sIdx + 1} / {m.sentences.length}　{formatTime(s.start, true)}
            </span>
            <span className="row" style={{ gap: 4 }}>
              {s.timing === "estimated" && <span className="badge warn" title="字幕の行の途中で区切ったため、時刻は文字数から推定しています">時刻は推定</span>}
              {s.edge && <span className="badge gray">区間外を含む文</span>}
            </span>
          </div>
          {renderEn(sIdx, true)}
          {!settings.showEn && <div className="small muted">{reveal ? "タップで隠す" : "字幕を隠しています（タップで表示）"}</div>}
          {settings.showJa && s.ja && <div className="ja">{s.ja}</div>}
          {settings.showJa && !s.ja && <div className="ja muted small">訳がありません（解析の一部が失敗しました）</div>}
          <div className="row wrap" style={{ marginTop: 12, gap: 6 }} onClick={(e) => e.stopPropagation()}>
            {(Object.keys(RATING_LABEL) as Rating[]).map((r) => (
              <button key={r} className={`chip ${rating === r ? "on" : ""}`} aria-pressed={rating === r} onClick={() => persistProgress({ ratings: { ...progress!.ratings, [s.id]: r } })}>
                {RATING_LABEL[r]}
              </button>
            ))}
          </div>
        </motion.div>
      ) : (
        <div className="sent-list" ref={listRef}>
          {m.sentences.map((x, i) => (
            <div
              key={x.id}
              data-i={i}
              className={`s ${i === sIdx ? "cur" : ""} ${x.edge ? "edge" : ""}`}
              onClick={() => {
                const u = units.findIndex((uu) => uu.sentence === i);
                if (u >= 0) firstPlay(() => engine.current?.playUnit(u));
              }}
            >
              <div className="small muted">
                {formatTime(x.start)} {progress?.ratings[x.id] ? `・${RATING_LABEL[progress.ratings[x.id]!]}` : ""}
              </div>
              {renderEn(i, false)}
              {settings.showJa && <div className="ja small">{x.ja}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="row wrap" style={{ margin: "12px 0", gap: 6 }}>
        <button className={`chip ${settings.view === "list" ? "on" : ""}`} onClick={() => updateSettings({ view: settings.view === "list" ? "current" : "list" })}>
          前後の字幕
        </button>
        <button className={`chip ${settings.showEn ? "on" : ""}`} aria-pressed={settings.showEn} onClick={() => updateSettings({ showEn: !settings.showEn })}>
          英語字幕
        </button>
        <button className={`chip ${settings.showJa ? "on" : ""}`} aria-pressed={settings.showJa} onClick={() => updateSettings({ showJa: !settings.showJa })}>
          訳
        </button>
        <button className={`chip ${panel === "timing" ? "on" : ""}`} onClick={() => setPanel(panel === "timing" ? "none" : "timing")}>
          時刻の補正
        </button>
      </div>
      <div style={{ margin: "0 0 12px" }}>
        <Recorder sentenceId={s.id} onPlayOriginal={() => engine.current?.playUnit(units.findIndex((u) => u.sentence === sIdx))} />
      </div>

      {tip && (
        <div className="flash card small">
          おすすめの流れ: ① 聞く → ② 意味を確認 → ③ 区切ってまねる → ④ 追いかけて話す → ⑤ 字幕なし。どこからでも始められ、設定は自動で保存されます。単語をタップすると意味が出ます。
          <div style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={() => (setTip(false), void setKv("seenPracticeTip", true))}>
              わかった
            </button>
          </div>
        </div>
      )}
      <AnimatePresence>
        {panel === "timing" && (
          <motion.section className="glass card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <h2>この文の時刻を補正</h2>
            <p className="small muted" style={{ marginTop: -4 }}>
              語頭が切れる・前の文が混ざるときに 0.1 秒ずつ調整できます（保存されます）。
            </p>
            {(["s", "e"] as const).map((k) => (
              <div key={k} className="row" style={{ marginBottom: 8 }}>
                <span className="grow small">
                  {k === "s" ? "開始" : "終了"} {formatTime((k === "s" ? s.start : s.end) + adj[k], true)}
                  {adj[k] ? `（${adj[k] > 0 ? "+" : ""}${(adj[k] / 1000).toFixed(1)} 秒）` : ""}
                </span>
                {[-100, 100].map((d) => (
                  <button key={d} className="btn sm" onClick={() => persistProgress({ adjust: { ...progress!.adjust, [s.id]: { ...adj, [k]: adj[k] + d } } })}>
                    {d < 0 ? "−0.1" : "+0.1"}
                  </button>
                ))}
              </div>
            ))}
            <div className="row">
              <button className="btn sm" onClick={() => engine.current?.playUnit(units.findIndex((u) => u.sentence === sIdx))}>
                ▶ 確かめる
              </button>
              <button className="btn sm ghost" onClick={() => persistProgress({ adjust: { ...progress!.adjust, [s.id]: { s: 0, e: 0 } } })}>
                元に戻す
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {createPortal(
        <>
      <div className="controls glass">
        <div className="chips" style={{ justifyContent: "center", marginBottom: 8 }}>
          {(["chunk", "sentence", "multi"] as const).map((u) => (
            <button key={u} className={`chip ${settings.unit === u ? "on" : ""}`} onClick={() => updateSettings({ unit: u })}>
              {u === "chunk" ? "まとまり" : u === "sentence" ? "一文" : `${settings.multiCount}文`}
            </button>
          ))}
          <button className="chip" onClick={() => updateSettings({ rate: RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length]! })} aria-label="再生速度">
            {settings.rate}x
          </button>
          <button className="chip" onClick={() => updateSettings({ repeats: settings.repeats >= 5 ? (settings.repeats === 0 ? 1 : 0) : settings.repeats + 1 })} aria-label="反復回数">
            ×{settings.repeats === 0 ? "∞" : settings.repeats}
          </button>
          <button className="chip" onClick={() => setPanel(panel === "settings" ? "none" : "settings")} aria-label="詳しい設定">
            ⚙
          </button>
        </div>
        <div className="main">
          <button className="icon-btn" aria-label="前へ" onClick={() => engine.current?.prev()} disabled={!ready}>
            ⏮
          </button>
          <button className="icon-btn" aria-label="同じところをもう一度" onClick={() => firstPlay(() => engine.current?.restart())} disabled={!ready}>
            ↺
          </button>
          <button className="icon-btn big" aria-label={playing ? "停止" : "再生"} onClick={() => firstPlay(() => (es?.phase === "gap" ? engine.current?.pause() : engine.current?.toggle()))} disabled={!ready}>
            {playing || es?.phase === "gap" ? "⏸" : "▶"}
          </button>
          <button className="icon-btn" aria-label="次へ" onClick={() => engine.current?.next()} disabled={!ready}>
            ⏭
          </button>
          <button
            className={`icon-btn ${es?.ab ? "on" : ""}`}
            aria-label="A–B ループ"
            onClick={() => {
              if (es?.ab) {
                engine.current?.clearAB();
                setAb({ a: null });
              } else if (ab.a == null) {
                setAb({ a: t });
                toast("A を記録しました。終わりの位置でもう一度押してください");
              } else {
                engine.current?.setAB(Math.min(ab.a, t), Math.max(ab.a, t));
                setAb({ a: null });
              }
            }}
            disabled={!ready}
          >
            {es?.ab ? "AB✓" : ab.a != null ? "B?" : "AB"}
          </button>
        </div>
        {es?.phase === "gap" && (
          <div className="row" style={{ marginTop: 6 }}>
            <div className="gapbar grow" aria-label="待ち時間">
              <div style={{ width: `${Math.max(0, 100 - (gapLeft / Math.max(1, es.gapMs)) * 100)}%` }} />
            </div>
            <span className="small muted">話してみよう {Math.ceil(gapLeft / 1000)}s</span>
            <button className="btn sm ghost" onClick={() => engine.current?.skipGap()}>
              飛ばす
            </button>
          </div>
        )}
        {settings.repeats > 1 && es && es.phase !== "idle" && (
          <div className="progress-dots" aria-label={`${es.rep + 1} 回目`}>
            {Array.from({ length: settings.repeats }, (_, i) => (
              <i key={i} className={i <= es.rep ? "on" : ""} />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {panel === "settings" && (
          <>
            <motion.div className="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPanel("none")} />
            <motion.div className="sheet" role="dialog" aria-label="練習の設定" initial={{ y: "100%", x: "-50%" }} animate={{ y: 0, x: "-50%" }} exit={{ y: "100%", x: "-50%" }} transition={{ type: "spring", damping: 30, stiffness: 320 }}>
              <div className="grab" />
              <PracticeSettings settings={settings} update={updateSettings} />
              <div className="stack" style={{ marginTop: 14 }}>
                <button className="btn" style={{ width: "100%" }} onClick={() => (setPanel("none"), firstPlay(() => engine.current?.playRange(0)))}>
                  ▶ 取り込んだ区間を最初から通して再生
                </button>
                <button className="btn" style={{ width: "100%" }} onClick={() => (setPanel("none"), firstPlay(() => engine.current?.playRange(es?.unit ?? 0)))}>
                  ▶ 今の文から最後まで通して再生
                </button>
                <p className="small muted">
                  区間 {formatTime(m.start)}–{formatTime(m.end)}・{m.sentences.length} 文・解析版 v{m.analysisVersion}
                  {m.punctuatedByAi ? "・句読点は AI が補完（単語は元の字幕のまま）" : ""}
                </p>
                <button className="btn ghost" onClick={() => setPanel("none")}>
                  閉じる
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <DictSheet
        material={m}
        sentence={sheet ? m.sentences[sheet.s]! : null}
        from={sheet?.from ?? 0}
        to={sheet?.to ?? 0}
        onRange={(from, to) => setSheet((x) => (x ? { ...x, from, to } : x))}
        onClose={(replay) => {
          const si = sheet?.s;
          setSheet(null);
          if (replay && si != null) {
            const u = units.findIndex((uu) => uu.sentence === si);
            if (u >= 0) engine.current?.playUnit(u);
          }
        }}
      />
        </>,
        document.body,
      )}
    </main>
  );
}

function PracticeSettings({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const Seg = <T extends string | number | boolean>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) => (
    <div style={{ marginBottom: 12 }}>
      <div className="label">{label}</div>
      <div className="chips wrap" style={{ flexWrap: "wrap" }}>
        {options.map(([v, l]) => (
          <button key={String(v)} className={`chip ${value === v ? "on" : ""}`} aria-pressed={value === v} onClick={() => onChange(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div>
      <h2>練習の設定</h2>
      <p className="small muted" style={{ marginTop: -4 }}>
        初期値は開発者の提案です（最適値の保証ではありません）。変更は自動で保存されます。
      </p>
      <Seg label="練習のしかた" value={settings.mode} options={[["listen", "聞く"], ["repeat", "止めてまねる（リピーティング）"], ["shadow", "止めずに追いかける（シャドーイング）"]]} onChange={(mode) => update({ mode })} />
      <Seg label="区切り" value={settings.unit} options={[["chunk", "意味のまとまり"], ["sentence", "一文"], ["multi", "複数の文"]]} onChange={(unit) => update({ unit })} />
      {settings.unit === "multi" && <Seg label="何文ずつ" value={settings.multiCount} options={[[2, "2"], [3, "3"], [4, "4"], [5, "5"]]} onChange={(multiCount) => update({ multiCount })} />}
      <Seg label="反復回数" value={settings.repeats} options={[[1, "1"], [2, "2"], [3, "3"], [5, "5"], [10, "10"], [0, "∞"]]} onChange={(repeats) => update({ repeats })} />
      <Seg label="反復の間の待ち時間（リピーティング）" value={settings.gapMode} options={[["none", "なし"], ["fixed", "秒数で"], ["ratio", "聞いた長さに合わせる"]]} onChange={(gapMode) => update({ gapMode })} />
      {settings.gapMode === "fixed" && <Seg label="待つ秒数" value={settings.gapFixed} options={[[1, "1"], [2, "2"], [3, "3"], [5, "5"], [10, "10"]]} onChange={(gapFixed) => update({ gapFixed })} />}
      {settings.gapMode === "ratio" && <Seg label="聞いた長さの何倍待つか" value={settings.gapRatio} options={[[0.5, "0.5"], [1, "1"], [1.5, "1.5"], [2, "2"]]} onChange={(gapRatio) => update({ gapRatio })} />}
      <Seg label="再生速度" value={settings.rate} options={RATES.map((r) => [r, `${r}x`] as [number, string])} onChange={(rate) => update({ rate })} />
      <Seg label="「聞く」で文末に止める" value={settings.autoStop} options={[[true, "止める"], [false, "続けて再生"]]} onChange={(autoStop) => update({ autoStop })} />
      <Seg label="前後の余白（語頭・語尾が切れるとき）" value={`${settings.padPre}/${settings.padPost}`} options={[["0/0", "なし"], ["150/250", "標準"], ["300/500", "多め"]]} onChange={(v) => {
        const [a, b] = v.split("/").map(Number);
        update({ padPre: a!, padPost: b! });
      }} />
    </div>
  );
}

function PracticeSkeleton() {
  return (
    <main aria-busy="true">
      <div className="sk" style={{ aspectRatio: "16/9", borderRadius: 16, marginTop: 40 }} />
      <div className="sk" style={{ height: 40, margin: "14px 0" }} />
      <div className="sk" style={{ height: 150, borderRadius: 24 }} />
    </main>
  );
}
