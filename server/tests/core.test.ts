import { assertEquals } from "@std/assert";
import { day } from "../core/app.ts";

Deno.test("day(): ISO instants, Date strings and offsets all become one YYYY-MM-DD", () => {
  assertEquals(day("2026-09-20T10:05:00.000Z"), "2026-09-20");
  assertEquals(day("2026-09-20T23:59:59+02:00"), "2026-09-20");
  assertEquals(day("2026-09-21T01:30:00+02:00"), "2026-09-20");
  assertEquals(day(new Date(Date.UTC(2024, 1, 29)).toISOString()), "2024-02-29");
  assertEquals(day("Sat Sep 20 2026 12:00:00 GMT+0200"), "2026-09-20");
});

Deno.test("day(): unparsable, empty, null and undefined never throw", () => {
  for (const bad of ["yesterday", "", "   ", "2026-13-45", "not a date", null, undefined]) {
    assertEquals(day(bad), "unknown-date", String(bad));
  }
});
