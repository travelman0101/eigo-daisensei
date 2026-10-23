import { useEffect, useState } from "react";
import type { Material } from "../../shared/types";
import { useApp } from "../App";
import { api } from "../lib/api";
import { db, deleteAccountStore, requestPersistence } from "../lib/db";
import { flush, onSync, pull, syncState, type SyncState } from "../lib/sync";

const KIND_LABEL: Record<string, string> = { transcript: "字幕取得（Supadata）", punct: "文の区切り（AI）", translate: "訳・まとまり（AI）", lookup: "辞書（AI）" };

interface UsageRow {
  kind: string;
  cached: number;
  calls: number;
  neurons: number;
  ms: number;
  today: number;
}

const mb = (n?: number) => (n == null ? "?" : `${(n / 1024 / 1024).toFixed(1)}MB`);

export function SettingsScreen() {
  const { user, authAvailable, signOut, toast, refresh } = useApp();
  const [sync, setSync] = useState<SyncState>(syncState());
  const [stats, setStats] = useState<{ items: number; bytes: number; quota: number } | null>(null);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [storage, setStorage] = useState<{ persisted: boolean; usage?: number; quota?: number } | null>(null);
  const [counts, setCounts] = useState({ materials: 0, vocab: 0 });
  const [lastImport, setLastImport] = useState<Material | null>(null);

  useEffect(() => onSync(setSync), []);
  useEffect(() => {
    void requestPersistence().then(setStorage);
    (async () => {
      const ms = await db().getAll("materials");
      setCounts({ materials: ms.length, vocab: await db().count("vocab") });
      setLastImport(ms.filter((m) => m.stats).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);
    })();
    if (user) {
      api<{ items: number; bytes: number; quota: number }>("/api/backup/stats").then(setStats).catch(() => {});
      api<{ rows: UsageRow[] }>("/api/usage").then((r) => setUsage(r.rows)).catch(() => {});
    }
  }, [user, sync.lastAt]);

  const exportAll = async () => {
    const d = db();
    const data = {
      exportedAt: new Date().toISOString(),
      app: "英語大先生",
      materials: await d.getAll("materials"),
      progress: await d.getAll("progress"),
      vocab: await d.getAll("vocab"),
      results: await d.getAll("results"),
      settings: (await d.get("kv", "settings"))?.value ?? null,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `eigo-daisensei-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const wipeDevice = async () => {
    if (!confirm("この端末に保存した教材・単語帳・記録をすべて削除しますか？" + (user ? "\nバックアップ（クラウド）は残ります。" : "\nログインしていないため、元に戻せません。"))) return;
    await deleteAccountStore(user?.id ?? "guest");
    location.href = "/";
  };

  const wipeBackup = async () => {
    if (!confirm("クラウドのバックアップを削除しますか？この端末のデータは残ります。")) return;
    await api("/api/backup", { method: "DELETE" });
    toast("バックアップを削除しました");
    setStats({ items: 0, bytes: 0, quota: stats?.quota ?? 0 });
  };

  const deleteAccount = async () => {
    if (!confirm("アカウントを削除しますか？\nクラウドのバックアップとログイン情報を削除し、この端末のデータも削除します。元に戻せません。")) return;
    await api("/api/account", { method: "DELETE" });
    await deleteAccountStore(user!.id);
    localStorage.removeItem("eigo:lastUser");
    location.href = "/";
  };

  const restore = async () => {
    try {
      const n = await pull(true);
      toast(`バックアップから ${n} 件を反映しました（AI は使っていません）`);
      refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const rows = usage ?? [];
  const sum = (kind: string, cached: number, f: keyof UsageRow) => rows.filter((r) => r.kind === kind && r.cached === cached).reduce((n, r) => n + Number(r[f] ?? 0), 0);

  return (
    <main>
      <h1>設定</h1>

      <section className="glass card">
        <h2>アカウント</h2>
        {user ? (
          <div className="stack">
            <div>
              {user.name} <span className="small muted">{user.email}</span>
            </div>
            <div className="small muted">データはアカウントごとに分けて保存しています。同じ端末で別のアカウントに切り替えても、互いの単語帳や履歴は見えません。</div>
            <div className="row wrap">
              <button className="btn" onClick={signOut}>
                ログアウト
              </button>
              <button className="btn danger" onClick={deleteAccount}>
                アカウントを削除
              </button>
            </div>
            <p className="small muted">ログアウトしてもこの端末のデータは残ります（次に同じアカウントでログインすると使えます）。</p>
          </div>
        ) : authAvailable ? (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>
              ログインすると、自分の動画を取り込めて、教材と単語帳をクラウドにバックアップできます。
            </p>
            <a className="btn primary" href="/api/auth/google?next=/settings">
              Google でログイン
            </a>
            <p className="small muted">ログインしていない間のデータ（ゲスト）はこの端末だけに保存され、ログイン後のアカウントとは別です。</p>
          </div>
        ) : (
          <p className="small muted">ログインは準備中です。</p>
        )}
      </section>

      {user && (
        <section className="glass card">
          <h2>バックアップ</h2>
          <div className="small" role="status">
            {sync.status === "syncing" ? "同期中…" : sync.status === "error" ? <span style={{ color: "var(--bad)" }}>{sync.message}</span> : sync.lastAt ? `同期済み（${new Date(sync.lastAt).toLocaleTimeString()}）` : "待機中"}
          </div>
          {stats && (
            <p className="small muted">
              クラウド: {stats.items} 件・{mb(stats.bytes)} / {mb(stats.quota)}
            </p>
          )}
          <div className="row wrap">
            <button className="btn sm" onClick={() => void flush()}>
              今すぐバックアップ
            </button>
            <button className="btn sm" onClick={restore}>
              バックアップから復元
            </button>
            <button className="btn sm danger" onClick={wipeBackup}>
              バックアップを削除
            </button>
          </div>
          <p className="small muted">端末のデータが消えても、ログインすると自動でバックアップから戻します（AI で解析し直すことはありません）。テストの回答履歴は端末だけに保存します（覚えた度合いはバックアップされます）。</p>
        </section>
      )}

      <section className="glass card">
        <h2>この端末のデータ</h2>
        <p className="small">
          教材 {counts.materials} 件・単語 {counts.vocab} 件
          {storage && (
            <>
              <br />
              使用量 {mb(storage.usage)} / 上限の目安 {mb(storage.quota)}・{storage.persisted ? "ブラウザに「消さないで」と登録済み" : "ブラウザが容量不足のときに消す可能性があります"}
            </>
          )}
        </p>
        <p className="small muted">ブラウザのデータ消去・容量不足・端末の変更で消えることがあります。無期限の保存は保証できません。</p>
        <div className="row wrap">
          <button className="btn sm" onClick={exportAll}>
            JSON で書き出す
          </button>
          <button className="btn sm danger" onClick={wipeDevice}>
            この端末のデータを削除
          </button>
        </div>
      </section>

      {user && (
        <section className="glass card">
          <h2>AI と字幕サービスの利用（30 日）</h2>
          {usage === null ? (
            <div className="sk" style={{ height: 60 }} />
          ) : (
            <table className="usage">
              <thead>
                <tr>
                  <th>種類</th>
                  <th>実行</th>
                  <th>再利用</th>
                  <th>ニューロン</th>
                  <th>今日</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(KIND_LABEL).map((k) => (
                  <tr key={k}>
                    <td>{KIND_LABEL[k]}</td>
                    <td>{sum(k, 0, "calls")}</td>
                    <td>{sum(k, 1, "calls")}</td>
                    <td>{Math.round(sum(k, 0, "neurons"))}</td>
                    <td>{sum(k, 0, "today") + sum(k, 1, "today")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted">「再利用」は保存済みの結果を返しただけで、AI と字幕サービスは使っていない回数です。Workers AI の無料枠は 1 日 10,000 ニューロンです。</p>
          {lastImport?.stats && (
            <p className="small muted">
              直近の取り込み: 字幕 {(lastImport.stats.transcriptMs / 1000).toFixed(1)} 秒・文の区切り {(lastImport.stats.punctMs / 1000).toFixed(1)} 秒・訳 {(lastImport.stats.translateMs / 1000).toFixed(1)} 秒・AI 実行 {lastImport.stats.aiCalls} 回 / 再利用 {lastImport.stats.cachedCalls} 回
            </p>
          )}
        </section>
      )}

      <section className="glass card small">
        <h2>このアプリについて</h2>
        <ul style={{ paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
          <li>このアプリに広告はありません。動画は YouTube 公式の埋め込みプレイヤーで再生するため、YouTube の広告が表示されることがあります。</li>
          <li>字幕は外部サービス Supadata 経由で取得し、全体を 1 回だけ取得して保存します。AI が処理するのは選んだ区間だけです。</li>
          <li>文の時刻は字幕の行の時刻をもとにしています。行の途中で区切った文は文字数からの推定です。ずれるときは練習画面の「時刻の補正」で直せます。</li>
          <li>公式プレイヤーの制約で、バックグラウンド再生・音声だけの再生・音程を保った細かな速度変更はできません。速度は YouTube が対応する段階のみです。</li>
          <li>見本教材の動画と字幕はパブリックドメインまたは CC BY のものです（各教材に出典を表示）。</li>
        </ul>
      </section>
    </main>
  );
}
