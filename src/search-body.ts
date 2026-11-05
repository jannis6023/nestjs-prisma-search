import {
  createParamDecorator,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { SEARCH_SPEC } from './search-request';

/**
 * Strict validation for search bodies: unknown fields or operators are a 400
 * instead of being stripped, because a stripped condition silently widens the
 * result set.
 */
export const searchValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  transform: true,
  validateCustomDecorators: true,
});

/**
 * Reads the raw request body. A custom decorator is skipped by a global
 * ValidationPipe (unless it sets validateCustomDecorators), so the global
 * `whitelist` pass cannot strip unknown fields before `searchValidationPipe`
 * gets to reject them.
 */
const RawBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext): unknown =>
    context.switchToHttp().getRequest<{ body?: unknown }>().body,
);

/**
 * `@SearchBody() body: XSearchRequestDto` — validates the body strictly
 * against a SearchRequest class and documents it as the request body.
 */
export function SearchBody(): ParameterDecorator {
  return (target, propertyKey, index) => {
    if (propertyKey === undefined) {
      throw new Error('@SearchBody() can only be used on method parameters.');
    }
    const types = Reflect.getMetadata(
      'design:paramtypes',
      target,
      propertyKey,
    ) as unknown[] | undefined;
    const type = types?.[index] as
      | ((new () => object) & { [SEARCH_SPEC]?: unknown })
      | undefined;
    if (!type?.[SEARCH_SPEC]) {
      throw new Error(
        `@SearchBody() on ${target.constructor.name}.${String(propertyKey)} needs a parameter typed with a SearchRequest class.`,
      );
    }

    RawBody(searchValidationPipe)(target, propertyKey, index);
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
    if (descriptor) ApiBody({ type })(target, propertyKey, descriptor);
  };
}
