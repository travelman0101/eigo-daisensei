import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { checkAnswer, clozeFromText, clozeFromWords, type Cloze } from "../../shared/quiz";
import { isDue, review } from "../../shared/srs";
import { useApp } from "../App";
import { db, guard, type TestResult, type VocabItem } from "../lib/db";
import { markDirty } from "../lib/sync";

type QType = "card" | "cloze" | "example";

interface Question {
  item: VocabItem;
  cloze: Cloze | null;
  accepted: string[];
  retry: boolean;
}

/** Builds questions from saved data only: no AI is called while testing or scoring. */
export function makeQuestion(item: VocabItem, type: QType): Question | null {
  if (type === "card") return { item, cloze: null, accepted: [], retry: false };
  if (type === "cloze") {
    const s = item.sources[0];
    if (!s) return null;
    const cz = clozeFromWords(s.words, s.wordFrom, s.wordTo);
    return { item, cloze: cz, accepted: [...new Set([cz.answer, ...item.entry.accepted])], retry: false };
  }
  const cz = item.entry.exampleSurface ? clozeFromText(item.entry.example, item.entry.exampleSurface) : null;
  return cz ? { item, cloze: cz, accepted: [...new Set([cz.answer, ...item.entry.exampleAccepted])], retry: false } : null;
}

const shuffle = <T,>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
};

