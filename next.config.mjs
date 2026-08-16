/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // REQUIRED for the preview database (`lib/db.ts`), not an optimization.
    // Without this, webpack bundles @electric-sql/pglite and breaks its WASM
    // asset loading; the first query then dies with
    // `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type
    // string ... Received an instance of URL`. Measured 2026-08-16 under
    // Next 14.2.35 in the Back21 preview container.
    serverComponentsExternalPackages: ["@electric-sql/pglite"],
  },
};

export default nextConfig;
