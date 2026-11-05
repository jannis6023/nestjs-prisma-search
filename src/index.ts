/*
 * Typed, validated, OpenAPI-documented search endpoints for NestJS + Prisma.
 *
 * Usage:
 *   export class ArticleSearchRequestDto extends SearchRequest(ArticleDto, {
 *     name: 'Article', filter: [...], sort: [...], search: [...], defaultSort: [...],
 *   }) {}
 *   export class ArticleSearchResponseDto extends SearchResponse(ArticleDto, 'Article') {}
 *
 *   @Post('search')
 *   search(@SearchBody() body: ArticleSearchRequestDto) {
 *     return runSearch(prisma, prisma.article, body, { select });
 *   }
 */
export * from './search-filters';
export * from './search-fields';
export * from './search-request';
export * from './search-query';
export * from './search-body';
