"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  Save,
  Settings,
} from "lucide-react";
import { useSkynet } from "./SkynetProvider";

interface ConfigEntry {
  key: string;
  value: string;
  comment: string;
}

export interface SettingsDashboardProps {
  /** Poll interval in milliseconds. Defaults to 0 (no polling — config is static). */
  pollInterval?: number;
}

export function SettingsDashboard({ pollInterval = 0 }: SettingsDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [configPath, setConfigPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/config`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      setEntries(json.data.entries ?? []);
      setConfigPath(json.data.configPath ?? "");
      setEditedValues({});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch config");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchConfig();
    if (pollInterval > 0) {
      const interval = setInterval(fetchConfig, pollInterval);
      return () => clearInterval(interval);
    }
  }, [fetchConfig, pollInterval]);

  const handleChange = (key: string, value: string) => {
    setEditedValues((prev) => {
      const original = entries.find((e) => e.key === key)?.value ?? "";
      if (value === original) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
    setSaveSuccess(false);
  };

  const handleSave = async () => {
    if (Object.keys(editedValues).length === 0) return;
    setSaving(true);
    setSaveSuccess(false);
    setError(null);

    try {
      const res = await fetch(`${apiPrefix}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: editedValues }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      setEntries(json.data.entries ?? []);
      setEditedValues({});
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setEditedValues({});
    setSaveSuccess(false);
  };

  const dirtyCount = Object.keys(editedValues).length;

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading configuration...</span>
      </div>
    );
  }

  // Group entries by section (comment)
  const sections: { label: string; entries: ConfigEntry[] }[] = [];
  let currentSection: { label: string; entries: ConfigEntry[] } | null = null;

  for (const entry of entries) {
    const sectionLabel = entry.comment || "General";
    if (!currentSection || currentSection.label !== sectionLabel) {
      currentSection = { label: sectionLabel, entries: [] };
      sections.push(currentSection);
    }
    currentSection.entries.push(entry);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Pipeline Configuration</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {configPath ? configPath : "skynet.config.sh"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchConfig}
            className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Save success banner */}
      {saveSuccess && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-6 py-4">
          <Check className="h-5 w-5 shrink-0 text-emerald-400" />
          <p className="text-sm text-emerald-400">Configuration saved successfully</p>
        </div>
      )}

      {/* Empty state */}
      {entries.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 py-16">
          <Settings className="h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">No configuration found</p>
          <p className="mt-1 text-xs text-zinc-600">
            Run &quot;skynet init&quot; to generate .dev/skynet.config.sh
          </p>
        </div>
      )}

      {/* Config sections */}
      {sections.map((section) => (
        <div
          key={section.label}
          className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6"
        >
          <div className="mb-4 flex items-center gap-2">
            <Settings className="h-4 w-4 text-cyan-400" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              {section.label}
            </h3>
          </div>
          <div className="space-y-3">
            {section.entries.map((entry) => {
              const currentValue = entry.key in editedValues ? editedValues[entry.key] : entry.value;
              const isDirty = entry.key in editedValues;
              // Detect boolean-like or short values for inline display
              const isBooleanLike = /^(true|false)$/i.test(entry.value);
              const isLongValue = entry.value.length > 60;

              return (
                <div
                  key={entry.key}
                  className={`rounded-lg border px-4 py-3 ${
                    isDirty
                      ? "border-cyan-500/30 bg-cyan-500/5"
                      : "border-zinc-800 bg-zinc-950/30"
                  }`}
                >
                  <label className="block">
                    <span className="text-xs font-mono text-zinc-500">{entry.key}</span>
                    {isBooleanLike ? (
                      <select
                        value={currentValue}
                        onChange={(e) => handleChange(entry.key, e.target.value)}
                        className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : isLongValue ? (
                      <textarea
                        value={currentValue}
                        onChange={(e) => handleChange(entry.key, e.target.value)}
                        rows={2}
                        className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                    ) : (
                      <input
                        type="text"
                        value={currentValue}
                        onChange={(e) => handleChange(entry.key, e.target.value)}
                        className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                    )}
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Sticky save bar */}
      {entries.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/80 px-6 py-4">
          <p className="text-sm text-zinc-500">
            {dirtyCount > 0
              ? `${dirtyCount} unsaved change${dirtyCount !== 1 ? "s" : ""}`
              : "No changes"}
          </p>
          <div className="flex items-center gap-2">
            {dirtyCount > 0 && (
              <button
                onClick={handleReset}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-white"
              >
                Reset
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={dirtyCount === 0 || saving}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                dirtyCount > 0 && !saving
                  ? "bg-cyan-600 text-white hover:bg-cyan-500"
                  : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
              }`}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save Changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
