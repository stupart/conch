import {
  ServerSupervisor,
  type ServerOwnership,
  type ServerRecoveryReason,
  type ServerSupervisorOptions,
  type ServerSupervisorSnapshot,
  type ServerSupervisorStatus,
  type ServerTimer,
} from "./server-supervisor.ts";

export { requireUncancelledProbe } from "./server-supervisor.ts";

export type TtsSupervisorStatus = ServerSupervisorStatus;
export type TtsOwnership = ServerOwnership;
export type TtsRecoveryReason = ServerRecoveryReason<"synth-timeout">;
export type TtsSupervisorSnapshot = ServerSupervisorSnapshot;
export type TtsTimer = ServerTimer;

/** Kokoro compatibility surface for the shared warm-server supervisor. */
export interface TtsSupervisorOptions extends Omit<ServerSupervisorOptions, "language"> {}

/**
 * Bounded Kokoro lifecycle supervision. Recovery remains background work, so
 * speech can immediately use `say` while the shared state machine self-heals.
 */
export class TtsSupervisor extends ServerSupervisor<"synth-timeout"> {
  constructor(options: TtsSupervisorOptions) {
    super({
      ...options,
      language: {
        service: "kokoro",
        readiness: "synthesis-ready",
        fallback: "using say",
      },
    });
  }
}
