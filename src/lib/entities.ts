import type { EntityIdentity, EntitySource } from "./types";
import { ValidationError } from "./errors";

interface IdentityInput {
  id?: string;
  source: EntitySource;
  persistentId?: string;
  libraryId?: string;
  catalogId?: string;
  derivedId?: string;
}

export function buildIdentity(input: IdentityInput): EntityIdentity {
  const id =
    input.id ??
    (input.persistentId ? createEntityRef(input.source, "persistent", input.persistentId) : undefined) ??
    (input.libraryId ? createEntityRef(input.source, "library", input.libraryId) : undefined) ??
    (input.catalogId ? createEntityRef(input.source, "catalog", input.catalogId) : undefined) ??
    (input.derivedId ? createEntityRef(input.source, "derived", input.derivedId) : undefined);
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

export function hasNativePersistentId(entity: EntityIdentity): entity is EntityIdentity & { persistentId: string } {
  return typeof entity.persistentId === "string" && entity.persistentId.length > 0;
}

export type EntityRefKind = "persistent" | "library" | "catalog" | "derived";

export interface EntityRef {
  source: EntitySource;
  kind: EntityRefKind;
  value: string;
}

export function createEntityRef(source: EntitySource, kind: EntityRefKind, value: string): string {
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
