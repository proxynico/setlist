import { describe, expect, test } from "bun:test";
import { buildIdentity } from "../src/lib/entities";

describe("buildIdentity", () => {
  test("encodes native persistent ids explicitly", () => {
    const identity = buildIdentity({ source: "native", persistentId: "ABC123" });
    expect(identity.id).toBe("native:persistent:ABC123");
    expect(identity.persistentId).toBe("ABC123");
  });

  test("prefers library ids for API library entities", () => {
    const identity = buildIdentity({ source: "api", libraryId: "l.123", catalogId: "c.456" });
    expect(identity.id).toBe("api:library:l.123");
    expect(identity.source).toBe("api");
    expect(identity.libraryId).toBe("l.123");
    expect(identity.catalogId).toBe("c.456");
  });

  test("uses the catalog id when there is no library id", () => {
    const identity = buildIdentity({ source: "api", catalogId: "1234567" });
    expect(identity.id).toBe("api:catalog:1234567");
    expect(identity.catalogId).toBe("1234567");
    expect(identity.libraryId).toBeUndefined();
  });

  test("encodes derived ids", () => {
    const identity = buildIdentity({ source: "native", derivedId: "album:OK Computer::Radiohead" });
    expect(identity.id).toBe("native:derived:album:OK Computer::Radiohead");
    expect(identity.source).toBe("native");
  });

  test("throws when no ids are given", () => {
    expect(() => buildIdentity({ source: "api" })).toThrow("Entity identity requires at least one ID");
  });
});
