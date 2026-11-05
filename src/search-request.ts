import { applyDecorators, Type as ClassType } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptions, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FieldFilter } from './search-filters';
import {
  ResolvedField,
  resolveField,
  SearchFieldOverride,
} from './search-fields';

export type SortDirection = 'asc' | 'desc';

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGE_SIZE = 100;
/** Upper bound for `q`; longer input is rejected. */
export const MAX_QUERY_LENGTH = 200;
/** Upper bound for the entries of one AND/OR list. */
export const MAX_LOGICAL_LIST_LENGTH = 100;

export interface SearchSort<TField extends string = string> {
  field: TField;
  direction: SortDirection;
}

export type SearchWhere<TField extends string = string> = {
  [K in TField]?: FieldFilter;
} & {
  AND?: SearchWhere<TField>[];
  OR?: SearchWhere<TField>[];
  NOT?: SearchWhere<TField>;
};

/** Runtime shape of a validated search request body. */
export interface SearchRequestBody<
  TFilter extends string = string,
  TSort extends string = string,
> {
  where?: SearchWhere<TFilter>;
  orderBy?: SearchSort<TSort>[];
  page: number;
  pageSize: number;
  q?: string;
}

export interface SearchRequestOptions<TField extends string> {
  /** Schema prefix: emits `<name>Where`, `<name>OrderBy`, `<name>SortField`. */
  name: string;
  /** Fields clients may filter on in `where`. */
  filter?: readonly TField[];
  /** Fields clients may sort by in `orderBy`. */
  sort?: readonly TField[];
  /** Text fields searched by the free-text `q` (enables `q` when set). */
  search?: readonly TField[];
  /** Sort used when the request has no `orderBy`. */
  defaultSort?: readonly SearchSort<TField>[];
  defaultPageSize?: number;
  maxPageSize?: number;
}

/** Everything the query translation needs, attached to the request class. */
export interface SearchSpec {
  name: string;
  fields: Map<string, ResolvedField>;
  /** Sortable field -> Prisma path segments. */
  sort: Map<string, string[]>;
  /** Prisma paths searched by `q`. */
  search: string[][];
  defaultSort: { path: string[]; direction: SortDirection }[];
  defaultPageSize: number;
  maxPageSize: number;
}

export const SEARCH_SPEC = Symbol('searchSpec');

export type SearchRequestClass<
  TFilter extends string = string,
  TSort extends string = string,
> = (new () => SearchRequestBody<TFilter, TSort>) & {
  [SEARCH_SPEC]: SearchSpec;
};

function decorate(
  target: ClassType,
  key: string,
  ...decorators: PropertyDecorator[]
): void {
  applyDecorators(...decorators)(target.prototype as object, key);
}

function api(options: ApiPropertyOptions): PropertyDecorator {
  return ApiProperty(options);
}

/** A class with a readable runtime name (shows up in validation errors). */
function namedClass(name: string): ClassType {
  const holder = { [name]: class {} };
  return holder[name];
}

function nested(
  target: () => ClassType,
  options: { isArray?: boolean; description?: string },
): PropertyDecorator[] {
  return [
    api({
      // @nestjs/swagger recognises lazy types by the function name `type`.
      type: () => target(),
      isArray: options.isArray,
      required: false,
      // A description next to a single $ref makes swagger emit `allOf`, which
      // generated clients turn into needless wrapper types.
      description: options.isArray ? options.description : undefined,
    }),
    IsOptional(),
    ...(options.isArray
      ? [
          IsArray(),
          ArrayMaxSize(MAX_LOGICAL_LIST_LENGTH),
          ValidateNested({ each: true }),
        ]
      : [IsObject(), ValidateNested()]),
    Type(target),
  ];
}

