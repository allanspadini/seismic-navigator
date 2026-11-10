import { invert, type InversionInput, type InversionProgress, type InversionResult } from '../core/tomo/invert';

export type InversionMessage =
  | ({ type: 'progress' } & InversionProgress)
  | { type: 'done'; result: InversionResult }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InversionInput>) => void) | null;
  postMessage(message: InversionMessage, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  try {
    const result = invert(event.data, (progress) => scope.postMessage({ type: 'progress', ...progress }));
    scope.postMessage({ type: 'done', result }, [
      result.active.buffer,
      result.velocity.buffer,
      result.coverage.buffer,
      ...result.rays.map((ray) => ray.buffer),
    ]);
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
