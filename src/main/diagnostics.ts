import type { DiagnosticLogEntry } from '../shared/types';

const MAX_DIAGNOSTIC_LOGS = 120;

let seq = 0;
const logs: DiagnosticLogEntry[] = [];
const listeners = new Set<(entry: DiagnosticLogEntry) => void>();

export function recordDiagnostic(
  level: DiagnosticLogEntry['level'],
  source: DiagnosticLogEntry['source'],
  message: string
): void {
  const entry: DiagnosticLogEntry = {
    id: `diag-${Date.now()}-${++seq}`,
    ts: Date.now(),
    level,
    source,
    message,
  };
  logs.push(entry);
  if (logs.length > MAX_DIAGNOSTIC_LOGS) {
    logs.splice(0, logs.length - MAX_DIAGNOSTIC_LOGS);
  }
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function getDiagnostics(): DiagnosticLogEntry[] {
  return [...logs];
}

export function clearDiagnostics(): void {
  logs.length = 0;
}

export function subscribeDiagnostics(fn: (entry: DiagnosticLogEntry) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
