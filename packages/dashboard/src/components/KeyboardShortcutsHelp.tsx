"use client";

import { useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";

interface KeyboardShortcutsHelpProps {
  pages: { href: string; label: string }[];
  onClose: () => void;
}

export function KeyboardShortcutsHelp({ pages, onClose }: KeyboardShortcutsHelpProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (overlayRef.current && e.target === overlayRef.current) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-white">
            <Keyboard className="h-5 w-5 text-cyan-400" />
            <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Navigation
          </div>
          <div className="space-y-1">
            {pages.map((page, i) => {
              const shortcut = i < 9 ? String(i + 1) : i === 9 ? "0" : null;
              return (
                <div key={page.href} className="flex items-center justify-between py-1">
                  <span className="text-sm text-zinc-300">{page.label}</span>
                  {shortcut ? (
                    <kbd className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-300">
                      {shortcut}
                    </kbd>
                  ) : (
                    <span className="text-xs text-zinc-500">Click only</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-zinc-800 pt-3">
            <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              General
            </div>
            <div className="mt-1 space-y-1">
              <div className="flex items-center justify-between py-1">
                <span className="text-sm text-zinc-300">Show shortcuts</span>
                <kbd className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-300">
                  ?
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-sm text-zinc-300">Close</span>
                <kbd className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-300">
                  Esc
                </kbd>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
