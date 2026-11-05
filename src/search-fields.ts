import { Type as ClassType } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
import {
  EnumKind,
  FieldKind,
  filterClassFor,
  isEnumKind,
  ScalarKind,
} from './search-filters';

/**
 * Explicit typing for a field that is not on the response DTO, or whose
 * Prisma location differs from its API name. Keep these the exception.
 */
export interface SearchFieldOverride {
  kind: FieldKind;
  nullable?: boolean;
  /** Dot-separated Prisma path, e.g. `author.name`. Defaults to the field name. */
  path?: string;
  description?: string;
}

export interface ResolvedField {
  name: string;
  kind: FieldKind;
  nullable: boolean;
  /** Prisma path segments. */
  path: string[];
  /** The operator DTO used for this field in `<Name>Where`. */
  filterClass: ClassType;
  description?: string;
}

/*
 * Metadata keys written by @nestjs/swagger's `@ApiProperty`. Spelled out because
 * `DECORATORS` is only exported from the package root since 11.4.8, while older
 * 11.x releases only expose it through `dist/constants`, which 11.4.8 blocks.
 */
const API_MODEL_PROPERTIES = 'swagger/apiModelProperties';
const API_MODEL_PROPERTIES_ARRAY = 'swagger/apiModelPropertiesArray';

/** Static property the @nestjs/swagger CLI plugin adds to DTO classes. */
const PLUGIN_METADATA_FACTORY = '_OPENAPI_METADATA_FACTORY';

interface PropertyMetadata {
  type?: unknown;
  format?: string;
  nullable?: boolean;
  isArray?: boolean;
  enum?: EnumKind['enum'];
  enumName?: string;
  items?: { enum?: unknown };
}

/** Swagger metadata of a property, from decorators or from the CLI plugin. */
function readPropertyMetadata(
  dto: ClassType,
  field: string,
): PropertyMetadata | undefined {
  const prototype = dto.prototype as object;
  const declared =
    (Reflect.getMetadata(API_MODEL_PROPERTIES_ARRAY, prototype) as
      | string[]
      | undefined) ?? [];
  if (declared.includes(`:${field}`)) {
    return (
      (Reflect.getMetadata(
        API_MODEL_PROPERTIES,
        prototype,
        field,
      ) as PropertyMetadata | undefined) ?? {}
    );
  }

  for (
    let current: unknown = dto;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    if (!Object.prototype.hasOwnProperty.call(current, PLUGIN_METADATA_FACTORY))
      continue;
    const factory = (current as unknown as Record<string, unknown>)[
      PLUGIN_METADATA_FACTORY
    ] as () => Record<string, PropertyMetadata> | undefined;
    const metadata = factory()?.[field];
    if (metadata) return metadata;
  }
  return undefined;
}

function hasIntValidator(dto: ClassType, field: string): boolean {
  return getMetadataStorage()
    .getTargetValidationMetadatas(dto, '', true, false)
    .some((meta) => meta.propertyName === field && meta.name === 'isInt');
}

/** Lazy type functions (`() => Number`) have no prototype, constructors do. */
function unwrapLazy(type: unknown): unknown {
  if (
    typeof type === 'function' &&
    !(type as { prototype?: unknown }).prototype
  ) {
    return (type as () => unknown)();
  }
  return type;
}

function scalarKindOf(
  type: unknown,
  format: string | undefined,
  dto: ClassType,
  field: string,
): ScalarKind | undefined {
  if (type === Date) return 'datetime';
  if (type === Boolean || type === 'boolean') return 'boolean';
  if (type === String || type === 'string') {
    return format === 'date-time' || format === 'date' ? 'datetime' : 'string';
  }
  if (type === 'integer') return 'int';
  if (type === Number || type === 'number') {
    return format === 'int32' ||
      format === 'int64' ||
      hasIntValidator(dto, field)
      ? 'int'
      : 'float';
  }
  return undefined;
}

function fail(dto: ClassType, field: string, reason: string): never {
  throw new Error(
    `Search: cannot type field "${field}" of ${dto.name}: ${reason}. ` +
      'Declare it with @ApiProperty({ type, nullable, enum, enumName }) on the response DTO, or add an explicit entry in `fields`.',
  );
}

/**
 * Determines the operator type of a field from the response DTO: swagger
 * metadata first (`@ApiProperty({ type, nullable, enum })`, also inherited
 * through PickType/IntersectionType), `design:type` as fallback. Throws when
 * the field cannot be typed so the problem surfaces at startup.
 */
export function resolveField(
  dto: ClassType,
  field: string,
  override?: SearchFieldOverride,
): ResolvedField {
  let kind: FieldKind;
  let nullable: boolean;
  let description: string | undefined;

  if (override) {
    kind = override.kind;
    nullable = override.nullable ?? false;
    description = override.description;
    if (isEnumKind(kind) && !kind.enumName) {
      fail(dto, field, 'the enum override has no enumName');
    }
  } else {
    const metadata = readPropertyMetadata(dto, field);
    const designType: unknown = Reflect.getMetadata(
      'design:type',
      dto.prototype as object,
      field,
    );
    if (!metadata && designType === undefined) {
      fail(dto, field, 'the property is not declared on the DTO');
    }
    if (metadata?.isArray || metadata?.type === 'array' || metadata?.items) {
      fail(dto, field, 'array properties cannot be filtered');
    }

    nullable = metadata?.nullable === true;
    if (metadata?.enum !== undefined) {
      if (!metadata.enumName) {
        fail(dto, field, 'enum properties need an enumName');
      }
      kind = { enum: metadata.enum, enumName: metadata.enumName };
    } else {
      const type = unwrapLazy(metadata?.type) ?? designType;
      const scalar = scalarKindOf(type, metadata?.format, dto, field);
      if (!scalar) {
        const label =
          typeof type === 'function'
            ? (type as { name: string }).name
            : JSON.stringify(type);
        fail(dto, field, `unsupported type ${label}`);
      }
      kind = scalar;
    }
  }

  return {
    name: field,
    kind,
    nullable,
    path: (override?.path ?? field).split('.'),
    filterClass: filterClassFor(kind, nullable),
    description,
  };
}
