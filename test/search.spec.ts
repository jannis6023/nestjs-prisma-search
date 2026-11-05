import 'reflect-metadata';
import {
  Controller,
  INestApplication,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  OpenAPIObject,
  PickType,
  SwaggerModule,
  DocumentBuilder,
} from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { IsInt } from 'class-validator';
import request from 'supertest';
import {
  BoolFilter,
  DateTimeFilter,
  enumFilterClass,
  FloatFilter,
  IntFilter,
  IntNullableFilter,
  runSearch,
  SearchBody,
  SearchRequest,
  SearchResponse,
  searchSpecOf,
  StringNullableFilter,
  toPrismaQuery,
} from '../src';

enum Color {
  RED = 'RED',
  BLUE = 'BLUE',
}

class ItemDto {
  @ApiProperty({ type: Number })
  @IsInt()
  id: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsInt()
  count?: number;

  @ApiProperty({ type: Number })
  price: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  title?: string;

  @ApiProperty({ type: Date })
  createdAt: Date;

  @ApiProperty({ type: Boolean })
  done: boolean;

  @ApiProperty({ enum: Color, enumName: 'Color' })
  color: Color;

  @ApiProperty({ type: String, isArray: true })
  tags: string[];
}

class PickedItemDto extends PickType(ItemDto, ['id', 'title', 'color']) {}

class ItemSearchRequestDto extends SearchRequest(ItemDto, {
  name: 'Item',
  filter: [
    'id',
    'count',
    'price',
    'title',
    'createdAt',
    'done',
    'color',
    'ownerName',
  ],
  sort: ['id', 'createdAt', 'ownerName'],
  search: ['title', 'ownerName'],
  defaultSort: [{ field: 'id', direction: 'desc' }],
  maxPageSize: 50,
  fields: {
    ownerName: {
      kind: 'string',
      nullable: true,
      path: 'owner.name',
    },
  },
}) {}

class ItemSearchResponseDto extends SearchResponse(ItemDto, 'Item') {}

class PickedSearchRequestDto extends SearchRequest(PickedItemDto, {
  name: 'Picked',
  filter: ['id', 'title', 'color'],
}) {}

@Controller('items')
class ItemsController {
  @Post('search')
  @ApiOkResponse({ type: ItemSearchResponseDto })
  search(@SearchBody() body: ItemSearchRequestDto): ItemSearchResponseDto {
    return {
      items: [toPrismaQuery(body) as unknown as ItemDto],
      total: 0,
      page: body.page,
      pageSize: body.pageSize,
    };
  }

  @Post('picked')
  picked(@SearchBody() body: PickedSearchRequestDto): object {
    return toPrismaQuery(body);
  }
}

/** The parts of an OpenAPI schema object the assertions look at. */
interface Schema {
  $ref?: string;
  allOf?: Schema[];
  type?: string;
  format?: string;
  enum?: unknown[];
  required?: string[];
  items?: Schema;
  properties: Record<string, Schema>;
}

interface SearchResponseBody {
  items: unknown[];
  page: number;
  pageSize: number;
}

function build(plain: object): ItemSearchRequestDto {
  return plainToInstance(ItemSearchRequestDto, plain);
}

