const sensitiveKey = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD)$|^(?:AUTHORIZATION|COOKIE)$/i;
const inlineSecret = /((?:^|[?&;,\s])(?:[a-z0-9]+[_-])?(?:token|key|secret|password|authorization|cookie)[=:])[^&;,\s]+/gi;

export function isSensitiveKey(key: string): boolean {
  return sensitiveKey.test(key);
}

export function redactRecord(values: Record<string, string> | undefined): Record<string, string> {
  if (!values) return {};
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, isSensitiveKey(key) ? "[REDACTED]" : value]));
}

export function summarizeArguments(args: readonly string[]): string[] {
  const summary: string[] = [];
  let redactNext = false;
  for (const value of args.slice(0, 16)) {
    if (redactNext) {
      summary.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const separator = value.search(/[=:]/);
    const key = (separator < 0 ? value : value.slice(0, separator)).replace(/^--?/, "").trim().replace(/[_-]/g, "_");
    if (isSensitiveKey(key)) {
      if (separator >= 0) {
        summary.push(`${value.slice(0, separator + 1)}[REDACTED]`.slice(0, 256));
        continue;
      }
      summary.push(value.slice(0, 256));
      redactNext = true;
      continue;
    }
    summary.push(value.replace(inlineSecret, "$1[REDACTED]").slice(0, 256));
  }
  return summary;
}
