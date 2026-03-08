import { useState, useEffect } from "react";

export default function useAutoUpdater(setError) {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updatePhase, setUpdatePhase] = useState("idle"); // idle|available|downloading|ready
  const [updateProgress, setUpdateProgress] = useState(0);

  useEffect(() => {
    const cleanups = [
      window.electronAPI.updater.onAvailable((info) => {
        setUpdateInfo(info);
        setUpdatePhase("available");
      }),
      window.electronAPI.updater.onProgress(({ percent }) => {
        setUpdateProgress(percent);
        setUpdatePhase("downloading");
      }),
      window.electronAPI.updater.onDownloaded(() => {
        setUpdateProgress(100);
        setUpdatePhase("ready");
      }),
      window.electronAPI.updater.onError((msg) => {
        setUpdatePhase("idle");
        setError("Chyba aktualizace: " + msg);
      }),
    ];

    return () => cleanups.forEach((fn) => fn && fn());
  }, [setError]);

  return { updateInfo, updatePhase, setUpdatePhase, updateProgress };
}
