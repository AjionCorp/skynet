"use client";

import { useCallback, useEffect, useState } from "react";
import { useSkynet } from "./SkynetProvider";
import type { VelocityDataPoint } from "../types";

/**
 * SVG bar chart showing daily task completion velocity.
 * Fetches from /pipeline/task-velocity every 30s.
 */
export function TaskVelocityChart() {
  const { apiPrefix } = useSkynet();
  const [data, setData] = useState<VelocityDataPoint[]>([]);

  const fetchVelocity = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/pipeline/task-velocity`);
      const json = await res.json();
      if (Array.isArray(json.data)) {
        setData(json.data);
      }
    } catch {
      // Silently ignore — chart is non-critical
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchVelocity();
    const interval = setInterval(fetchVelocity, 30000);
    return () => clearInterval(interval);
  }, [fetchVelocity]);

  if (data.length === 0) return null;

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const chartHeight = 140;
  const barPadding = 4;
  const labelHeight = 18;
  const topPadding = 20;
  const barAreaHeight = chartHeight - labelHeight - topPadding;
  const barWidth = Math.max(8, Math.min(40, 600 / data.length - barPadding));
  const totalWidth = data.length * (barWidth + barPadding) + barPadding;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
        Task Completion Velocity
      </p>
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 ${totalWidth} ${chartHeight}`}
        preserveAspectRatio="xMidYMid meet"
        aria-label={`Task velocity: ${data.length} days, max ${maxCount} tasks/day`}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map((frac) => {
          const y = topPadding + barAreaHeight * (1 - frac);
          return (
            <line
              key={frac}
              x1={0}
              y1={y}
              x2={totalWidth}
              y2={y}
              stroke="#27272a"
              strokeWidth="1"
            />
          );
        })}

        {data.map((d, i) => {
          const barHeight = (d.count / maxCount) * barAreaHeight;
          const x = barPadding + i * (barWidth + barPadding);
          const y = topPadding + barAreaHeight - barHeight;
          const dateLabel = d.date.slice(5); // "MM-DD"

          return (
            <g key={d.date}>
              {/* Bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={2}
                fill="#34d399"
                opacity={0.8}
              />
              {/* Count label above bar */}
              {d.count > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#a1a1aa"
                >
                  {d.count}
                </text>
              )}
              {/* Date label */}
              <text
                x={x + barWidth / 2}
                y={chartHeight - 2}
                textAnchor="middle"
                fontSize="9"
                fill="#52525b"
              >
                {dateLabel}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Summary line */}
      <div className="mt-2 flex items-center gap-4 text-xs text-zinc-500">
        <span>
          Total: {data.reduce((s, d) => s + d.count, 0)} tasks over{" "}
          {data.length} day{data.length !== 1 ? "s" : ""}
        </span>
        {data.length >= 2 && (
          <span>
            Avg:{" "}
            {Math.round(
              data.reduce((s, d) => s + d.count, 0) / data.length
            )}
            /day
          </span>
        )}
      </div>
    </div>
  );
}
