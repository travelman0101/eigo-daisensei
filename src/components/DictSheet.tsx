import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { DictEntry, Material, Sentence } from "../../shared/types";
import { useApp } from "../App";
import { ApiError } from "../lib/api";
import { db } from "../lib/db";
import { lookupTerm, saveVocab, sourceOf, vocabId } from "../lib/vocab";

interface Props {
  material: Material;
  sentence: Sentence | null;
  from: number;
  to: number;
  onRange: (from: number, to: number) => void;
  onClose: (replay: boolean) => void;
}

const strip = (w: string) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "");

/** Bottom sheet with the meaning of the selected word(s) in this sentence. */
export function DictSheet({ material, sentence, from, to, onRange, onClose }: Props) {
  const { toast } = useApp();
  const [entry, setEntry] = useState<DictEntry | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const open = !!sentence;
  const words = sentence?.words.map((w) => w.w) ?? [];
  const term = words.slice(from, to + 1).map(strip).filter(Boolean).join(" ");

  useEffect(() => {
    if (!sentence || !term) return;
    let alive = true;
    setEntry(null);
    setError("");
    setSaved(false);
    lookupTerm(term, sentence.text)
      .then(async ({ entry }) => {
        if (!alive) return;
        setEntry(entry);
        setSaved(!!(await db().get("vocab", vocabId(entry))));
      })
      .catch((e: ApiError) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [sentence, term]);

  const save = async () => {
    if (!entry || !sentence) return;
    try {
      const r = await saveVocab(entry, sourceOf(material, sentence, from, to));
      setSaved(true);
      toast(r.merged ? "保存済みの単語に、この場面を追加しました" : r.otherSenses ? `別の意味として保存しました（同じ語の意味がほかに ${r.otherSenses} 件）` : "単語帳に保存しました");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => onClose(false)} />
          <motion.div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`${term} の意味`}
            initial={{ y: "100%", x: "-50%" }}
            animate={{ y: 0, x: "-50%" }}
            exit={{ y: "100%", x: "-50%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
          >
            <div className="grab" />
            <div className="row between">
              <div className="row" style={{ gap: 4 }}>
                <button className="icon-btn" aria-label="前の語も含める" disabled={from === 0} onClick={() => onRange(from - 1, to)}>
                  ←
                </button>
                <div style={{ fontSize: 24, fontWeight: 800, padding: "0 6px" }}>{term}</div>
                <button className="icon-btn" aria-label="次の語も含める" disabled={to >= words.length - 1 || to - from >= 5} onClick={() => onRange(from, to + 1)}>
                  →
                </button>
              </div>
              {to > from && (
                <button className="btn sm ghost" onClick={() => onRange(from, from)}>
                  1 語に戻す
                </button>
              )}
            </div>
            <p className="small muted" style={{ margin: "2px 0 10px" }}>
              ← → で前後の語を足すと、熟語・句動詞として調べられます
            </p>
            {error ? (
              <div className="flash error">{error}</div>
            ) : !entry ? (
              <div aria-busy="true">
                <div className="sk" style={{ height: 22, width: "50%", marginBottom: 10 }} />
                <div className="sk" style={{ height: 16, marginBottom: 8 }} />
                <div className="sk" style={{ height: 16, width: "80%" }} />
              </div>
            ) : (
              <div className="stack">
                <div>
                  <span className="badge gray">{entry.pos}</span> <span className="small muted">原形: {entry.lemma}</span>
                  <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6 }}>{entry.meaning}</div>
                  {entry.note && <div className="small" style={{ marginTop: 4 }}>{entry.note}</div>}
                </div>
                <div className="flash">
                  <div className="small muted">動画での発言</div>
                  <div style={{ fontWeight: 600 }}>
                    {words.map((w, i) => (
                      <span key={i} style={i >= from && i <= to ? { color: "var(--accent)", fontWeight: 800 } : undefined}>
                        {w}{" "}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="small muted">例文（AI が作成）</div>
                  <div style={{ fontWeight: 600 }}>{entry.example}</div>
                  <div className="small">{entry.exampleJa}</div>
                </div>
              </div>
            )}
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn primary grow" disabled={!entry || saved} onClick={save}>
                {saved ? "✓ 単語帳に保存済み" : "単語帳に保存"}
              </button>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn grow" onClick={() => onClose(true)}>
                閉じて元の文を再生
              </button>
              <button className="btn ghost" onClick={() => onClose(false)}>
                閉じる
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
