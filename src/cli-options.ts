function warnAndFallback<T>(
  label: string,
  raw: string,
  fallback: T,
  expectation: string,
  warn: (message: string) => void,
): T {
  warn(`skillcaller: ${label} expects ${expectation}, got "${raw}"; using ${String(fallback)}`);
  return fallback;
}

const defaultWarn = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export function positiveInt(
  raw: string,
  fallback: number,
  label: string,
  warn: (message: string) => void = defaultWarn,
): number {
  // parseInt("2abc") === 2
  const value = /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value) || value < 1) {
    return warnAndFallback(label, raw, fallback, "a whole number of 1 or more", warn);
  }
  return value;
}

export function rate(
  raw: string,
  fallback: number,
  label: string,
  warn: (message: string) => void = defaultWarn,
): number {
  const value = /^-?\d*\.?\d+$/.test(raw.trim()) ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return warnAndFallback(label, raw, fallback, "a number between 0 and 1", warn);
  }
  return value;
}