export function TestScreen() {
  const { query, navigate, toast } = useApp();
  const type = (query.get("type") as QType) || "card";
  const scope = query.get("scope") || "all";
  const [queue, setQueue] = useState<Question[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [answer, setAnswer] = useState("");
  const [judged, setJudged] = useState<boolean | null>(null);
  const [score, setScore] = useState({ right: 0, wrong: 0, wrongIds: [] as string[] });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const now = Date.now();
      let items = (await db().getAll("vocab")).filter((v) => !v.deleted);
      if (scope === "due") items = items.filter((v) => isDue(v.review, now));
      else if (scope === "wrong") items = items.filter((v) => v.review.lastResult === "wrong");
      else if (scope.startsWith("m:")) items = items.filter((v) => v.sources.some((s) => s.materialId === scope.slice(2)));
      else if (scope.startsWith("ids:")) {
        const ids = new Set(scope.slice(4).split(","));
        items = items.filter((v) => ids.has(v.id));
      }
      // due words first, then the rest, each group shuffled
      const ordered = [...shuffle(items.filter((v) => isDue(v.review, now))), ...shuffle(items.filter((v) => !isDue(v.review, now)))];
      const qs = ordered.map((v) => makeQuestion(v, type)).filter((q): q is Question => !!q);
      setSkipped(ordered.length - qs.length);
      setQueue(qs.slice(0, 30));
    })();
  }, [type, scope]);

  useEffect(() => {
    if (type !== "card") input.current?.focus();
  }, [i, type, queue]);

  if (!queue) return <div className="sk" style={{ height: 240, borderRadius: 24, marginTop: 50 }} />;
  const q = queue[i];

  const record = async (correct: boolean, given?: string) => {
    if (!q) return;
    const now = Date.now();
    const item = { ...q.item, review: review(q.item.review, correct, now), updatedAt: now };
    try {
      await guard(db().put("vocab", item));
      await guard(db().add("results", { vocabId: item.id, type, correct, answer: given, at: now } as TestResult));
      await markDirty("vocab", item.id);
    } catch (e) {
      toast((e as Error).message, "error");
    }
    setScore((s) => ({ right: s.right + (correct ? 1 : 0), wrong: s.wrong + (correct ? 0 : 1), wrongIds: correct || s.wrongIds.includes(item.id) ? s.wrongIds : [...s.wrongIds, item.id] }));
    // a missed word comes back once more at the end of this test
    if (!correct && !q.retry) setQueue((qq) => [...qq!, { ...q, item, retry: true }]);
  };

  const next = () => {
    setI((x) => x + 1);
    setShown(false);
    setAnswer("");
    setJudged(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (judged !== null) return next();
    if (!answer.trim()) return;
    const ok = checkAnswer(answer, q!.accepted);
    setJudged(ok);
    await record(ok, answer);
  };

  if (!queue.length)
    return (
      <main>
        <h1>単語テスト</h1>
        <div className="glass card">
          <p style={{ marginTop: 0 }}>出題できる単語がありません。</p>
          {skipped > 0 && <p className="small muted">この形式の問題がまだない単語が {skipped} 件あります。カード形式なら復習できます。</p>}
          <button className="btn" onClick={() => navigate("/vocab")}>
            単語帳へ
          </button>
        </div>
      </main>
    );

  if (!q)
    return (
      <main>
        <h1>おつかれさま</h1>
        <div className="glass card stack">
          <div className="big-word">
            {score.right} / {score.right + score.wrong}
          </div>
          <p className="small muted">結果はこの端末に保存し、次の復習の時期を決めました（正解で間隔が延び、まちがえると明日以降すぐ出ます）。</p>
          {score.wrongIds.length > 0 && (
            <button className="btn primary" onClick={() => navigate(`/vocab/test?type=${type}&scope=${encodeURIComponent(`ids:${score.wrongIds.join(",")}`)}`, true)}>
              まちがえた {score.wrongIds.length} 語をもう一度
            </button>
          )}
          <button className="btn" onClick={() => navigate("/vocab")}>
            単語帳へ
          </button>
        </div>
      </main>
    );

  const e = q.item.entry;
  return (
    <main>
      <div className="row between">
        <button className="btn sm ghost" onClick={() => navigate("/vocab")}>
          ← やめる
        </button>
        <span className="small muted">
          {i + 1} / {queue.length}
          {q.retry ? "（もう一度）" : ""}
        </span>
      </div>
      <div className="bar" style={{ margin: "8px 0 14px" }}>
        <div style={{ width: `${(i / queue.length) * 100}%` }} />
      </div>
      {skipped > 0 && i === 0 && <p className="small muted">問題がまだない単語 {skipped} 件は除きました。</p>}
      <motion.div key={i} className="glass card quiz-card" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }}>
        {type === "card" ? (
          <div className="stack" style={{ width: "100%" }}>
            <div className="big-word">{e.lemma}</div>
            {q.item.sources[0] && <div className="small muted">「{q.item.sources[0].sentence}」</div>}
            {shown ? (
              <>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{e.meaning}</div>
                {e.note && <div className="small">{e.note}</div>}
                <div className="row" style={{ justifyContent: "center" }}>
                  <button className="btn" onClick={async () => (await record(false), next())}>
                    忘れていた
                  </button>
                  <button className="btn primary" onClick={async () => (await record(true), next())}>
                    覚えていた
                  </button>
                </div>
              </>
            ) : (
              <button className="btn primary" onClick={() => setShown(true)}>
                答えを見る
              </button>
            )}
          </div>
        ) : (
          <form className="stack" style={{ width: "100%" }} onSubmit={submit}>
            <div className="small muted">{type === "cloze" ? "動画での発言" : "例文（AI が作成）"}　ヒント: {e.meaning}</div>
            <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.6 }}>
              {q.cloze!.before} <span className="blank">{judged !== null ? q.cloze!.answer : " "}</span> {q.cloze!.after}
            </div>
            {type === "example" && <div className="small muted">{e.exampleJa}</div>}
            <input ref={input} className="field" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="英語で入力" value={answer} onChange={(ev) => setAnswer(ev.target.value)} readOnly={judged !== null} aria-label="答え" />
            {judged !== null && (
              <div className={`flash ${judged ? "" : "error"}`} role="status">
                {judged ? "正解！" : `正解は「${q.cloze!.answer}」`}
                {!judged && q.accepted.length > 1 && <span className="small">（ほかに: {q.accepted.filter((a) => a !== q.cloze!.answer).join(", ")}）</span>}
              </div>
            )}
            <button className="btn primary" type="submit" disabled={!answer.trim() && judged === null}>
              {judged === null ? "答える" : "次へ"}
            </button>
          </form>
        )}
      </motion.div>
    </main>
  );
}
