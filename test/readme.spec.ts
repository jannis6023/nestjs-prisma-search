import 'reflect-metadata';
import { Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import request from 'supertest';
import {
  runSearch,
  SearchBody,
  SearchRequest,
  SearchResponse,
  SearchDelegate,
  SearchTransactionClient,
} from '../src';

// Keeps the README usage example compiling and behaving as documented.

enum ArticleStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
}

class ArticleDto {
  @ApiProperty() id: number;
  @ApiProperty() title: string;
  @ApiProperty({ nullable: true, type: String }) summary: string | null;
  @ApiProperty({ enum: ArticleStatus, enumName: 'ArticleStatus' })
  status: ArticleStatus;
  @ApiProperty() publishedAt: Date;
}

class ArticleSearchRequestDto extends SearchRequest(ArticleDto, {
  name: 'Article',
  filter: ['id', 'status', 'publishedAt'],
  sort: ['publishedAt', 'title'],
  search: ['title', 'summary'],
  defaultSort: [{ field: 'publishedAt', direction: 'desc' }],
}) {}

class ArticleSearchResponseDto extends SearchResponse(ArticleDto, 'Article') {}

const calls: { findMany: object[]; count: object[] } = {
  findMany: [],
  count: [],
};
const article: SearchDelegate = {
  findMany: (args) => (calls.findMany.push(args), Promise.resolve([])),
  count: (args) => (calls.count.push(args), Promise.resolve(57)),
};
const prisma: SearchTransactionClient = {
  $transaction: (queries) => Promise.all(queries),
};

@Controller('articles')
class ArticlesController {
  @Post('search')
  @ApiOkResponse({ type: ArticleSearchResponseDto })
  searchArticles(@SearchBody() body: ArticleSearchRequestDto) {
    return runSearch(prisma, article, body, { tieBreaker: { id: 'asc' } });
  }
}

describe('README example', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ArticlesController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('translates the documented request', async () => {
    const response = await request(app.getHttpServer())
      .post('/articles/search')
      .send({
        where: {
          status: { equals: 'PUBLISHED' },
          OR: [
            { publishedAt: { gte: '2026-01-01T00:00:00Z' } },
            { id: { in: [12, 40] } },
          ],
        },
        orderBy: [{ field: 'publishedAt', direction: 'desc' }],
        q: 'prisma nestjs',
        page: 1,
        pageSize: 20,
      })
      .expect(201);

    expect(response.body).toEqual({
      items: [],
      total: 57,
      page: 1,
      pageSize: 20,
    });
    const query = calls.findMany.at(-1) as Record<string, unknown>;
    expect(query.orderBy).toEqual([{ publishedAt: 'desc' }, { id: 'asc' }]);
    expect(query.skip).toBe(0);
    expect(query.take).toBe(20);
    expect(calls.count.at(-1)).toEqual({ where: query.where });
  });

  it('rejects filters on fields not listed in filter', async () => {
    await request(app.getHttpServer())
      .post('/articles/search')
      .send({ where: { title: { equals: 'x' } } })
      .expect(400);
  });
});
