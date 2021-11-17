export {};

export function now(): number {
  const hr = process.hrtime();
  return (hr[0] * 1e9 + hr[1]) / 1e3;
}