function buildWhereClass(name: string, fields: ResolvedField[]): ClassType {
  const where = namedClass(`${name}Where`);
  for (const field of fields) {
    decorate(
      where,
      field.name,
      ...nested(() => field.filterClass, { description: field.description }),
    );
  }
  decorate(
    where,
    'AND',
    ...nested(() => where, {
      isArray: true,
      description: 'All of these conditions must hold.',
    }),
  );
  decorate(
    where,
    'OR',
    ...nested(() => where, {
      isArray: true,
      description:
        'At least one of these conditions must hold. An empty list matches nothing.',
    }),
  );
  decorate(
    where,
    'NOT',
    ...nested(() => where, { description: 'This condition must not hold.' }),
  );
  ApiSchema({
    name: `${name}Where`,
    description:
      'Filter conditions. Properties on the same level are combined with AND.',
  })(where);
  return where;
}

function buildOrderByClass(name: string, sortFields: string[]): ClassType {
  const orderBy = namedClass(`${name}OrderBy`);
  decorate(
    orderBy,
    'field',
    api({ enum: sortFields, enumName: `${name}SortField` }),
    IsIn(sortFields, {
      message: `field must be one of: ${sortFields.join(', ')}`,
    }),
  );
  decorate(
    orderBy,
    'direction',
    api({ enum: ['asc', 'desc'], enumName: 'SortDirection' }),
    IsIn(['asc', 'desc']),
  );
  ApiSchema({ name: `${name}OrderBy` })(orderBy);
  return orderBy;
}

function assertUnique(name: string, list: readonly string[], label: string) {
  const duplicate = list.find((item, index) => list.indexOf(item) !== index);
  if (duplicate) {
    throw new Error(
      `Search ${name}: "${duplicate}" is listed twice in ${label}.`,
    );
  }
}

/**
 * Builds a typed search request DTO for a response DTO.
 *
 * ```ts
 * export class ArticleSearchRequestDto extends SearchRequest(ArticleDto, {
 *   name: 'Article',
 *   filter: ['publishedAt', 'title'],
 *   sort: ['publishedAt'],
 *   search: ['title'],
 *   defaultSort: [{ field: 'publishedAt', direction: 'desc' }],
 * }) {}
 * ```
 *
 * The operator DTO of each filter field is derived from the DTO's swagger
 * metadata. `fields` adds or re-maps fields explicitly (exception, not rule).
 * Use the body with `@SearchBody()` so unknown properties are rejected.
 */
export function SearchRequest<T, TExtra extends string = never>(
  dto: ClassType<T>,
  options: SearchRequestOptions<NoInfer<(keyof T & string) | TExtra>> & {
    fields?: { [K in TExtra]: SearchFieldOverride } & Partial<
      Record<keyof T & string, SearchFieldOverride>
    >;
  },
): SearchRequestClass<
  (keyof T & string) | TExtra,
  (keyof T & string) | TExtra
