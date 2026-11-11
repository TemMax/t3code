import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CLIENT_PROFILE_MAX_KEY_LENGTH = 128;
export const CLIENT_PROFILE_MAX_VALUE_BYTES = 262_144;
export const CLIENT_PROFILE_MAX_DOCUMENT_BYTES = 1_048_576;

/** Per key the newer (changedAt, by) pair wins; `by` compares with plain `>`. */
export const ClientProfileEntry = Schema.Struct({
  value: Schema.Unknown,
  changedAt: NonNegativeInt,
  by: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type ClientProfileEntry = typeof ClientProfileEntry.Type;

export const ClientProfileEntries = Schema.Record(Schema.String, ClientProfileEntry);
export type ClientProfileEntries = typeof ClientProfileEntries.Type;

export const ClientProfileUpdateInput = Schema.Struct({ entries: ClientProfileEntries });
export type ClientProfileUpdateInput = typeof ClientProfileUpdateInput.Type;

export class ClientProfileError extends Schema.TaggedError<ClientProfileError>()(
  "ClientProfileError",
  {
    reason: Schema.Literals(["key-too-long", "value-too-large", "document-too-large", "storage"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Client profile update failed (${this.reason}): ${this.detail}`;
  }
}
