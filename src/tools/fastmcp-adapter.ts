/**
 * FastMCP Adapter
 * Converts existing tool handlers to FastMCP format
 */

import { z } from "zod";
import type { Context } from "fastmcp";

// Re-export UserError for use in handlers
export { UserError } from "fastmcp";

/**
 * Tool annotations matching MCP spec
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Content types matching MCP protocol
 */
export interface TextContent {
  type: "text";
  text: string;
  mimeType?: string;
}

export interface ContentResult {
  content: TextContent[];
  isError?: boolean;
}

/**
 * Tool definition for FastMCP
 */
export interface FastMCPToolDefinition<T extends z.ZodRawShape> {
  name: string;
  description: string;
  parameters: z.ZodObject<T>;
  annotations?: ToolAnnotations;
  execute: (args: z.infer<z.ZodObject<T>>, context: Context<any>) => Promise<ContentResult | string>;
}

/**
 * Create a FastMCP-compatible tool from a schema and handler
 *
 * @param name - Tool name
 * @param description - Tool description
 * @param schema - Zod schema shape (plain object with Zod types)
 * @param handler - Async handler function
 * @param annotations - Optional MCP annotations
 */
export function createFastMCPTool<T extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<ContentResult>,
  annotations?: ToolAnnotations
): FastMCPToolDefinition<T> {
  return {
    name,
    description,
    parameters: z.object(schema),
    annotations,
    execute: async (args, _context) => {
      return handler(args);
    },
  };
}