describe('search schema generation', () => {
  it('derives the operator DTO from the response DTO metadata', () => {
    const fields = searchSpecOf(ItemSearchRequestDto).fields;
    expect(fields.get('id')?.filterClass).toBe(IntFilter);
    expect(fields.get('count')?.filterClass).toBe(IntNullableFilter);
    expect(fields.get('price')?.filterClass).toBe(FloatFilter);
    expect(fields.get('title')?.filterClass).toBe(StringNullableFilter);
    expect(fields.get('createdAt')?.filterClass).toBe(DateTimeFilter);
    expect(fields.get('done')?.filterClass).toBe(BoolFilter);
    expect(fields.get('color')?.filterClass.name).toBe('ColorFilter');
    expect(fields.get('ownerName')?.path).toEqual(['owner', 'name']);
  });

  it('reads metadata through mapped types', () => {
    const fields = searchSpecOf(PickedSearchRequestDto).fields;
    expect(fields.get('id')?.filterClass).toBe(IntFilter);
    expect(fields.get('title')?.filterClass).toBe(StringNullableFilter);
  });

  it('creates one filter class per enum name', () => {
    expect(
      searchSpecOf(PickedSearchRequestDto).fields.get('color')?.filterClass,
    ).toBe(searchSpecOf(ItemSearchRequestDto).fields.get('color')?.filterClass);
    expect(() =>
      enumFilterClass({ enum: ['RED', 'GREEN'], enumName: 'Color' }, false),
    ).toThrow(/different values/);
  });

  it('fails at startup for fields it cannot type', () => {
    expect(() =>
      SearchRequest(ItemDto, { name: 'Bad1', filter: ['missing' as never] }),
    ).toThrow(/missing.*not declared/);
    expect(() =>
      SearchRequest(ItemDto, { name: 'Bad2', filter: ['tags'] }),
    ).toThrow(/array/);
    expect(() =>
      SearchRequest(ItemDto, { name: 'Bad3', search: ['id'] }),
    ).toThrow(/text field/);
    expect(() =>
      SearchRequest(ItemDto, {
        name: 'Bad4',
        sort: ['id'],
        defaultSort: [{ field: 'price', direction: 'asc' }],
      }),
    ).toThrow(/not sortable/);
  });
});

describe('search HTTP contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ItemsController],
    }).compile();
    app = moduleRef.createNestApplication();
    // Same global pipe as main.ts: it must not strip search bodies first.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidUnknownValues: true,
        transform: true,
      }),
    );
    await app.init();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const post = (body: object) =>
    request(server()).post('/items/search').send(body);

  it('emits named, recursive schemas', () => {
    const schemas = document.components?.schemas as unknown as Record<
      string,
      Schema
    >;
    const where = schemas.ItemWhere;
    expect(where.properties.id.$ref).toBe('#/components/schemas/IntFilter');
    expect(where.properties.count.$ref).toBe(
      '#/components/schemas/IntNullableFilter',
    );
    expect(where.properties.color.$ref).toBe(
      '#/components/schemas/ColorFilter',
    );
    expect(where.properties.AND).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/ItemWhere' },
    });
    expect(where.properties.NOT.$ref).toBe('#/components/schemas/ItemWhere');
    expect(where.required ?? []).toEqual([]);

    // Enum references come out as a single-entry allOf (standard @nestjs/swagger output).
    const refOf = (property: Schema) =>
      property.$ref ?? property.allOf?.[0]?.$ref;
    expect(refOf(schemas.ItemOrderBy.properties.field)).toBe(
      '#/components/schemas/ItemSortField',
    );
    expect(schemas.ItemSortField.enum).toEqual([
      'id',
      'createdAt',
      'ownerName',
    ]);
    expect(refOf(schemas.ColorFilter.properties.equals)).toBe(
      '#/components/schemas/Color',
    );
    expect(schemas.ColorFilter.properties.in).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/Color' },
    });
    expect(schemas.IntFilter.properties.equals.type).toBe('integer');
    expect(schemas.IntNullableFilter.properties.isNull.type).toBe('boolean');
    expect(schemas.IntFilter.properties.isNull).toBeUndefined();
    expect(schemas.DateTimeFilter.properties.gte).toMatchObject({
      type: 'string',
      format: 'date-time',
    });

    const body = schemas.ItemSearchRequestDto;
    expect(body.properties.where.$ref).toBe('#/components/schemas/ItemWhere');
    expect(body.properties.pageSize).toMatchObject({
      maximum: 50,
      default: 20,
    });
    expect(body.properties.q.type).toBe('string');
    expect(body.properties).not.toHaveProperty('filter');

    const requestBody = document.paths['/items/search'].post?.requestBody as {
      content: Record<string, { schema: Schema }>;
    };
    expect(requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ItemSearchRequestDto',
    );
    expect(schemas.ItemSearchResponseDto.properties.items.items?.$ref).toBe(
      '#/components/schemas/ItemDto',
    );
  });

  it('accepts a valid body and translates it', async () => {
    const response = await post({
      where: {
        id: { in: [1, 2] },
        createdAt: { gte: '2026-01-01T00:00:00.000Z' },
        OR: [{ title: { contains: 'a' } }, { title: { isNull: true } }],
        NOT: { color: { equals: 'RED' } },
      },
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
      page: 2,
      pageSize: 10,
    }).expect(201);

    expect((response.body as SearchResponseBody).items[0]).toEqual({
      where: {
        AND: [
          { id: { in: [1, 2] } },
          { createdAt: { gte: '2026-01-01T00:00:00.000Z' } },
          {
            OR: [{ title: { contains: 'a' } }, { title: { equals: null } }],
          },
          { NOT: { color: { equals: 'RED' } } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      skip: 10,
      take: 10,
    });
  });

  it('applies defaults to an empty body', async () => {
    const response = await post({}).expect(201);
    const body = response.body as SearchResponseBody;
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.items[0]).toEqual({
      where: {},
      orderBy: [{ id: 'desc' }],
      skip: 0,
      take: 20,
    });
  });

  it.each([
    ['an unknown field', { where: { nope: { equals: 1 } } }],
    ['an unknown top-level property', { filter: [] }],
    ['an operator of another type', { where: { id: { contains: '1' } } }],
    ['a wrongly typed value', { where: { id: { equals: '1' } } }],
    ['a fractional integer', { where: { id: { equals: 1.5 } } }],
    ['isNull on a non-nullable field', { where: { id: { isNull: true } } }],
    ['an invalid date', { where: { createdAt: { gte: 'yesterday' } } }],
    ['an unknown enum value', { where: { color: { equals: 'GREEN' } } }],
    ['a nested unknown field', { where: { AND: [{ nope: { equals: 1 } }] } }],
    ['a nested unknown operator', { where: { NOT: { title: { like: 'x' } } } }],
    ['a scalar instead of operators', { where: { id: 5 } }],
    [
      'an unsortable field',
      { orderBy: [{ field: 'price', direction: 'asc' }] },
    ],
    ['a bad direction', { orderBy: [{ field: 'id', direction: 'up' }] }],
    ['a page size above the maximum', { pageSize: 51 }],
    ['page 0', { page: 0 }],
    ['the old pagination shape', { itemsPerPage: 20, sortBy: [] }],
  ])('rejects %s with 400', async (_label, body) => {
    await post(body).expect(400);
  });

  it('validates bodies of DTOs built from mapped types', async () => {
    await request(server())
      .post('/items/picked')
      .send({ where: { color: { in: ['BLUE'] } } })
      .expect(201);
    await request(server())
      .post('/items/picked')
      .send({ where: { price: { equals: 1 } } })
      .expect(400);
  });
});

