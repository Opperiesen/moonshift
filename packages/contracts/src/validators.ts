import { readFileSync } from 'node:fs';

import {
  Ajv2020,
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

export interface OwnedValidator {
  readonly schema: AnySchemaObject;
  readonly validate: ValidateFunction;
  assert(value: unknown): void;
}

export interface PlanningValidators {
  readonly eventEnvelope: OwnedValidator;
  readonly executionCheckpoint: OwnedValidator;
  readonly executionBackend: OwnedValidator;
  readonly runnerProtocol: OwnedValidator;
  readonly resultView: OwnedValidator;
}

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

export function isUuid(value: string): boolean {
  return UUID_FORMAT.test(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value);
  if (match === null) return false;
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    ,
    offsetHourValue,
    offsetMinuteValue,
  ] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const offsetHour = Number(offsetHourValue ?? 0);
  const offsetMinute = Number(offsetMinuteValue ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function hasValidUriEscapes(value: string): boolean {
  return !/[\u0000-\u0020\u007f]/.test(value) && !/%(?![0-9a-f]{2})/i.test(value);
}

export function isUriReference(value: string): boolean {
  if (!hasValidUriEscapes(value)) return false;
  try {
    new URL(value, 'https://moonshift.invalid/');
    return true;
  } catch {
    return false;
  }
}

export function isUri(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) || !hasValidUriEscapes(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: false,
    formats: {
      uuid: isUuid,
      'date-time': isRfc3339DateTime,
      'uri-reference': isUriReference,
      uri: isUri,
    },
  });
}

function loadSchema(filename: string): AnySchemaObject {
  const url = new URL(
    `../../../specs/001-supervised-autonomous-loop/contracts/${filename}`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, 'utf8')) as AnySchemaObject;
}

function loadYamlSchema(filename: string): AnySchemaObject {
  const url = new URL(
    `../../../specs/001-supervised-autonomous-loop/contracts/${filename}`,
    import.meta.url,
  );
  return parseYaml(readFileSync(url, 'utf8')) as AnySchemaObject;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
    .join('; ');
}

function compile(ajv: Ajv2020, schema: AnySchemaObject): OwnedValidator {
  const validate = ajv.compile(schema);
  return Object.freeze({
    schema,
    validate,
    assert(value: unknown): void {
      if (!validate(value))
        throw new Error(`Contract validation failed: ${formatErrors(validate.errors)}`);
    },
  });
}

export function createPlanningValidators(): PlanningValidators {
  const ajv = createAjv();
  const resultAjv = createAjv();
  resultAjv.addSchema(loadYamlSchema('http-api.openapi.yaml'), 'moonshift-http-api');
  return Object.freeze({
    eventEnvelope: compile(ajv, loadSchema('event-envelope.schema.json')),
    executionCheckpoint: compile(ajv, loadSchema('execution-checkpoint.schema.json')),
    executionBackend: compile(ajv, loadSchema('execution-backend.schema.json')),
    runnerProtocol: compile(ajv, loadSchema('runner-protocol.schema.json')),
    resultView: compile(resultAjv, {
      $ref: 'moonshift-http-api#/components/schemas/ResultView',
    }),
  });
}

let cached: PlanningValidators | undefined;
export function planningValidators(): PlanningValidators {
  cached ??= createPlanningValidators();
  return cached;
}
