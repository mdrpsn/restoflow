import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // exceljs has optional/dynamic requires that break when webpack bundles it;
  // load it from node_modules at runtime instead (warehouse count import).
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
