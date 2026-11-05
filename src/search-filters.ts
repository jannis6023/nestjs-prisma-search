import { applyDecorators, Type as ClassType } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptions, ApiSchema } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  isISO8601,
} from 'class-validator';

/** Upper bound for `in` / `notIn` lists (SQL Server allows ~2100 parameters per query). */
export const MAX_FILTER_LIST_LENGTH = 1000;

export type ScalarKind = 'int' | 'float' | 'string' | 'datetime' | 'boolean';

export interface EnumKind {
  /** Enum object (`{ A: 'A' }`) or list of allowed values. */
  enum: Record<string, string | number> | readonly (string | number)[];
  /** Name of the enum schema in OpenAPI; the filter is named `<enumName>Filter`. */
  enumName: string;
}

export type FieldKind = ScalarKind | EnumKind;

/** Operators accepted per field kind, in the order they appear in the schema. */
export const OPERATORS = {
  int: ['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte'],
  float: ['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte'],
  string: [
    'equals',
    'not',
    'in',
    'notIn',
    'contains',
    'startsWith',
    'endsWith',
  ],
  datetime: ['equals', 'lt', 'lte', 'gt', 'gte'],
  boolean: ['equals'],
  enum: ['equals', 'in', 'notIn'],
} as const;

export const LIST_OPERATORS: readonly string[] = ['in', 'notIn'];
export const PATTERN_OPERATORS: readonly string[] = [
  'contains',
  'startsWith',
  'endsWith',
];

/** Loose runtime shape of any operator filter after validation. */
export interface FieldFilter {
  equals?: unknown;
  not?: unknown;
  in?: unknown[];
  notIn?: unknown[];
  lt?: unknown;
  lte?: unknown;
  gt?: unknown;
  gte?: unknown;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  isNull?: boolean;
}

// ─────────────────────────────────────────────
// Property decorators
// ─────────────────────────────────────────────

function optional(
  api: ApiPropertyOptions,
  ...validators: PropertyDecorator[]
): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ ...api, required: false } as ApiPropertyOptions),
    IsOptional(),
    ...validators,
  );
}

function listOf(
  api: ApiPropertyOptions,
  ...validators: PropertyDecorator[]
): PropertyDecorator {
  return optional(
    {
      ...api,
      isArray: true,
      maxItems: MAX_FILTER_LIST_LENGTH,
    },
    IsArray(),
    ArrayMaxSize(MAX_FILTER_LIST_LENGTH),
    ...validators,
  );
}

const IntValue = (description: string) =>
  optional({ type: 'integer', description }, IsInt());
const IntList = (description: string) =>
  listOf({ type: 'integer', description }, IsInt({ each: true }));

const FloatValue = (description: string) =>
  optional(
    { type: 'number', description },
    IsNumber({ allowNaN: false, allowInfinity: false }),
  );
const FloatList = (description: string) =>
  listOf(
    { type: 'number', description },
    IsNumber({ allowNaN: false, allowInfinity: false }, { each: true }),
  );

const StringValue = (description: string) =>
  optional({ type: 'string', description }, IsString());
const StringList = (description: string) =>
  listOf({ type: 'string', description }, IsString({ each: true }));

/** ISO 8601 strings become `Date`; anything else is left as is and fails `IsDate`. */
const ToDate = () =>
  Transform(
    ({ value }: { value: unknown }) =>
      typeof value === 'string' && isISO8601(value, { strict: true })
        ? new Date(value)
        : value,
    { toClassOnly: true },
  );
const DateValue = (description: string) =>
  optional(
    { type: 'string', format: 'date-time', description },
    ToDate(),
    IsDate({ message: '$property must be an ISO 8601 date-time string' }),
  );

const IsNullProperty = () =>
  optional(
    {
      type: 'boolean',
      description:
        'true: the field is null. false: the field is not null. Combined with the other operators by AND.',
    },
    IsBoolean(),
  );

// ─────────────────────────────────────────────
// Scalar filters
// ─────────────────────────────────────────────

@ApiSchema({
  name: 'IntFilter',
  description: 'Operators for an integer field. All given operators must hold.',
})
export class IntFilter {
  @IntValue('Equal to') equals?: number;
  @IntValue('Not equal to') not?: number;
  @IntList('One of') in?: number[];
  @IntList('None of') notIn?: number[];
  @IntValue('Less than') lt?: number;
  @IntValue('Less than or equal to') lte?: number;
  @IntValue('Greater than') gt?: number;
  @IntValue('Greater than or equal to') gte?: number;
}

@ApiSchema({
  name: 'IntNullableFilter',
  description: 'Operators for a nullable integer field.',
})
export class IntNullableFilter extends IntFilter {
  @IsNullProperty() isNull?: boolean;
}

@ApiSchema({
  name: 'FloatFilter',
  description:
    'Operators for a floating point field. All given operators must hold.',
})
export class FloatFilter {
  @FloatValue('Equal to') equals?: number;
  @FloatValue('Not equal to') not?: number;
  @FloatList('One of') in?: number[];
  @FloatList('None of') notIn?: number[];
  @FloatValue('Less than') lt?: number;
  @FloatValue('Less than or equal to') lte?: number;
  @FloatValue('Greater than') gt?: number;
  @FloatValue('Greater than or equal to') gte?: number;
}

@ApiSchema({
  name: 'FloatNullableFilter',
  description: 'Operators for a nullable floating point field.',
})
export class FloatNullableFilter extends FloatFilter {
  @IsNullProperty() isNull?: boolean;
}

