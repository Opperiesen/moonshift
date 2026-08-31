export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export class ProjectVersionConflictError extends ControlPlaneError {
  constructor(expected: number, current: number) {
    super(
      'PROJECT_VERSION_CONFLICT',
      `Project version conflict: expected ${expected}, current ${current}`,
      409,
    );
  }
}

export class EventCursorExpiredError extends ControlPlaneError {
  constructor(readonly retainedFrom: number) {
    super('EVENT_CURSOR_EXPIRED', 'Reload the durable project view before reconnecting', 409);
  }
}
