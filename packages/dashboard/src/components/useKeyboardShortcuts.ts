"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface UseKeyboardShortcutsOptions {
  pages: { href: string; label: string }[];
  onNavigate?: (href: string) => void;
}

export function useKeyboardShortcuts({ pages, onNavigate }: UseKeyboardShortcutsOptions) {
  const [showHelp, setShowHelp] = useState(false);
  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable
    ) {
      return;
    }

    // ? toggles help overlay
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setShowHelp((prev) => !prev);
      return;
    }

    // Escape closes help
    if (e.key === "Escape" && showHelpRef.current) {
      setShowHelp(false);
      return;
    }

    // Number keys 1-9, 0 for page navigation
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && onNavigate) {
      const num = e.key === "0" ? 10 : parseInt(e.key, 10);
      if (num >= 1 && num <= pages.length) {
        e.preventDefault();
        setShowHelp(false);
        onNavigate(pages[num - 1].href);
      }
    }
  }, [pages, onNavigate]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return { showHelp, setShowHelp };
}
