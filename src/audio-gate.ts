/** Testable guard shared by every daemon-owned audio-output path. */
export function assertNormalMicClosed(isMicOpen: () => boolean, operation: string): void {
  if (isMicOpen()) throw new Error(`audio gate violation: normal mic open before ${operation}`);
}

export async function withNormalMicClosed<T>(
  isMicOpen: () => boolean,
  operation: string,
  output: () => T | Promise<T>,
): Promise<T> {
  assertNormalMicClosed(isMicOpen, operation);
  return await output();
}
