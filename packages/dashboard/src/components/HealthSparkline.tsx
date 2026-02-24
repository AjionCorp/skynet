"use client";

import { useCallback, useEffect, useState } from "react";
import { useSkynet } from "./SkynetProvider";

interface TrendPoint {
  ts: number;
  score: number;
}

function sparkColor(score: number): string {
  if (score > 80) return "#34d399"; // emerald-400
  if (score > 50) return "#fbbf24"; // amber-400
  return "#f87171"; // red-400
}

/**
 * Renders an inline SVG sparkline of recent health scores.
 * Fetches from /pipeline/health-trend every 30s.
 */
export function HealthSparkline() {
  const { apiPrefix } = useSkynet();
  const [data, setData] = useState<TrendPoint[]>([]);

  const fetchTrend = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/pipeline/health-trend`);
      const json = await res.json();
      if (Array.isArray(json.data)) {
        setData(json.data);
      }
    } catch {
      // Silently ignore — sparkline is non-critical
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchTrend();
    const interval = setInterval(fetchTrend, 30000);
    return () => clearInterval(interval);
  }, [fetchTrend]);

  if (data.length < 2) return null;

  const width = 120;
  const height = 28;
  const padding = 1;
  const scores = data.map((d) => d.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;

  const points = scores.map((score, i) => {
    const x = padding + (i / (scores.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (score - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  const lastScore = scores[scores.length - 1];
  const color = sparkColor(lastScore);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mt-1"
      aria-label={`Health trend: ${scores.length} data points, current ${lastScore}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
      {/* Dot on the latest value */}
      {scores.length > 0 && (() => {
        const lastX = padding + ((scores.length - 1) / (scores.length - 1)) * (width - padding * 2);
        const lastY = padding + (1 - (lastScore - min) / range) * (height - padding * 2);
        return <circle cx={lastX} cy={lastY} r="2" fill={color} />;
      })()}
    </svg>
  );
}
