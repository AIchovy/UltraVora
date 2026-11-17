"use client";
import { useId } from "react";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
  size?: number;
}

const OFF = "#F4F4F480";
const ON = "#6cb4ff";
const DUR = "0.857s";

/* 4×4 grid positions */
const CELLS = [
  [0, 0], [24, 0], [48, 0], [72, 0],
  [0, 24], [24, 24], [48, 24], [72, 24],
  [0, 48], [24, 48], [48, 48], [72, 48],
  [0, 72], [24, 72], [48, 72], [72, 72],
] as const;

/*
 * Keyframe opacity values for each cell — a clockwise spiral trail.
 * 12 steps per cycle, each lit cell fades through 1.0→0.825→0.65→0.475→0.
 * Interior cells (1,1), (2,1), (1,2), (2,2) stay dark (all zeros).
 */
const FRAMES: readonly string[] = [
  "1.000;0.825;0.650;0.475;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;1.000;0.825;0.650;0.475;0.000;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;0.000;1.000;0.825;0.650;0.475;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;0.000;0.000;1.000;0.825;0.650;0.475;0.000;0.000;0.000;0.000;0.000",
  "0.825;0.650;0.475;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;1.000",
  "0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;0.000;0.000;0.000;1.000;0.825;0.650;0.475;0.000;0.000;0.000;0.000",
  "0.650;0.475;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;1.000;0.825",
  "0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000",
  "0.000;0.000;0.000;0.000;0.000;1.000;0.825;0.650;0.475;0.000;0.000;0.000",
  "0.475;0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;1.000;0.825;0.650",
  "0.000;0.000;0.000;0.000;0.000;0.000;0.000;0.000;1.000;0.825;0.650;0.475",
  "0.000;0.000;0.000;0.000;0.000;0.000;0.000;1.000;0.825;0.650;0.475;0.000",
  "0.000;0.000;0.000;0.000;0.000;0.000;1.000;0.825;0.650;0.475;0.000;0.000",
];

export function MatrixLoader({ className, size = 20 }: Props): React.ReactElement {
  const filterId = `hdr-glow-${useId().replace(/:/g, "")}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 92 92"
      className={cn("shrink-0", className)}
      aria-label="Thinking"
      role="img"
    >
      <defs>
        <filter id={filterId} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.1" result="blur1" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="5.6" result="blur2" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="10.5" result="blur3" />
          <feColorMatrix in="blur1" type="matrix" result="glow1"
            values="0 0 0 0 0.424 0 0 0 0 0.706 0 0 0 0 1.000 0 0 0 0.560 0" />
          <feColorMatrix in="blur2" type="matrix" result="glow2"
            values="0 0 0 0 0.424 0 0 0 0 0.706 0 0 0 0 1.000 0 0 0 0.350 0" />
          <feColorMatrix in="blur3" type="matrix" result="glow3"
            values="0 0 0 0 0.424 0 0 0 0 0.706 0 0 0 0 1.000 0 0 0 0.210 0" />
          <feMerge>
            <feMergeNode in="glow3" />
            <feMergeNode in="glow2" />
            <feMergeNode in="glow1" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g>
        {CELLS.map(([x, y], i) => (
          <rect key={`off-${i}`} x={x} y={y} width={20} height={20} rx={2} fill={OFF} />
        ))}
      </g>

      <g filter={`url(#${filterId})`}>
        {CELLS.map(([x, y], i) => (
          <rect key={`on-${i}`} x={x} y={y} width={20} height={20} rx={2} fill={ON}>
            <animate
              attributeName="opacity"
              values={FRAMES[i]}
              dur={DUR}
              repeatCount="indefinite"
            />
          </rect>
        ))}
      </g>
    </svg>
  );
}
