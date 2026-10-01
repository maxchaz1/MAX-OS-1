import type {
  JsonValue,
  KernelEnvelope,
  KernelResult,
  PlanetaryMode,
  UmbrellaMode,
} from '../contracts';
import {
  createEnvelope,
  failureResponse,
  resultResponse,
  resolveUmbrellaMode,
} from '../kernel-bridge';
import { type LaneExecutionContext, runKernel } from '../kernel-engine';

export class PortalKernel {
  private readonly state: DurableObjectState;
  private readonly env: Record<string, unknown>;

  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    this.state = state;
    this.env = env;
  }

  private async getEntropyTick(): Promise<number> {
    const stored = await this.state.storage.get<number>('entropyTick');
    return typeof stored === 'number' ? stored : 0;
  }

  private async setEntropyTick(next: number): Promise<void> {
    await this.state.storage.put('entropyTick', next);
  }

  private derivePlanetaryMode(): PlanetaryMode {
    const mode = this.env.PLANETARY_MODE;
    return typeof mode === 'string' ? (mode as PlanetaryMode) : 'single';
  }

  private deriveUmbrellaMode(): UmbrellaMode {
    const requested = this.env.UMBRELLA_MODE ?? this.env.UMBRELLA_ENFORCEMENT;
    return resolveUmbrellaMode(typeof requested === 'string' ? requested : undefined);
  }

  private async buildContext(envelope: KernelEnvelope): Promise<LaneExecutionContext> {
    return {
      identity: envelope.identity,
      governanceContext: envelope.governanceContext,
      planetaryMode: envelope.planetaryMode ?? this.derivePlanetaryMode(),
      umbrellaEnforcement: envelope.umbrellaEnforcement ?? this.deriveUmbrellaMode(),
      identityCurvature: envelope.identityCurvature ?? 0,
      entropyTick: envelope.entropyTick ?? (await this.getEntropyTick()),
      storage: this.state.storage,
      env: this.env,
    };
  }

  async execute(payload: JsonValue): Promise<KernelResult> {
    const currentTick = await this.getEntropyTick();
    const envelope = createEnvelope({
      type: 'kernel.execute',
      payload:
        typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : { value: payload },
      identity: 'portal-kernel',
      governanceContext: {
        tenant: 'portal',
      },
      entropyTick: currentTick,
      planetaryMode: this.derivePlanetaryMode(),
      umbrellaEnforcement: this.deriveUmbrellaMode(),
      laneRouting: { lane: 'kernel', route: ['kernel'] },
    });

    const context = await this.buildContext(envelope);

    try {
      const result = await runKernel(envelope, context);
      await this.setEntropyTick(currentTick + 1);
      return resultResponse(envelope, result);
    } catch (error) {
      return failureResponse(envelope, {
        code: 'KERNEL_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown kernel error',
      });
    }
  }
}
