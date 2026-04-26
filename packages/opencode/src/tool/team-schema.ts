import { Schema } from "effect"

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export const SafeName = Schema.String.check(
  Schema.isPattern(SAFE_NAME, {
    description: "Lowercase alphanumeric with hyphens, 1-64 chars",
  }),
)

export const Bounded = (min: number, max: number) =>
  Schema.Number.check(Schema.isBetween({ minimum: min, maximum: max }))

export const AtLeast = (min: number) =>
  Schema.Number.check(Schema.isGreaterThanOrEqualTo(min))

export const MaxLen = (max: number) => Schema.String.check(Schema.isMaxLength(max))
