"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { PublicView } from "@/lib/view-types";

interface Live {
  view: PublicView;
  streaming: boolean;
  stale: boolean;
}

const LiveContext = createContext<Live | null>(null);

export function LiveProvider({ initial, children }: { initial: PublicView; children: React.ReactNode }) {
  const [view, setView] = useState(initial);
  const [streaming, setStreaming] = useState(true);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (message) => {
      setView(JSON.parse(message.data) as PublicView);
      setStreaming(true);
      setStale(false);
    };
    source.addEventListener("stale", () => {
      setStreaming(true);
      setStale(true);
    });
    source.onerror = () => setStreaming(false);
    return () => source.close();
  }, []);

  return <LiveContext.Provider value={{ view, streaming, stale }}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error("useLive must be used inside LiveProvider");
  return live;
}
