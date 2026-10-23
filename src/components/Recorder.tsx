import { useEffect, useRef, useState } from "react";
import { useApp } from "../App";

/**
 * Record yourself and compare with the original. The microphone is requested only when the
 * button is pressed; recordings stay in memory for this sentence and are never uploaded.
 */
export function Recorder({ sentenceId, onPlayOriginal }: { sentenceId: string; onPlayOriginal: () => void }) {
  const { toast } = useApp();
  const [state, setState] = useState<"idle" | "recording">("idle");
  const [url, setUrl] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const stopStream = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  useEffect(() => {
    // a new sentence starts with no recording
    setUrl((u) => (u && URL.revokeObjectURL(u), null));
    return () => {
      rec.current?.state === "recording" && rec.current.stop();
      stopStream();
    };
  }, [sentenceId]);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return toast("このブラウザでは録音できません。練習はそのまま続けられます", "error");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return toast("マイクが使えませんでした（許可されていない可能性）。練習はそのまま続けられます", "error");
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream.current);
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      stopStream();
      const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
      setUrl((u) => (u && URL.revokeObjectURL(u), URL.createObjectURL(blob)));
      setState("idle");
    };
    rec.current = r;
    r.start();
    setState("recording");
  };

  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {state === "recording" ? (
        <button className="chip on" onClick={() => rec.current?.stop()} aria-label="録音を止める">
          ■ 録音を止める
        </button>
      ) : (
        <button className="chip" onClick={start} aria-label="自分の声を録音">
          🎙 録音
        </button>
      )}
      {url && (
        <>
          <button className="chip" onClick={() => void audio.current?.play()}>
            ▶ 自分の声
          </button>
          <button className="chip" onClick={onPlayOriginal}>
            ▶ お手本
          </button>
          <audio ref={audio} src={url} preload="auto" />
        </>
      )}
    </div>
  );
}
