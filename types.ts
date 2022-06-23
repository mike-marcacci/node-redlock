import { Client } from './deps.ts'

export type ClientExecutionResult =
  | {
      client: Client;
      vote: "for";
      value: number;
    }
  | {
      client: Client;
      vote: "against";
      error: Error;
    };

export type ExecutionStats = {
  readonly membershipSize: number;
  readonly quorumSize: number;
  readonly votesFor: Set<Client>;
  readonly votesAgainst: Map<Client, Error>;
};

export type ExecutionResult = {
  attempts: ReadonlyArray<Promise<ExecutionStats>>;
};

export interface Settings {
  readonly driftFactor: number;
  readonly retryCount: number;
  readonly retryDelay: number;
  readonly retryJitter: number;
  readonly automaticExtensionThreshold: number;
}

export type RedlockAbortSignal = AbortSignal & { error?: Error };