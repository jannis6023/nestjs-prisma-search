# nestjs-prisma-search

Typed, validated and OpenAPI-documented search endpoints for **NestJS + Prisma**.

Declare once which fields of a DTO may be filtered, sorted and searched. You get:

- a request DTO with per-field operator filters, `AND` / `OR` / `NOT`, sorting, free-text search and paging,
- strict validation: unknown fields or operators are a `400`, never silently dropped,
- an exact OpenAPI schema, so generated clients (Orval, openapi-generator, …) get autocompletion for exactly the allowed fields and operators,
- a safe translation into Prisma `where` / `orderBy` / `skip` / `take`, run as `findMany` + `count` in one transaction.

Works with any Prisma model and database. Prisma is not a dependency: the library only needs the `findMany` / `count` / `$transaction` surface of your client.

## Install

```bash
npm install nestjs-prisma-search
```

Peer dependencies: `@nestjs/common` 11, `@nestjs/swagger` 11, `class-validator` 0.14, `class-transformer` 0.5, `reflect-metadata`.

## Usage

```ts
import { Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import {
  runSearch,
  SearchBody,
  SearchRequest,
  SearchResponse,
} from 'nestjs-prisma-search';

export enum ArticleStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
}

export class ArticleDto {
  @ApiProperty() id: number;
  @ApiProperty() title: string;
  @ApiProperty({ nullable: true, type: String }) summary: string | null;
  @ApiProperty({ enum: ArticleStatus, enumName: 'ArticleStatus' }) status: ArticleStatus;
  @ApiProperty() publishedAt: Date;
}

export class ArticleSearchRequestDto extends SearchRequest(ArticleDto, {
  name: 'Article',
  filter: ['id', 'status', 'publishedAt'],
  sort: ['publishedAt', 'title'],
  search: ['title', 'summary'],
  defaultSort: [{ field: 'publishedAt', direction: 'desc' }],
}) {}

export class ArticleSearchResponseDto extends SearchResponse(ArticleDto, 'Article') {}

@Controller('articles')
export class ArticlesController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('search')
  @ApiOkResponse({ type: ArticleSearchResponseDto })
  searchArticles(@SearchBody() body: ArticleSearchRequestDto) {
    return runSearch(this.prisma, this.prisma.article, body, {
      tieBreaker: { id: 'asc' },
    });
  }
}
```

### Request

```json
{
  "where": {
    "status": { "equals": "PUBLISHED" },
    "OR": [
      { "publishedAt": { "gte": "2026-01-01T00:00:00Z" } },
      { "id": { "in": [12, 40] } }
    ]
  },
  "orderBy": [{ "field": "publishedAt", "direction": "desc" }],
  "q": "prisma nestjs",
  "page": 1,
  "pageSize": 20
}
```

### Response

```json
{ "items": [ … ], "total": 57, "page": 1, "pageSize": 20 }
```

## Operators

The operators of a field follow from its type, read from the `@ApiProperty` metadata (or the `@nestjs/swagger` CLI plugin):

| Kind | Operators |
|---|---|
| int, float | `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte` |
| string | `equals`, `not`, `in`, `notIn`, `contains`, `startsWith`, `endsWith` |
| datetime | `equals`, `lt`, `lte`, `gt`, `gte` |
| boolean | `equals` |
| enum | `equals`, `in`, `notIn` (values checked against the enum) |

Nullable fields additionally get `isNull: true | false`.

`q` is split into words (at most 10). Every word must be contained in at least one of the `search` fields.

## Options

`SearchRequest(dto, options)`:

| Option | Meaning |
|---|---|
| `name` | Schema prefix: emits `<name>Where`, `<name>OrderBy`, `<name>SortField`. |
| `filter` | Fields clients may filter on in `where`. |
| `sort` | Fields clients may sort by. |
| `search` | Text fields searched by `q` (enables `q`). |
| `defaultSort` | Sort used when the request has no `orderBy`. |
| `defaultPageSize` / `maxPageSize` | Defaults 20 / 100. |
| `fields` | Explicit kind or Prisma path per field, e.g. `{ authorName: { kind: 'string', path: 'author.name' } }`. Keep these the exception. |

`runSearch(client, delegate, body, options)` / `toPrismaQuery(body, options)`:

| Option | Meaning |
|---|---|
| `where` | Server-side condition ANDed with the client's filter (e.g. tenant or permission checks). Never user controlled. |
| `caseInsensitive` | Adds `mode: 'insensitive'` to pattern operators and `q`. PostgreSQL / MongoDB only; on other databases the column collation decides. |
| `tieBreaker` | Appended to `orderBy` for a stable page order, e.g. `{ id: 'asc' }`. |
| `handledFields` | Fields you evaluate yourself: skipped at the top level of `where`, rejected inside `AND` / `OR` / `NOT`. |
| `select` / `include` / `omit` | Passed to `findMany` (`runSearch` only). |

Use `toPrismaQuery` when you need to run the query yourself (raw SQL, extra post-processing, a different count strategy).

## Limits

Built-in guards keep requests cheap: `AND` / `OR` / `NOT` nesting depth 6, at most 100 entries per logical list, at most 1000 values per `in` / `notIn`, `q` at most 200 characters.

## Validation

`@SearchBody()` reads the raw body and validates it with its own strict pipe (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`). A global `ValidationPipe` with `whitelist: true` therefore cannot strip an unknown condition before it is rejected: a stripped condition would silently widen the result set.

## License

[MIT](LICENSE)
