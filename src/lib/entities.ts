import type { EntityIdentity, EntitySource } from "./types";
import { UnsupportedOperationError, ValidationError } from "./errors";

interface IdentityInput {
  source: EntitySource;
  persistentId?: string;
  libraryId?: string;
  catalogId?: string;
  derivedId?: string;
}

export function buildIdentity(input: IdentityInput): EntityIdentity {
  const id =
    (input.persistentId && createEntityRef(input.source, "persistent", input.persistentId)) ||
    (input.libraryId && createEntityRef(input.source, "library", input.libraryId)) ||
    (input.catalogId && createEntityRef(input.source, "catalog", input.catalogId)) ||
    (input.derivedId && createEntityRef(input.source, "derived", input.derivedId));
  if (!id) {
    throw new Error("Entity identity requires at least one ID");
  }

  return {
    id,
    source: input.source,
    persistentId: input.persistentId,
    libraryId: input.libraryId,
    catalogId: input.catalogId,
  };
}

export type EntityRefKind = "persistent" | "library" | "catalog" | "derived";

export interface EntityRef {
  source: EntitySource;
  kind: EntityRefKind;
  value: string;
}

function createEntityRef(source: EntitySource, kind: EntityRefKind, value: string): string {
  return `${source}:${kind}:${value}`;
}

export function parseEntityRef(id: string): EntityRef | null {
  const match = id.match(/^(native|api):(persistent|library|catalog|derived):(.+)$/);
  if (!match) return null;
  return {
    source: match[1] as EntitySource,
    kind: match[2] as EntityRefKind,
    value: match[3],
  };
}

/**
 * Validate that a raw ID is safe for embedding in JXA scripts.
 * Music.app persistent IDs are hex strings. API IDs are alphanumeric with dots/hyphens.
 * Rejects anything with characters that could be used for injection.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateRawId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new ValidationError(
      `${label} "${id}" contains invalid characters.`,
      "IDs must be alphanumeric (with dots, hyphens, or underscores). Get valid IDs with: setlist ... --json",
    );
  }
  return id;
}

interface ExpectedRef {
  source: EntitySource;
  kind: EntityRefKind;
  label: string; // "Track", "Playlist"
  description: string; // "a native persistent ID"
  hint: string;
}

/** Accept a raw ID or a source-qualified ref of the expected kind, and return the safe raw value. */
export function resolveRawId(id: string, expected: ExpectedRef): string {
  const ref = parseEntityRef(id);
  if (ref && (ref.source !== expected.source || ref.kind !== expected.kind)) {
    throw new UnsupportedOperationError(`${expected.label} ${id} is not ${expected.description}`, expected.hint);
  }
  return validateRawId(ref?.value ?? id, expected.label);
}
