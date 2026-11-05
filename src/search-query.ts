import { BadRequestException } from '@nestjs/common';
import {
  FieldFilter,
  isEnumKind,
  operatorsFor,
  PATTERN_OPERATORS,
} from './search-filters';
import { ResolvedField } from './search-fields';
import {
  SearchRequestBody,
  SearchResult,
  SearchSpec,
  searchSpecOf,
  SearchWhere,
  SortDirection,
} from './search-request';

/** Maximum nesting of AND/OR/NOT. */
export const MAX_WHERE_DEPTH = 6;
/** Words of `q` beyond this count are ignored. */
export const MAX_QUERY_WORDS = 10;

type PrismaWhere = Record<string, unknown>;
type PrismaOrderBy = Record<string, unknown>;

export interface SearchQueryOptions {
  /** Server-side condition ANDed with the client's filter. Never user controlled. */
  where?: PrismaWhere;
  /**
   * Adds `mode: 'insensitive'` to `contains`/`startsWith`/`endsWith` and to
   * `q`. PostgreSQL only: SQL Server rejects `mode`, there the column
   * collation decides. Equality
   * operators always compare as the database does.
   */
  caseInsensitive?: boolean;
  /** Appended to `orderBy` for a deterministic page order, e.g. `{ id: 'asc' }`. */
  tieBreaker?: Record<string, SortDirection>;
  /**
   * Fields the caller evaluates itself: skipped at the top level of `where`
   * and rejected (400) inside AND/OR/NOT.
   */
  handledFields?: readonly string[];
}

export interface PrismaSearchQuery {
  where: PrismaWhere;
  orderBy: PrismaOrderBy[];
  skip: number;
  take: number;
}

function nest(path: string[], value: unknown): PrismaWhere {
  return path.reduceRight<unknown>(
    (inner, segment) => ({ [segment]: inner }),
    value,
  ) as PrismaWhere;
}

function and(parts: PrismaWhere[]): PrismaWhere {
  if (parts.length === 0) return {};
  return parts.length === 1 ? parts[0] : { AND: parts };
}

function badRequest(message: string): never {
  throw new BadRequestException(message);
}

/** Prisma conditions for one field filter, all of which must hold. */
function fieldConditions(
  field: ResolvedField,
  filter: FieldFilter,
  options: SearchQueryOptions,
): PrismaWhere[] {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    badRequest(`where.${field.name} must be an object of operators.`);
  }
  const allowed = operatorsFor(field.kind);
  const plain: Record<string, unknown> = {};
  const pattern: Record<string, unknown> = {};

  for (const [operator, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (operator === 'isNull') continue;
    if (!allowed.includes(operator)) {
      badRequest(
        `Operator "${operator}" is not allowed on ${field.name}. Allowed: ${allowed.join(', ')}.`,
      );
    }
    (PATTERN_OPERATORS.includes(operator) ? pattern : plain)[operator] = value;
  }

  const conditions: Record<string, unknown>[] = [];
  const hasPattern = Object.keys(pattern).length > 0;
  if (hasPattern && options.caseInsensitive && !isEnumKind(field.kind)) {
    if (Object.keys(plain).length > 0) conditions.push(plain);
    conditions.push({ ...pattern, mode: 'insensitive' });
  } else if (hasPattern || Object.keys(plain).length > 0) {
    conditions.push({ ...plain, ...pattern });
  }

  if (filter.isNull !== undefined) {
    if (!field.nullable) {
      badRequest(`Operator "isNull" is not allowed on ${field.name}.`);
    }
    conditions.push(filter.isNull ? { equals: null } : { not: null });
  }

  return conditions.map((condition) => nest(field.path, condition));
}

function translateWhere(
  spec: SearchSpec,
  where: SearchWhere,
  options: SearchQueryOptions,
  depth: number,
): PrismaWhere[] {
  if (depth > MAX_WHERE_DEPTH) {
    badRequest(`where is nested deeper than ${MAX_WHERE_DEPTH} levels.`);
  }
  const parts: PrismaWhere[] = [];
  const sub = (child: SearchWhere) =>
    and(translateWhere(spec, child, options, depth + 1));

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'AND' || key === 'OR') {
      if (!Array.isArray(value)) badRequest(`where.${key} must be a list.`);
      parts.push({ [key]: (value as SearchWhere[]).map(sub) });
      continue;
    }
    if (key === 'NOT') {
      parts.push({ NOT: sub(value as SearchWhere) });
      continue;
    }

    const field = spec.fields.get(key);
    if (!field) badRequest(`Field "${key}" is not filterable.`);
    if (options.handledFields?.includes(key)) {
      if (depth > 0) {
        badRequest(
          `Field "${key}" is only supported at the top level of where.`,
        );
      }
      continue;
    }
    parts.push(...fieldConditions(field, value as FieldFilter, options));
  }
  return parts;
}

