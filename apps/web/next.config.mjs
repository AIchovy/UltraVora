import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker image (apps/web/Dockerfile) runs the self-contained
  // .next/standalone output instead of shipping node_modules.
  output: "standalone",
  // Monorepo: trace from the workspace root, or the standalone bundle misses
  // workspace deps like @ultracreator/shared.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // Next.js needs to be told the workspace package is intentionally
  // transpiled — otherwise it tries to import the .ts source as-is.
  transpilePackages: ["@ultracreator/shared"],
  // The codebase uses NodeNext-style `.js` extensions on relative imports of
  // TS sources (e.g. `import { x } from "./foo.js"`). TypeScript ("Bundler"
  // moduleResolution) and vitest tolerate this, but Next.js's webpack
  // resolver does not auto-strip `.js` to find `.ts`/`.tsx`. Teach it to.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
export default nextConfig;
