import { z } from "zod";
import { CATEGORIES, PRIORITIES } from "./types";

// Shape Claude must return. The JSON schema passed to `claude --json-schema`
// is derived from this same zod schema (see toCliJsonSchema in claude.ts).

export const triageItemSchema = z.object({
  hunkId: z.string(),
  priority: z.enum(PRIORITIES),
  category: z.enum(CATEGORIES),
  title: z.string(),
  explain: z.string(),
  why: z.string(),
  check: z.string(),
  highlight: z.array(
    z.object({
      side: z.enum(["old", "new"]),
      line: z.int(),
    }),
  ),
  lookAt: z.array(
    z.object({
      path: z.string(),
      line: z.int(),
      reason: z.string(),
    }),
  ),
});

export const triageOutputSchema = z.object({
  summary: z.string(),
  readingOrder: z.array(z.string()),
  items: z.array(triageItemSchema),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;
