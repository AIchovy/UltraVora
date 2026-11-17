import { cn } from "@/lib/utils";

/**
 * UltraVora logo mark (prism/play glyph). Monochrome: paints with
 * currentColor so the parent controls the color (and hover transitions).
 * The viewBox is cropped to the glyph's bounds — the source export had a
 * 500x500 canvas with large transparent margins.
 */
export function LogoMark({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      viewBox="170.5 165 170 170"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-slot="logo-mark"
      className={cn("shrink-0", className)}
    >
      <g fill="currentColor" stroke="currentColor" strokeWidth="1">
        <path d="M 199.5 167 L 205.5 167 L 212.5 169 L 327 236 L 332 245.5 L 332 254.5 Q 329.4 261.9 323.5 266 L 290.5 284 L 211.5 331 Q 206 333.5 196.5 332 L 190 329 Q 191.1 326.3 188.5 327 L 183 320.5 L 181 300.5 L 182 299.5 L 182 283.5 L 181 281.5 L 182 276.5 L 182 274.5 L 181 267.5 L 182 266.5 L 182 208.5 Q 179.3 206.8 181 200.5 L 182 197.5 L 181 196.5 L 181 187.5 L 183 178.5 L 190.5 170 L 199.5 167 Z M 202 178 L 197 180 L 193 184 L 193 193 L 192 194 L 192 287 L 193 288 Q 195 293 192 295 Q 191 299 193 301 L 192 309 L 192 311 L 194 318 L 200 321 Q 207 322 210 319 L 312 260 L 321 253 L 320 247 L 316 242 L 285 225 L 277 219 L 266 214 L 258 208 L 225 190 L 210 180 L 202 178 Z" />
        <path d="M 202 185 L 206.5 185 L 210 187 L 212 192.5 L 212 306.5 L 207.5 313 L 203.5 315 L 202 313.5 L 202 185 Z" />
        <path d="M 224.5 205 L 233 208 Q 231.8 211 235.5 210 L 298 247.5 Q 299.3 253.6 296.5 253 L 229.5 293 L 224.5 294 L 222 290.5 L 222 210.5 L 224.5 205 Z M 234 221 L 232 224 L 232 278 L 239 276 L 242 273 L 270 258 L 282 250 L 250 230 Q 246 231 247 228 L 243 227 L 234 221 Z" />
        <path d="M 242.5 236 L 265 249.5 L 264 252 L 241 264 L 241 237.5 L 242.5 236 Z" />
      </g>
    </svg>
  );
}
