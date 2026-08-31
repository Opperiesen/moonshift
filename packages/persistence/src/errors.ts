export class OptimisticConcurrencyError extends Error {
  readonly code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`Expected aggregate version ${expectedVersion}, found ${actualVersion}`);
    this.name = 'OptimisticConcurrencyError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(
    readonly scope: string,
    readonly idempotencyKey: string,
  ) {
    super(`Idempotency key ${idempotencyKey} was reused with another request in ${scope}`);
    this.name = 'IdempotencyConflictError';
  }
}

export class LeaseConflictError extends Error {
  readonly code = 'LEASE_ALREADY_ACTIVE';

  constructor(
    readonly resourceType: string,
    readonly resourceId: string,
  ) {
    super(`An active lease already owns ${resourceType}:${resourceId}`);
    this.name = 'LeaseConflictError';
  }
}

export class FencingAuthorityError extends Error {
  readonly code = 'FENCING_AUTHORITY_INVALID';

  constructor(message = 'The current durable lease does not authorize this aggregate transition') {
    super(message);
    this.name = 'FencingAuthorityError';
  }
}

export class MigrationIntegrityError extends Error {
  readonly code = 'MIGRATION_INTEGRITY_FAILURE';

  constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}
