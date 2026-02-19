"use client";
import { createContext, useContext, type ReactNode } from "react";

interface SkynetContextValue {
  apiPrefix: string;
}

const SkynetContext = createContext<SkynetContextValue>({ apiPrefix: "/api/admin" });

export function useSkynet() {
  return useContext(SkynetContext);
}

export function SkynetProvider({ apiPrefix = "/api/admin", children }: { apiPrefix?: string; children: ReactNode }) {
  return <SkynetContext.Provider value={{ apiPrefix }}>{children}</SkynetContext.Provider>;
}
