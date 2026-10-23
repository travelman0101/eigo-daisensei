import { useEffect, useMemo, useState } from "react";
import { isDue } from "../../shared/srs";
import { formatTime } from "../../shared/youtube";
import { useApp } from "../App";
import { db, type VocabItem } from "../lib/db";
import { deleteVocab } from "../lib/vocab";

export function Vocab() {
  const { navigate, version, refresh, toast } = useApp();
  const [items, setItems] = useState<VocabItem[] | null>(null);
  const [q, setQ] = useState("");
  const [materials, setMaterials] = useState<{ id: string; title: string }[]>([]);
  const [scope, setScope] = useState("all");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setItems((await db().getAll("vocab")).sort((a, b) => b.createdAt - a.createdAt));
      setMaterials((await db().getAll("materials")).map((m) => ({ id: m.id, title: m.title })));
    })();
  }, [version]);

  const now = Date.now();
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items ?? []).filter((v) => !s || v.entry.lemma.toLowerCase().includes(s) || v.term.toLowerCase().includes(s) || v.entry.meaning.includes(s));
  }, [items, q]);
  const due = (items ?? []).filter((v) => isDue(v.review, now)).length;
  const wrong = (items ?? []).filter((v) => v.review.lastResult === "wrong").length;
  const usedMaterials = materials.filter((m) => (items ?? []).some((v) => v.sources.some((s) => s.materialId === m.id)));

  return (
    <main>
      <h1>単語帳</h1>
      <section className="glass card">
        <h2>単語テスト</h2>
        <div className="label">出題する範囲</div>
        <select className="field" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="出題する範囲">
          <option value="all">すべての単語（{items?.length ?? 0}）</option>
          <option value="due">復習の時期が来た単語（{due}）</option>
          <option value="wrong">前回まちがえた単語（{wrong}）</option>
          {usedMaterials.map((m) => (
            <option key={m.id} value={`m:${m.id}`}>
              教材: {m.title.slice(0, 40)}
            </option>
          ))}
        </select>
        <div className="row wrap" style={{ marginTop: 10 }}>
          {(
            [
              ["card", "カード（英→意味）"],
              ["cloze", "出典の文で穴埋め"],
              ["example", "例文で穴埋め"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} className={`btn ${t === "card" ? "primary" : ""}`} disabled={!items?.length} onClick={() => navigate(`/vocab/test?type=${t}&scope=${encodeURIComponent(scope)}`)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <input className="field" placeholder="単語・意味で探す" value={q} onChange={(e) => setQ(e.target.value)} aria-label="単語を探す" style={{ marginBottom: 12 }} />

      <section className="glass card">
        {items === null ? (
          <div className="sk" style={{ height: 80 }} />
        ) : shown.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            {items.length ? "見つかりません" : "練習画面で字幕の単語をタップすると、意味を見て保存できます。"}
          </p>
        ) : (
          shown.map((v) => (
            <div key={v.id} style={{ borderBottom: "1px solid var(--line)", padding: "10px 4px" }}>
              <button className="item" style={{ padding: 0 }} onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
                <div className="grow">
                  <div style={{ fontWeight: 800, fontSize: 17 }}>
                    {v.entry.lemma} <span className="badge gray">{v.entry.pos}</span>{" "}
                    {v.review.lastResult === "wrong" && <span className="badge warn">まちがえた</span>}
                  </div>
                  <div>{v.entry.meaning}</div>
                </div>
                <span className="small muted">箱 {v.review.box + 1}</span>
              </button>
              {open === v.id && (
                <div className="stack small" style={{ marginTop: 8 }}>
                  {v.entry.note && <div>{v.entry.note}</div>}
                  <div>
                    <div className="muted">例文（AI が作成）</div>
                    {v.entry.example} <span className="muted">{v.entry.exampleJa}</span>
                  </div>
                  <div className="muted">出会った場面（動画での発言）</div>
                  {v.sources.map((s, i) => (
                    <div key={i} className="row">
                      <div className="grow">
                        「{s.sentence}」
                        <div className="muted">
                          {s.title.slice(0, 40)}・{formatTime(s.start)}
                        </div>
                      </div>
                      <button className="btn sm" onClick={() => navigate(`/m/${encodeURIComponent(s.materialId)}`)} disabled={!materials.some((m) => m.id === s.materialId)}>
                        場面へ
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!confirm(`「${v.entry.lemma}」を単語帳から削除しますか？`)) return;
                      await deleteVocab(v.id);
                      toast("削除しました");
                      refresh();
                    }}
                  >
                    削除
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </main>
  );
}
