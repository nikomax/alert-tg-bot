export type AppState = {
  listenerOk: boolean;
  lastDeliveryErrorAt: number;
};

export function createState(): AppState {
  return {
    listenerOk: false,
    lastDeliveryErrorAt: 0,
  };
}

export const DELIVERY_ERROR_COOLDOWN_MS = 15 * 60 * 1000;

export function logInfo(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(new Date().toISOString(), message, extra);
    return;
  }
  console.log(new Date().toISOString(), message);
}

export function logError(message: string, error: unknown): void {
  console.error(new Date().toISOString(), message, error);
}
