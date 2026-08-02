import packageSource from "../package.json" with { type: "text" };

interface PackageMetadata {
  version?: unknown;
}

/** Embedded at build time so source and standalone binaries report one version. */
export function packageVersion(
  source: string = packageSource as unknown as string,
): string {
  const metadata = JSON.parse(source) as PackageMetadata;
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("package.json does not contain a valid version");
  }
  return metadata.version;
}

export const CONCH_VERSION = packageVersion();