> {
  const { name } = options;
  const filterFields = [...(options.filter ?? [])] as string[];
  const sortFields = [...(options.sort ?? [])] as string[];
  const searchFields = [...(options.search ?? [])] as string[];
  const overrides: Record<string, SearchFieldOverride> = options.fields ?? {};
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

  assertUnique(name, filterFields, 'filter');
  assertUnique(name, sortFields, 'sort');
  assertUnique(name, searchFields, 'search');
  if (defaultPageSize < 1 || defaultPageSize > maxPageSize) {
    throw new Error(
      `Search ${name}: defaultPageSize must be between 1 and maxPageSize.`,
    );
  }

  const resolved = new Map<string, ResolvedField>();
  const resolve = (field: string) => {
    let entry = resolved.get(field);
    if (!entry) {
      entry = resolveField(dto, field, overrides[field]);
      resolved.set(field, entry);
    }
    return entry;
  };

  const fields = new Map(
    filterFields.map((field) => [field, resolve(field)] as const),
  );
  const sort = new Map(
    sortFields.map((field) => [field, resolve(field).path] as const),
  );
  const search = searchFields.map((field) => {
    const entry = resolve(field);
    if (entry.kind !== 'string') {
      throw new Error(
        `Search ${name}: search field "${field}" must be a text field.`,
      );
    }
    return entry.path;
  });
  const defaultSort = (options.defaultSort ?? []).map((entry) => {
    const path = sort.get(entry.field);
    if (!path) {
      throw new Error(
        `Search ${name}: default sort field "${entry.field}" is not sortable.`,
      );
    }
    return { path, direction: entry.direction };
  });

  const spec: SearchSpec = {
    name,
    fields,
    sort,
    search,
    defaultSort,
    defaultPageSize,
    maxPageSize,
  };

  class SearchRequestBase {
    static readonly [SEARCH_SPEC] = spec;
    page = 1;
    pageSize = defaultPageSize;
  }
  const base = SearchRequestBase as unknown as ClassType;

  if (fields.size > 0) {
    const where = buildWhereClass(name, [...fields.values()]);
    decorate(
      base,
      'where',
      ...nested(() => where, {
        description: 'Filter conditions.',
      }),
    );
  }

  if (sort.size > 0) {
    const orderBy = buildOrderByClass(name, sortFields);
    const fallback = (options.defaultSort ?? [])
      .map((entry) => `${entry.field} ${entry.direction}`)
      .join(', ');
    decorate(
      base,
      'orderBy',
      api({
        type: () => orderBy,
        isArray: true,
        required: false,
        maxItems: sortFields.length,
        description: `Sort keys, applied in order. Default: ${fallback || 'unspecified'}.`,
      }),
      IsOptional(),
      IsArray(),
      ArrayMaxSize(sortFields.length),
      ValidateNested({ each: true }),
      Type(() => orderBy),
    );
  }

  decorate(
    base,
    'page',
    api({
      type: 'integer',
      minimum: 1,
      default: 1,
      required: false,
      description: 'Page number, starting at 1.',
    }),
    IsOptional(),
    IsInt(),
    Min(1),
  );
  decorate(
    base,
    'pageSize',
    api({
      type: 'integer',
      minimum: 1,
      maximum: maxPageSize,
      default: defaultPageSize,
      required: false,
      description: 'Items per page.',
    }),
    IsOptional(),
    IsInt(),
    Min(1),
    Max(maxPageSize),
  );

  if (search.length > 0) {
    decorate(
      base,
      'q',
      api({
        type: 'string',
        required: false,
        maxLength: MAX_QUERY_LENGTH,
        description: `Free-text search over ${searchFields.join(', ')}. Every whitespace-separated word must be contained in at least one of these fields.`,
      }),
      IsOptional(),
      IsString(),
      MaxLength(MAX_QUERY_LENGTH),
    );
  }

  Object.defineProperty(SearchRequestBase, 'name', {
    value: `${name}SearchRequest`,
  });
  return SearchRequestBase;
}

/** Runtime shape of a search response. */
export interface SearchResult<TItem> {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Response DTO `{ items, total, page, pageSize }` for a search endpoint. */
export function SearchResponse<TItem>(
  item: ClassType<TItem>,
  name: string,
): new () => SearchResult<TItem> {
  class SearchResponseBase {
    items: TItem[];
    total: number;
    page: number;
    pageSize: number;
  }
  const base = SearchResponseBase as unknown as ClassType;
  decorate(base, 'items', api({ type: () => item, isArray: true }));
  decorate(
    base,
    'total',
    api({ type: 'integer', description: 'Number of matching items.' }),
  );
  decorate(base, 'page', api({ type: 'integer', minimum: 1 }));
  decorate(base, 'pageSize', api({ type: 'integer', minimum: 1 }));
  Object.defineProperty(SearchResponseBase, 'name', {
    value: `${name}SearchResponse`,
  });
  return SearchResponseBase;
}

/** The search spec of a request DTO class or instance; throws if there is none. */
export function searchSpecOf(request: object): SearchSpec {
  const target = (
    typeof request === 'function' ? request : request.constructor
  ) as Partial<Record<typeof SEARCH_SPEC, SearchSpec>> | undefined;
  const spec = target?.[SEARCH_SPEC];
  if (!spec) {
    throw new Error(
      'Search: the request is not an instance of a SearchRequest class. Use @SearchBody() or plainToInstance().',
    );
  }
  return spec;
}
