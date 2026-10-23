import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "../shared/types";
import { api } from "./lib/api";
import { openStore, requestPersistence } from "./lib/db";
import { startSync, stopSync } from "./lib/sync";
import { Home } from "./screens/Home";
import { Import } from "./screens/Import";
import { Library } from "./screens/Library";
import { Practice } from "./screens/Practice";
import { SettingsScreen } from "./screens/Settings";
import { TestScreen } from "./screens/Test";
import { Vocab } from "./screens/Vocab";

type Toast = { id: number; text: string; kind: "info" | "error" };

interface Ctx {
  user: User | null;
  authAvailable: boolean;
  online: boolean;
  path: string;
  query: URLSearchParams;
  navigate: (to: string, replace?: boolean) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  /** bump to make screens re-read the store (after restore or delete) */
  version: number;
  refresh: () => void;
  signOut: () => Promise<void>;
}

const AppContext = createContext<Ctx>(null as never);
export const useApp = () => useContext(AppContext);

const LAST_USER = "eigo:lastUser";

function readLastUser(): User | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_USER) ?? "null");
  } catch {
    return null;
  }
}

export function App() {
  const [boot, setBoot] = useState<"loading" | "ready">("loading");
  const [user, setUser] = useState<User | null>(null);
  const [authAvailable, setAuthAvailable] = useState(true);
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3200);
  }, []);

  useEffect(() => {
    (async () => {
      let me: User | null = null;
      try {
        const r = await api<{ user: User | null; auth: boolean }>("/api/me");
        me = r.user;
        setAuthAvailable(r.auth);
        if (me) localStorage.setItem(LAST_USER, JSON.stringify(me));
        else localStorage.removeItem(LAST_USER);
      } catch {
        // offline or server down: open the last account's data so saved materials still work
        me = readLastUser();
      }
      setUser(me);
      try {
        await openStore(me?.id ?? "guest");
      } catch {
        toast("この端末のデータを開けませんでした（プライベートモードでは保存できないことがあります）", "error");
      }
      setBoot("ready");
      void requestPersistence();
      if (me && navigator.onLine) {
        const { restored } = await startSync();
        if (restored) {
          toast(`バックアップから ${restored} 件を復元しました（AI は使っていません）`);
          setVersion((v) => v + 1);
        }
      }
    })();
    const onPop = () => setLoc({ path: location.pathname, search: location.search });
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("popstate", onPop);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, [toast]);

  const navigate = useCallback((to: string, replace = false) => {
    if (replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    const u = new URL(to, location.origin);
    setLoc({ path: u.pathname, search: u.search });
    if (!replace) scrollTo({ top: 0 });
  }, []);

  const signOut = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    stopSync();
    localStorage.removeItem(LAST_USER);
    location.href = "/";
  }, []);

  const ctx = useMemo<Ctx>(
    () => ({ user, authAvailable, online, path: loc.path, query: new URLSearchParams(loc.search), navigate, toast, version, refresh: () => setVersion((v) => v + 1), signOut }),
    [user, authAvailable, online, loc, navigate, toast, version, signOut],
  );

  if (boot === "loading") return <BootSkeleton />;

  let screen: ReactNode;
  const p = loc.path;
  if (p === "/") screen = <Home />;
  else if (p === "/import") screen = <Import />;
  else if (p === "/library") screen = <Library />;
  else if (p.startsWith("/m/")) screen = <Practice id={decodeURIComponent(p.slice(3))} />;
  else if (p === "/vocab") screen = <Vocab />;
  else if (p === "/vocab/test") screen = <TestScreen />;
  else if (p === "/settings") screen = <SettingsScreen />;
  else screen = <Home />;

  const inPractice = p.startsWith("/m/");
  return (
    <MotionConfig reducedMotion="user">
      <AppContext.Provider value={ctx}>
        <div className="app">
          {!online && <div className="flash warn small" style={{ marginBottom: 10 }}>オフラインです。保存済みの教材の字幕・単語テストは使えます（動画の再生には通信が必要です）</div>}
          <AnimatePresence mode="wait">
            <motion.div key={p} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
              {screen}
            </motion.div>
          </AnimatePresence>
        </div>
        {!inPractice && <Nav path={p} />}
        <div className="toasts" role="status" aria-live="polite">
          <AnimatePresence>
            {toasts.map((t) => (
              <motion.div key={t.id} className={`toast ${t.kind}`} initial={{ opacity: 0, y: -12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8 }}>
                {t.text}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </AppContext.Provider>
    </MotionConfig>
  );
}

function Nav({ path }: { path: string }) {
  const { navigate } = useApp();
  const items = [
    { to: "/", ico: "⌂", label: "ホーム" },
    { to: "/library", ico: "▤", label: "教材" },
    { to: "/vocab", ico: "✎", label: "単語帳" },
    { to: "/settings", ico: "⚙", label: "設定" },
  ];
  return (
    <nav className="nav glass" aria-label="メイン">
      {items.map((it) => {
        const on = it.to === "/" ? path === "/" : path.startsWith(it.to);
        return (
          <a
            key={it.to}
            href={it.to}
            className={on ? "on" : ""}
            aria-current={on ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(it.to);
            }}
          >
            <span className="ico" aria-hidden>
              {it.ico}
            </span>
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}

export function BootSkeleton() {
  return (
    <div className="app" aria-busy="true" aria-label="読み込み中">
      <div className="sk" style={{ height: 28, width: 140, margin: "8px 4px 18px" }} />
      <div className="sk" style={{ height: 120, borderRadius: 24, marginBottom: 14 }} />
      <div className="sk" style={{ height: 22, width: 120, marginBottom: 10 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="row" style={{ marginBottom: 12 }}>
          <div className="sk" style={{ width: 96, height: 54 }} />
          <div className="grow">
            <div className="sk" style={{ height: 14, marginBottom: 8 }} />
            <div className="sk" style={{ height: 14, width: "60%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
