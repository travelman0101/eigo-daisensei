import { useEffect, useState } from "react";
import type { Material } from "../../shared/types";
import { formatTime } from "../../shared/youtube";
import { useApp } from "../App";
import { db, type Progress } from "../lib/db";
import { thumb } from "../lib/samples";
import { markDirty } from "../lib/sync";

export function Library() {
  const { navigate, toast, version, refresh } = useApp();
  const [items, setItems] = useState<{ m: Material; p?: Progress }[] | null>(null);

  useEffect(() => {
    (async () => {
      const [ms, ps] = await Promise.all([db().getAll("materials"), db().getAll("progress")]);
      const pm = new Map(ps.map((p) => [p.materialId, p]));
      setItems(ms.map((m) => ({ m, p: pm.get(m.id) })).sort((a, b) => (b.p?.lastAt ?? b.m.createdAt) - (a.p?.lastAt ?? a.m.createdAt)));
    })();
  }, [version]);

  const remove = async (m: Material) => {
    if (!confirm(`「${m.title}」（${formatTime(m.start)}–${formatTime(m.end)}）を削除しますか？\n練習の記録も消えます。単語帳の単語は残ります。`)) return;
    await db().delete("materials", m.id);
    await db().delete("progress", m.id);
    if (!m.sample) {
      await markDirty("material", m.id, true);
      await markDirty("progress", m.id, true);
    }
    toast("削除しました");
    refresh();
  };

  return (
    <main>
      <h1>教材</h1>
      {items === null ? (
        <div className="sk" style={{ height: 120, borderRadius: 24 }} />
      ) : items.length === 0 ? (
        <div className="glass card">
          <p style={{ margin: 0 }}>まだ教材がありません。</p>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate("/")}>
            YouTube のリンクを貼る
          </button>
        </div>
      ) : (
        <div className="glass card">
          {items.map(({ m, p }) => {
            const ok = p ? Object.values(p.ratings).filter((r) => r === "ok").length : 0;
            return (
              <div key={m.id} className="row">
                <button className="item grow" onClick={() => navigate(`/m/${encodeURIComponent(m.id)}`)}>
                  <img className="thumb" src={thumb(m.videoId)} alt="" loading="lazy" />
                  <div className="grow">
                    <div className="title-2">{m.title}</div>
                    <div className="small muted">
                      {m.sample ? <span className="badge">見本 {m.sample.level}</span> : null} {formatTime(m.start)}–{formatTime(m.end)}・{m.sentences.length} 文
                      {p ? `・${p.plays} 回再生・できた ${ok}` : ""}
                    </div>
                  </div>
                </button>
                <button className="icon-btn" aria-label={`${m.title} を削除`} onClick={() => remove(m)}>
                  🗑
                </button>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