@ApiSchema({
  name: 'StringFilter',
  description:
    'Operators for a text field. All given operators must hold. Case sensitivity of the comparison depends on the backend (database collation or configured mode).',
})
export class StringFilter {
  @StringValue('Equal to') equals?: string;
  @StringValue('Not equal to') not?: string;
  @StringList('One of') in?: string[];
  @StringList('None of') notIn?: string[];
  @StringValue('Contains the substring') contains?: string;
  @StringValue('Starts with') startsWith?: string;
  @StringValue('Ends with') endsWith?: string;
}

@ApiSchema({
  name: 'StringNullableFilter',
  description: 'Operators for a nullable text field.',
})
export class StringNullableFilter extends StringFilter {
  @IsNullProperty() isNull?: boolean;
}

@ApiSchema({
  name: 'DateTimeFilter',
  description:
    'Operators for a date/time field. Values are ISO 8601 strings. All given operators must hold.',
})
export class DateTimeFilter {
  @DateValue('Equal to') equals?: Date;
  @DateValue('Before') lt?: Date;
  @DateValue('At or before') lte?: Date;
  @DateValue('After') gt?: Date;
  @DateValue('At or after') gte?: Date;
}

@ApiSchema({
  name: 'DateTimeNullableFilter',
  description: 'Operators for a nullable date/time field.',
})
export class DateTimeNullableFilter extends DateTimeFilter {
  @IsNullProperty() isNull?: boolean;
}

@ApiSchema({
  name: 'BoolFilter',
  description: 'Operators for a boolean field.',
})
export class BoolFilter {
  @optional({ type: 'boolean', description: 'Equal to' }, IsBoolean())
  equals?: boolean;
}

@ApiSchema({
  name: 'BoolNullableFilter',
  description: 'Operators for a nullable boolean field.',
})
export class BoolNullableFilter extends BoolFilter {
  @IsNullProperty() isNull?: boolean;
}

const SCALAR_FILTERS: Record<ScalarKind, [ClassType, ClassType]> = {
  int: [IntFilter, IntNullableFilter],
  float: [FloatFilter, FloatNullableFilter],
  string: [StringFilter, StringNullableFilter],
  datetime: [DateTimeFilter, DateTimeNullableFilter],
  boolean: [BoolFilter, BoolNullableFilter],
};

// ─────────────────────────────────────────────
// Enum filters
// ─────────────────────────────────────────────

/** Enum values of an enum object or list (numeric TS enums drop their reverse mapping). */
export function enumValues(source: EnumKind['enum']): (string | number)[] {
  if (Array.isArray(source)) return [...(source as (string | number)[])];
  const record = source as Record<string, string | number>;
  return Object.keys(record)
    .filter((key) => !/^\d+$/.test(key))
    .map((key) => record[key]);
}

const enumFilterCache = new Map<
  string,
  { values: string; classes: [ClassType, ClassType] }
>();

function createEnumFilter(
  enumName: string,
  values: (string | number)[],
  nullable: boolean,
  base?: ClassType,
): ClassType {
  const name = `${enumName}${nullable ? 'Nullable' : ''}Filter`;
  const parent = base ?? Object;

  // A named function keeps the class name readable in validation errors.
  const holder = {
    [name]: class extends (parent as new () => object) {},
  };
  const filterClass = holder[name];

  const enumApi = { enum: values, enumName };
  const decorate = (key: string, decorator: PropertyDecorator) =>
    decorator(filterClass.prototype, key);

  if (nullable) {
    decorate('isNull', IsNullProperty());
  } else {
    decorate(
      'equals',
      optional({ ...enumApi, description: 'Equal to' }, IsIn(values)),
    );
    decorate(
      'in',
      listOf(
        { ...enumApi, description: 'One of' },
        IsIn(values, { each: true }),
      ),
    );
    decorate(
      'notIn',
      listOf(
        { ...enumApi, description: 'None of' },
        IsIn(values, { each: true }),
      ),
    );
  }

  ApiSchema({
    name,
    description: `Operators for a ${nullable ? 'nullable ' : ''}${enumName} field.`,
  })(filterClass);
  return filterClass;
}

/**
 * The filter class for an enum, created once per enum name so every schema is
 * emitted a single time. Reusing a name for different values is a programming
 * error and throws.
 */
export function enumFilterClass(kind: EnumKind, nullable: boolean): ClassType {
  const values = enumValues(kind.enum);
  const signature = JSON.stringify(values);
  let entry = enumFilterCache.get(kind.enumName);
  if (entry && entry.values !== signature) {
    throw new Error(
      `Search: enum "${kind.enumName}" was registered with different values (${entry.values} vs ${signature}).`,
    );
  }
  if (!entry) {
    const plain = createEnumFilter(kind.enumName, values, false);
    const withNull = createEnumFilter(kind.enumName, values, true, plain);
    entry = { values: signature, classes: [plain, withNull] };
    enumFilterCache.set(kind.enumName, entry);
  }
  return entry.classes[nullable ? 1 : 0];
}

export function isEnumKind(kind: FieldKind): kind is EnumKind {
  return typeof kind === 'object';
}

/** The operator DTO for a field of the given kind. */
export function filterClassFor(kind: FieldKind, nullable: boolean): ClassType {
  if (isEnumKind(kind)) return enumFilterClass(kind, nullable);
  return SCALAR_FILTERS[kind][nullable ? 1 : 0];
}

/** The operators a field of the given kind accepts (excluding `isNull`). */
export function operatorsFor(kind: FieldKind): readonly string[] {
  return isEnumKind(kind) ? OPERATORS.enum : OPERATORS[kind];
}