describe('search Prisma translation', () => {
  it('nests AND/OR/NOT and keeps sibling fields ANDed', () => {
    const query = toPrismaQuery(
      build({
        where: {
          done: { equals: false },
          AND: [{ id: { gt: 1 } }, { id: { lt: 9 } }],
          OR: [{ color: { equals: 'RED' } }, { NOT: { count: { gte: 3 } } }],
        },
      }),
    );
    expect(query.where).toEqual({
      AND: [
        { done: { equals: false } },
        { AND: [{ id: { gt: 1 } }, { id: { lt: 9 } }] },
        {
          OR: [{ color: { equals: 'RED' } }, { NOT: { count: { gte: 3 } } }],
        },
      ],
    });
  });

  it('builds an orderBy array in request order, mapping paths', () => {
    const query = toPrismaQuery(
      build({
        orderBy: [
          { field: 'ownerName', direction: 'asc' },
          { field: 'id', direction: 'desc' },
        ],
      }),
      { tieBreaker: { id: 'asc', createdAt: 'asc' } },
    );
    expect(query.orderBy).toEqual([
      { owner: { name: 'asc' } },
      { id: 'desc' },
      { createdAt: 'asc' },
    ]);
  });

  it('rejects a sort key listed twice', () => {
    expect(() =>
      toPrismaQuery(
        build({
          orderBy: [
            { field: 'id', direction: 'asc' },
            { field: 'id', direction: 'desc' },
          ],
        }),
      ),
    ).toThrow(/twice/);
  });

  it('translates isNull and combines it with other operators', () => {
    const query = toPrismaQuery(
      build({
        where: {
          ownerName: { isNull: false, startsWith: 'M' },
          count: { isNull: true },
        },
      }),
    );
    expect(query.where).toEqual({
      AND: [
        { owner: { name: { startsWith: 'M' } } },
        { owner: { name: { not: null } } },
        { count: { equals: null } },
      ],
    });
  });

  it('converts ISO strings to dates', () => {
    const query = toPrismaQuery(
      build({ where: { createdAt: { lt: '2026-02-01' } } }),
    );
    const condition = query.where.createdAt as { lt: unknown };
    expect(condition.lt).toBeInstanceOf(Date);
    expect((condition.lt as Date).toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('splits q into words that must each match a search field', () => {
    const query = toPrismaQuery(build({ q: '  Smith  Jones ' }), {
      caseInsensitive: true,
    });
    const word = (value: string) => ({
      OR: [
        { title: { contains: value, mode: 'insensitive' } },
        { owner: { name: { contains: value, mode: 'insensitive' } } },
      ],
    });
    expect(query.where).toEqual({ AND: [word('Smith'), word('Jones')] });
  });

  it('keeps equality operators out of the case-insensitive mode', () => {
    const query = toPrismaQuery(
      build({ where: { title: { not: 'x', contains: 'y' } } }),
      { caseInsensitive: true },
    );
    expect(query.where).toEqual({
      AND: [
        { title: { not: 'x' } },
        { title: { contains: 'y', mode: 'insensitive' } },
      ],
    });
  });

  it('ANDs the server condition first', () => {
    const query = toPrismaQuery(build({ where: { id: { equals: 1 } } }), {
      where: { deleted: false },
    });
    expect(query.where).toEqual({
      AND: [{ deleted: false }, { id: { equals: 1 } }],
    });
  });

  it('leaves handled fields to the caller at the top level only', () => {
    const top = toPrismaQuery(
      build({
        where: { createdAt: { gte: '2026-01-01' }, done: { equals: true } },
      }),
      { handledFields: ['createdAt'] },
    );
    expect(top.where).toEqual({ done: { equals: true } });
    expect(() =>
      toPrismaQuery(
        build({ where: { OR: [{ createdAt: { gte: '2026-01-01' } }] } }),
        { handledFields: ['createdAt'] },
      ),
    ).toThrow(/top level/);
  });

  it('limits the nesting depth', () => {
    let where: object = { id: { equals: 1 } };
    for (let i = 0; i < 8; i++) where = { NOT: where };
    expect(() => toPrismaQuery(build({ where }))).toThrow(/deeper/);
  });

  it('rejects plain objects that did not pass through the request class', () => {
    expect(() => toPrismaQuery({ page: 1, pageSize: 1 })).toThrow(
      /not an instance/,
    );
  });

  it('runs findMany and count with the same where in one transaction', async () => {
    const findMany = jest.fn((args: object) => ({ op: 'findMany', args }));
    const count = jest.fn((args: object) => ({ op: 'count', args }));
    const $transaction = jest.fn((ops: unknown[]) => {
      expect(ops).toHaveLength(2);
      return Promise.resolve([[{ id: 1 }], 7]);
    });

    const result = await runSearch(
      { $transaction },
      { findMany, count },
      build({
        where: { OR: [{ id: { equals: 1 } }, { title: { contains: 'x' } }] },
        page: 3,
        pageSize: 5,
      }),
      { select: { id: true }, where: { deleted: false } },
    );

    expect(result).toEqual({
      items: [{ id: 1 }],
      total: 7,
      page: 3,
      pageSize: 5,
    });
    const findArgs = findMany.mock.calls[0][0] as Record<string, unknown>;
    const countArgs = count.mock.calls[0][0] as Record<string, unknown>;
    expect(countArgs).toEqual({ where: findArgs.where });
    expect(findArgs).toMatchObject({
      skip: 10,
      take: 5,
      select: { id: true },
      orderBy: [{ id: 'desc' }],
      where: {
        AND: [
          { deleted: false },
          { OR: [{ id: { equals: 1 } }, { title: { contains: 'x' } }] },
        ],
      },
    });
  });
});
