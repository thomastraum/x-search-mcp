#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type UrlCitation = {
  type?: string;
  url?: string;
  start_index?: number;
  end_index?: number;
  title?: string;
};

type OutputTextContent = {
  type?: string;
  text?: string;
  annotations?: UrlCitation[];
};

type ResponseOutput = {
  type?: string;
  content?: OutputTextContent[];
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MODEL = "grok-4-1-fast";

const XSearchInputBaseSchema = z.object({
    query: z.string().min(1).max(2000).describe("Search query for X"),
    allowed_x_handles: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe("Only include posts from these handles"),
    excluded_x_handles: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe("Exclude posts from these handles"),
    from_date: z
      .string()
      .optional()
      .describe("Start date (YYYY-MM-DD)"),
    to_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
    enable_image_understanding: z
      .boolean()
      .optional()
      .describe("Enable image understanding"),
    enable_video_understanding: z
      .boolean()
      .optional()
      .describe("Enable video understanding"),
    include_raw_response: z
      .boolean()
      .optional()
      .describe("Include raw xAI response for debugging"),
  });

const XSearchInputSchema = XSearchInputBaseSchema.superRefine((data, ctx) => {
    if (data.allowed_x_handles && data.excluded_x_handles) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "allowed_x_handles and excluded_x_handles cannot both be set",
        path: ["allowed_x_handles"],
      });
    }

    if (data.from_date) {
      const error = validateDateString(data.from_date);
      if (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error,
          path: ["from_date"],
        });
      }
    }

    if (data.to_date) {
      const error = validateDateString(data.to_date);
      if (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error,
          path: ["to_date"],
        });
      }
    }

    if (data.from_date && data.to_date) {
      const from = new Date(data.from_date);
      const to = new Date(data.to_date);
      if (from > to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "from_date must be before or equal to to_date",
          path: ["from_date"],
        });
      }
    }
  });

const XSearchOutputSchema = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
  inline_citations: z.array(
    z.object({
      url: z.string(),
      start_index: z.number().nullable(),
      end_index: z.number().nullable(),
      title: z.string().nullable(),
    })
  ),
  raw_response: z.unknown().optional(),
});

const RESPONSE_SCHEMA = {
  name: "x_search_answer",
  schema: {
    type: "object",
    properties: {
      answer: { type: "string" },
      citations: { type: "array", items: { type: "string" } },
    },
    required: ["answer"],
  },
};

function validateDateString(value: string): string | null {
  if (!DATE_REGEX.test(value)) {
    return "Date must be in YYYY-MM-DD format";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }
  const iso = date.toISOString().slice(0, 10);
  if (iso !== value) {
    return "Invalid date";
  }
  return null;
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function extractMessage(output: ResponseOutput[] | undefined) {
  if (!output) return null;
  const message = output.find((item) => item?.type === "message");
  if (!message) return null;
  const content = message.content?.find((item) => item?.type === "output_text");
  if (!content) return null;
  return content;
}

function normalizeCitations(annotations: UrlCitation[] | undefined, parsedCitations?: unknown) {
  const urlCitations = (annotations || [])
    .filter((a) => a?.type === "url_citation" && a?.url)
    .map((a) => ({
      url: a.url as string,
      start_index: typeof a.start_index === "number" ? a.start_index : null,
      end_index: typeof a.end_index === "number" ? a.end_index : null,
      title: a.title ?? null,
    }));

  const urlsFromAnnotations = dedupeUrls(urlCitations.map((c) => c.url));

  const urlsFromParsed = Array.isArray(parsedCitations)
    ? parsedCitations.filter((c) => typeof c === "string" && c.startsWith("http"))
    : [];

  const citations = urlsFromAnnotations.length > 0 ? urlsFromAnnotations : urlsFromParsed;

  return {
    citations,
    inline_citations: urlCitations,
  };
}

async function fetchJson(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`xAI API error ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

const server = new McpServer({
  name: "x-search-mcp",
  version: "0.1.0",
});

type XSearchInput = z.infer<typeof XSearchInputSchema>;
type XSearchOutput = z.infer<typeof XSearchOutputSchema>;

server.registerTool(
  "x_search",
  {
    title: "X Search",
    description:
      "Search X posts using xAI's Responses API x_search tool. Returns a normalized answer and citations.",
    inputSchema: XSearchInputBaseSchema,
    outputSchema: XSearchOutputSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    try {
      const parsedArgs = XSearchInputSchema.parse(args) as XSearchInput;
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("XAI_API_KEY is required");
      }

      const baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
      const model = process.env.XAI_MODEL ?? DEFAULT_MODEL;
      const timeoutMs = Number.parseInt(process.env.XAI_TIMEOUT ?? "30000", 10);

      const toolConfig: Record<string, unknown> = {
        type: "x_search",
      };

      if (parsedArgs.allowed_x_handles) {
        toolConfig.allowed_x_handles = parsedArgs.allowed_x_handles;
      }
      if (parsedArgs.excluded_x_handles) {
        toolConfig.excluded_x_handles = parsedArgs.excluded_x_handles;
      }
      if (parsedArgs.from_date) {
        toolConfig.from_date = parsedArgs.from_date;
      }
      if (parsedArgs.to_date) {
        toolConfig.to_date = parsedArgs.to_date;
      }
      if (typeof parsedArgs.enable_image_understanding === "boolean") {
        toolConfig.enable_image_understanding = parsedArgs.enable_image_understanding;
      }
      if (typeof parsedArgs.enable_video_understanding === "boolean") {
        toolConfig.enable_video_understanding = parsedArgs.enable_video_understanding;
      }

      const body = {
        model,
        input: [
          {
            role: "system",
            content:
              "You answer questions using X search. Return JSON that matches the provided schema. Use citations when possible.",
          },
          {
            role: "user",
            content: parsedArgs.query,
          },
        ],
        tools: [toolConfig],
        text: {
          format: {
            type: "json_schema",
            name: RESPONSE_SCHEMA.name,
            schema: RESPONSE_SCHEMA.schema,
            strict: true,
          },
        },
      };

      const response = await fetchJson(
        `${baseUrl}/responses`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs
      );

      const content = extractMessage(response.output as ResponseOutput[]);
      const rawText = content?.text ?? "";

      let parsed: { answer?: string; citations?: unknown } = { answer: rawText };
      if (rawText) {
        try {
          const parsedJson = JSON.parse(rawText);
          if (parsedJson && typeof parsedJson === "object") {
            parsed = parsedJson;
          }
        } catch {
          // Keep raw text fallback
        }
      }

      const normalizedCitations = normalizeCitations(content?.annotations, parsed.citations);

      const normalizedResponse: XSearchOutput = {
        answer:
          typeof parsed.answer === "string" && parsed.answer.trim().length > 0
            ? parsed.answer
            : rawText,
        citations: normalizedCitations.citations,
        inline_citations: normalizedCitations.inline_citations,
        ...(parsedArgs.include_raw_response ? { raw_response: response } : {}),
      };

      return {
        structuredContent: normalizedResponse,
        content: [
          {
            type: "text",
            text: JSON.stringify(normalizedResponse, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("x_search failed", message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: message,
                status: "failed",
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("x-search-mcp running on stdio");
}

main().catch((error) => {
  console.error("Fatal error", error);
  process.exit(1);
});