function queryConditions(
  spec: SearchSpec,
  q: string | undefined,
  options: SearchQueryOptions,
): PrismaWhere[] {
  if (!q || spec.search.length === 0) return [];
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_WORDS);
  const mode = options.caseInsensitive ? { mode: 'insensitive' } : {};
  return words.map((word) => ({
    OR: spec.search.map((path) => nest(path, { contains: word, ...mode })),
  }));
}

function orderByOf(
  spec: SearchSpec,
  request: SearchRequestBody,
  options: SearchQueryOptions,
): PrismaOrderBy[] {
  const requested = request.orderBy?.length
    ? request.orderBy.map((entry) => {
        const path = spec.sort.get(entry.field);
        if (!path) badRequest(`Field "${entry.field}" is not sortable.`);
        return { path, direction: entry.direction };
      })
    : spec.defaultSort;

  const seen = new Set<string>();
  const orderBy = requested.map(({ path, direction }) => {
    const key = path.join('.');
    if (seen.has(key)) badRequest(`orderBy lists "${key}" twice.`);
    seen.add(key);
    return nest(path, direction);
  });

  for (const [key, direction] of Object.entries(options.tieBreaker ?? {})) {
    if (!seen.has(key)) orderBy.push({ [key]: direction });
  }
  return orderBy;
}

/** The Prisma `where` for a request: server condition, client filter and `q`, ANDed. */
export function toPrismaWhere(
  request: SearchRequestBody,
  options: SearchQueryOptions = {},
): PrismaWhere {
  const spec = searchSpecOf(request);
  return and([
    ...(options.where ? [options.where] : []),
    ...(request.where ? translateWhere(spec, request.where, options, 0) : []),
    ...queryConditions(spec, request.q, options),
  ]);
}

/** Page number and size of a request, with defaults applied. */
export function pageOf(request: SearchRequestBody): {
  page: number;
  pageSize: number;
} {
  const spec = searchSpecOf(request);
  return {
    page: request.page ?? 1,
    pageSize: request.pageSize ?? spec.defaultPageSize,
  };
}

/**
 * Translates a validated search request into Prisma arguments. Only fields,
 * operators and sort keys declared in the request's SearchRequest options
 * are translated; anything else is a 400.
 */
export function toPrismaQuery(
  request: SearchRequestBody,
  options: SearchQueryOptions = {},
): PrismaSearchQuery {
  const spec = searchSpecOf(request);
  const { page, pageSize } = pageOf(request);
  return {
    where: toPrismaWhere(request, options),
    orderBy: orderByOf(spec, request, options),
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

/** Minimal model delegate surface (`prisma.article`). */
export interface SearchDelegate {
  findMany(args: object): unknown;
  count(args: object): unknown;
}

/** Minimal client surface for the array form of `$transaction`. */
export interface SearchTransactionClient {
  $transaction(queries: never[]): Promise<unknown[]>;
}

export interface RunSearchOptions extends SearchQueryOptions {
  select?: object;
  include?: object;
  omit?: object;
}

/**
 * Runs `findMany` and `count` with the same `where` in one transaction and
 * returns `{ items, total, page, pageSize }`.
 */
export async function runSearch<TItem = any>(
  client: SearchTransactionClient,
  delegate: SearchDelegate,
  request: SearchRequestBody,
  options: RunSearchOptions = {},
): Promise<SearchResult<TItem>> {
  const { select, include, omit, ...queryOptions } = options;
  const query = toPrismaQuery(request, queryOptions);
  const { page, pageSize } = pageOf(request);
  const [items, total] = await client.$transaction([
    delegate.findMany({ ...query, select, include, omit }),
    delegate.count({ where: query.where }),
  ] as never[]);
  return { items: items as TItem[], total: total as number, page, pageSize };
}
