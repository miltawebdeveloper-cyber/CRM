import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { allTimezoneCodes } from '../timezone.js';

/**
 * Validates against the LIVE admin-managed timezone list (`allTimezoneCodes()`
 * in `common/timezone.ts`), not a compile-time enum — replaces `@IsEnum(Timezone)`
 * now that a zone code is data, not a fixed type. `allowValues` lets a field also
 * accept a sentinel outside the real code list (e.g. `UNSET_TIMEZONE_LABEL` on a
 * filter DTO).
 */
export function IsTimezoneCode(options?: { allowValues?: string[] } & ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isTimezoneCode',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          return allTimezoneCodes().includes(value) || (options?.allowValues?.includes(value) ?? false);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a known time zone code`;
        },
      },
    });
  };
}
