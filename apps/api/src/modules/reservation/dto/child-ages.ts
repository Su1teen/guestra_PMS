import { applyDecorators, BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Optional age of each child on arrival (0–17); priced by the property's child age bands. */
export function ChildAgesProperty() {
  return applyDecorators(
    ApiPropertyOptional({ type: [Number], example: [4, 9], description: 'Age of each child on arrival; sets the child count' }),
    IsOptional(), IsArray(), ArrayMaxSize(20), IsInt({ each: true }), Min(0, { each: true }), Max(17, { each: true }),
  );
}

/** Head counts with ages: ages win over a separately sent child count, which must then agree. */
export function resolveParty(input: { adults?: number; children?: number; childAges?: number[] | null }) {
  const adults = input.adults ?? 1;
  const ages = input.childAges?.length ? [...input.childAges] : null;
  if (ages && input.children != null && input.children !== ages.length) {
    throw new BadRequestException('children must match the number of child ages');
  }
  return { adults, children: ages?.length ?? input.children ?? 0, childAges: ages };
}
