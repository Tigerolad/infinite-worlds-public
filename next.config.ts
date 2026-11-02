import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // World files are read from disk at runtime; make sure deploys include them.
  outputFileTracingIncludes: {
    "/**": ["./worlds/**/*"],
  },
};

export default nextConfig;
